//go:build !windows

package cli

// The dashboard submits an exact local service identity. The updater runs as
// a separate supervisor job, never as a child of the service it restarts.
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type dashboardUpdateRequest struct {
	Home        string `json:"home"`
	DBPath      string `json:"db_path"`
	Port        int    `json:"port"`
	ServerPID   int    `json:"server_pid"`
	Method      string `json:"method"`
	Target      string `json:"target_version"`
	AgentPolicy string `json:"agent_policy"`
}

type dashboardUpdateJob struct {
	ID            string                 `json:"id"`
	State         string                 `json:"state"`
	Message       string                 `json:"message"`
	Target        string                 `json:"target_version"`
	Previous      string                 `json:"previous_version"`
	UpdatedAt     time.Time              `json:"updated_at"`
	WorkerPID     int                    `json:"worker_pid,omitempty"`
	Backup        string                 `json:"backup,omitempty"`
	SchemaChanged bool                   `json:"schema_changed,omitempty"`
	RollbackSafe  bool                   `json:"rollback_safe"`
	Request       dashboardUpdateRequest `json:"request"`
	mu            sync.Mutex
}

type dashboardUpdateView struct {
	Supported bool                `json:"supported"`
	Reason    string              `json:"reason,omitempty"`
	Job       *dashboardUpdateJob `json:"job,omitempty"`
}

func updateJobPath() string { return filepath.Join(aptevaDir(), "platform-update.json") }
func updateJobTerminal(state string) bool {
	switch state {
	case "succeeded", "failed", "rolled_back", "recovery_required":
		return true
	}
	return false
}

func (j *dashboardUpdateJob) saveLocked() error {
	j.UpdatedAt = time.Now().UTC()
	raw, err := json.Marshal(j)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(aptevaDir(), ".update-job-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(raw); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), updateJobPath())
}
func (j *dashboardUpdateJob) phase(state, message string) error {
	if j == nil {
		return nil
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	j.State, j.Message = state, message
	if err := j.saveLocked(); err != nil {
		fmt.Fprintf(os.Stderr, "update progress: %v\n", err)
		return err
	}
	return nil
}
func readUpdateJob() (*dashboardUpdateJob, error) {
	raw, err := os.ReadFile(updateJobPath())
	if err != nil {
		return nil, err
	}
	var job dashboardUpdateJob
	if err := json.Unmarshal(raw, &job); err != nil {
		return nil, err
	}
	return &job, nil
}
func acquireUpdateLock() (*os.File, error) {
	if err := os.MkdirAll(aptevaDir(), 0700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(aptevaDir(), "update.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("another update is already running")
	}
	return f, nil
}

func updateScope(method string) (serviceScope, error) {
	switch method {
	case "systemd-user", "launchd-user":
		return scopeUser, nil
	case "systemd-system", "launchd-system":
		if os.Geteuid() != 0 {
			return scopeAuto, fmt.Errorf("the system service requires an updater running as root")
		}
		return scopeSystem, nil
	}
	return scopeAuto, fmt.Errorf("one-click updates require an Apteva systemd or launchd service")
}

func updateCommand(name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("%s: %w: %s", name, err, strings.TrimSpace(string(out)))
	}
	return out, nil
}

func validateUpdateService(r dashboardUpdateRequest) error {
	if !filepath.IsAbs(r.Home) || filepath.Clean(r.Home) != filepath.Clean(aptevaDir()) || !filepath.IsAbs(r.DBPath) || r.Port < 1 || r.Port > 65535 || r.ServerPID < 1 {
		return fmt.Errorf("invalid installation identity")
	}
	if r.AgentPolicy != "restart" && r.AgentPolicy != "rolling" && r.AgentPolicy != "preserve" {
		return fmt.Errorf("invalid agent policy")
	}
	if detectInstallMethod() != installVersioned {
		return fmt.Errorf("this installation must use Apteva's versioned release layout")
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	self, err = filepath.EvalSymlinks(self)
	if err != nil {
		return err
	}
	activeCLI, err := filepath.EvalSymlinks(resolveBin("apteva"))
	if err != nil || self != activeCLI {
		return fmt.Errorf("the updater does not belong to the active installation")
	}
	scope, err := updateScope(r.Method)
	if err != nil {
		return err
	}
	wantExecutable := resolveBin("apteva-server")
	if runtime.GOOS == "linux" && strings.HasPrefix(r.Method, "systemd-") {
		if _, err := exec.LookPath("systemd-run"); err != nil {
			return fmt.Errorf("systemd-run is required")
		}
		args := []string{}
		if scope == scopeUser {
			args = append(args, "--user")
		}
		out, err := updateCommand("systemctl", append(args, "show", "apteva.service", "--property=MainPID", "--property=ExecStart")...)
		if err != nil {
			return err
		}
		if !strings.Contains(string(out), "MainPID="+strconv.Itoa(r.ServerPID)+"\n") || !strings.Contains(string(out), "path="+wantExecutable+" ;") {
			return fmt.Errorf("the running server does not match apteva.service or its versioned executable")
		}
	} else if runtime.GOOS == "darwin" && strings.HasPrefix(r.Method, "launchd-") {
		domain, _, err := launchdDomainTarget(scope)
		if err != nil {
			return err
		}
		out, err := updateCommand("launchctl", "print", domain+"/"+launchdLabel)
		if err != nil {
			return err
		}
		pid := regexp.MustCompile(`(?m)^\s*pid = ([0-9]+)\s*$`).FindStringSubmatch(string(out))
		program := regexp.MustCompile(`(?m)^\s*program = (.+)\s*$`).FindStringSubmatch(string(out))
		if len(pid) != 2 || pid[1] != strconv.Itoa(r.ServerPID) || len(program) != 2 || strings.TrimSpace(program[1]) != wantExecutable {
			return fmt.Errorf("the running server does not match the Apteva launchd service")
		}
	} else {
		return fmt.Errorf("unsupported service manager")
	}
	probe, err := os.CreateTemp(filepath.Dir(currentLink()), ".update-write-check-*")
	if err != nil {
		return fmt.Errorf("installation is not writable: %w", err)
	}
	probe.Close()
	os.Remove(probe.Name())
	return nil
}

func cmdDashboardUpdate(args []string) int {
	if len(args) == 2 && args[0] == "--dashboard-worker" {
		return runDashboardUpdateWorker(args[1])
	}
	if len(args) != 1 || (args[0] != "--dashboard-probe" && args[0] != "--dashboard-start") {
		return 2
	}
	var req dashboardUpdateRequest
	if err := json.NewDecoder(io.LimitReader(os.Stdin, 8192)).Decode(&req); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	view := dashboardUpdateView{}
	if err := validateUpdateService(req); err != nil {
		view.Reason = err.Error()
	} else {
		view.Supported = true
	}
	job, err := readUpdateJob()
	if err == nil {
		view.Job = job
		if !updateJobTerminal(job.State) && time.Since(job.UpdatedAt) > 2*time.Minute {
			view.Supported = false
			view.Reason = "The previous updater stopped reporting progress. Inspect the update log before retrying."
		}
		if job.State == "recovery_required" {
			view.Supported = false
			view.Reason = job.Message
		}
	} else if !os.IsNotExist(err) {
		view.Supported = false
		view.Reason = "Cannot read the previous update job: " + err.Error()
	}
	if args[0] == "--dashboard-probe" {
		_ = json.NewEncoder(os.Stdout).Encode(view)
		return 0
	}
	if !view.Supported {
		fmt.Fprintln(os.Stderr, view.Reason)
		return 1
	}
	lock, err := acquireUpdateLock()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer lock.Close()
	// Re-read under the lock to make concurrent submissions idempotent.
	if job, err := readUpdateJob(); err == nil && !updateJobTerminal(job.State) {
		view.Job = job
		_ = json.NewEncoder(os.Stdout).Encode(view)
		return 0
	}
	if job, err := readUpdateJob(); err == nil && job.State == "recovery_required" {
		fmt.Fprintln(os.Stderr, job.Message)
		return 1
	} else if err != nil && !os.IsNotExist(err) {
		fmt.Fprintln(os.Stderr, "cannot read existing update job:", err)
		return 1
	}
	if !regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$`).MatchString(req.Target) || !semverGreater(req.Target, Version) {
		fmt.Fprintln(os.Stderr, "target must be a newer published release")
		return 1
	}
	job = &dashboardUpdateJob{ID: strconv.FormatInt(time.Now().UnixNano(), 36), State: "queued", Message: "Preparing update", Target: req.Target, Previous: activeVersion(), Request: req}
	if err := job.saveLocked(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	// Release before the supervisor starts the worker, which takes the same lock.
	lock.Close()
	if err := launchUpdateWorker(job); err != nil {
		job.phase("failed", err.Error())
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	view.Job = job
	_ = json.NewEncoder(os.Stdout).Encode(view)
	return 0
}

func launchUpdateWorker(j *dashboardUpdateJob) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	self, err = filepath.EvalSymlinks(self)
	if err != nil {
		return err
	}
	scope, err := updateScope(j.Request.Method)
	if err != nil {
		return err
	}
	if runtime.GOOS == "linux" {
		args := []string{}
		if scope == scopeUser {
			args = append(args, "--user")
		}
		args = append(args, "--collect", "--unit=apteva-update-"+j.ID, "--property=Type=exec", "--", "/usr/bin/env", "APTEVA_HOME="+aptevaDir(), self, "update", "--dashboard-worker", j.ID)
		_, err = updateCommand("systemd-run", args...)
	} else {
		// A submitted one-shot job is independent of the Apteva service job.
		_, err = updateCommand("launchctl", "submit", "-l", "ai.apteva.update."+j.ID, "--", "/usr/bin/env", "APTEVA_HOME="+aptevaDir(), self, "update", "--dashboard-worker", j.ID)
	}
	return err
}

func runDashboardUpdateWorker(id string) int {
	lock, err := acquireUpdateLock()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer lock.Close()
	j, err := readUpdateJob()
	if err != nil || j.ID != id || j.State != "queued" {
		return 1
	}
	logFile, err := os.OpenFile(filepath.Join(aptevaDir(), "platform-update.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		j.phase("failed", err.Error())
		return 1
	}
	defer logFile.Close()
	os.Stderr = logFile
	j.WorkerPID = os.Getpid()
	if err := j.phase("preparing", "Checking this installation"); err != nil {
		return 1
	}
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				j.mu.Lock()
				_ = j.saveLocked()
				j.mu.Unlock()
			}
		}
	}()
	if err := validateUpdateService(j.Request); err != nil {
		j.phase("failed", err.Error())
		return 1
	}
	// Preserve the exact server configuration; never infer port/home from defaults.
	os.Setenv("DB_PATH", j.Request.DBPath)
	os.Setenv("PORT", strconv.Itoa(j.Request.Port))
	code := runUpdate([]string{"--yes", "--agents=" + j.Request.AgentPolicy}, j)
	if code != 0 {
		j.mu.Lock()
		terminal := updateJobTerminal(j.State)
		j.mu.Unlock()
		if !terminal {
			j.phase("failed", "Update failed before activation. The current version is unchanged; see platform-update.log.")
		}
	} else {
		j.phase("succeeded", "Update installed and the new version is healthy")
	}
	return code
}

func waitForUpdateVersion(port int, version string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	client := &http.Client{Timeout: 2 * time.Second}
	for {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/health", port), nil)
		resp, err := client.Do(req)
		if err == nil {
			var health struct {
				OK      bool   `json:"ok"`
				Version string `json:"cli"`
			}
			err = json.NewDecoder(io.LimitReader(resp.Body, 16384)).Decode(&health)
			resp.Body.Close()
			if err == nil && resp.StatusCode == 200 && health.OK && health.Version == version {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("expected version %s did not become healthy: %w", version, ctx.Err())
		case <-time.After(time.Second):
		}
	}
}

func (j *dashboardUpdateJob) recoverActivation(scope serviceScope, cause error) error {
	return j.recoverActivationWith(scope, cause, pointSymlinks, restartServiceForRollback, waitForUpdateVersion)
}

func (j *dashboardUpdateJob) recoverActivationWith(scope serviceScope, cause error, flip func(string) error, restart func(serviceScope) error, wait func(int, string, time.Duration) error) error {
	if j.SchemaChanged || !j.RollbackSafe {
		// Never boot an older binary against a migrated database or silently
		// discard writes by restoring a snapshot behind the operator's back.
		j.phase("recovery_required", "The new version failed and database compatibility with the previous version is not confirmed. Database backup: "+j.Backup+". Manual recovery is required; see platform-update.log.")
		return cause
	}
	j.phase("rolling_back", "Activation failed; restoring the previous version")
	if err := flip(j.Previous); err != nil {
		j.phase("recovery_required", "Could not restore the previous version: "+err.Error())
		return errors.Join(cause, err)
	}
	if err := restart(scope); err != nil {
		j.phase("recovery_required", "Could not restart the previous version: "+err.Error())
		return errors.Join(cause, err)
	}
	if err := wait(j.Request.Port, j.Previous, 60*time.Second); err != nil {
		j.phase("recovery_required", err.Error())
		return errors.Join(cause, err)
	}
	j.phase("rolled_back", "The update failed. The previous version is running again; see platform-update.log.")
	return cause
}
