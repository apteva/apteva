//go:build !windows

package cli

// The database check every update runs before activation, whoever starts it
// (this CLI, the dashboard, or Fleet). The new release's server checks its
// migrations against a reduced copy of the live database and backs the
// database up only when the previous release could not run on the result.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	osexec "os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"
)

// updateCheckStall stops a check that stops reporting progress; the server
// writes progress at least every few seconds while it works.
var updateCheckStall = 2 * time.Minute

const (
	// updateCheckCeiling is a last resort for a check that keeps reporting
	// without finishing.
	updateCheckCeiling = 2 * time.Hour
	updateCapability   = "update_check"
)

// runningCheckPID is the database check this process is waiting on, if any.
var runningCheckPID atomic.Int64

func updateDBPath() string {
	if db := os.Getenv("DB_PATH"); db != "" {
		if abs, err := filepath.Abs(db); err == nil {
			return abs
		}
		return db
	}
	return filepath.Join(aptevaDir(), "apteva.db")
}

func updatePort() int {
	if p, err := strconv.Atoi(os.Getenv("PORT")); err == nil && p > 0 {
		return p
	}
	if p := loadAptevaConfig().ServerPort; p > 0 {
		return p
	}
	return defaultServerPort
}

// candidateCapabilities asks a release's server what it supports, with
// disposable paths so nothing touches this installation.
func candidateCapabilities(serverBin string) []string {
	dir, err := os.MkdirTemp("", "apteva-update-probe-")
	if err != nil {
		return nil
	}
	defer os.RemoveAll(dir)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := osexec.CommandContext(ctx, serverBin, "--host-protocol")
	cmd.Env = append(os.Environ(), "APTEVA_HOME="+dir, "DATA_DIR="+dir, "DB_PATH="+filepath.Join(dir, "probe.db"), "PORT=0",
		"APTEVA_BIND=127.0.0.1", "APTEVA_CLONE_QUARANTINE=1", "APTEVA_HOST_SOCKET=", "APTEVA_HOST_SLOT_SOCKET=", "APTEVA_HOST_CONTROL_TOKEN=",
		"APTEVA_INGRESS_ENABLED=", "APTEVA_HTTP_LISTEN_ADDR=", "APTEVA_HTTPS_LISTEN_ADDR=", "APTEVA_TLS_LISTEN_ADDR=")
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	var response struct {
		Capabilities []string `json:"capabilities"`
	}
	if json.Unmarshal(out, &response) != nil {
		return nil
	}
	return response.Capabilities
}

func hasCapability(capabilities []string, want string) bool {
	for _, c := range capabilities {
		if c == want {
			return true
		}
	}
	return false
}

type releaseCheckOptions struct {
	target  string // version directory of the release
	version string
	job     *dashboardUpdateJob // nil for a dry run
	full    bool                // copy every table in full
}

// runReleaseCheck runs the release's preflight with the database check and
// returns its summary. Without a job (a dry run) nothing is backed up. A
// release whose server predates the check gets the preflight it supports.
func runReleaseCheck(o releaseCheckOptions) (*updateCheckSummary, error) {
	server := filepath.Join(o.target, "apteva-server")
	env := append(os.Environ(), "APTEVA_HOME="+aptevaDir(), "DB_PATH="+updateDBPath())
	if !hasCapability(candidateCapabilities(server), updateCapability) {
		return runLegacyPreflight(server, env, o)
	}
	root := filepath.Join(aptevaDir(), "update-check")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	sweepUpdateChecks(root)
	id := "dry-run-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	if o.job != nil {
		id = o.job.ID
	}
	dir := filepath.Join(root, id)
	_ = os.RemoveAll(dir)
	if err := os.Mkdir(dir, 0o700); err != nil {
		return nil, err
	}
	defer os.RemoveAll(dir)
	env = append(env, "APTEVA_UPDATE_CHECK_DIR="+dir, "APTEVA_UPDATE_PREFLIGHT=")
	backupDir := ""
	if o.job != nil {
		backupDir = filepath.Join(aptevaDir(), "update-backups", o.job.ID)
		if err := os.MkdirAll(backupDir, 0o700); err != nil {
			return nil, err
		}
		backup := filepath.Join(backupDir, "apteva.db")
		_ = os.Remove(backup)
		env = append(env, "APTEVA_UPDATE_BACKUP="+backup, "APTEVA_UPDATE_BACKUP_WHEN=incompatible")
	} else {
		env = append(env, "APTEVA_UPDATE_BACKUP=", "APTEVA_UPDATE_BACKUP_WHEN=never")
	}
	if o.full {
		env = append(env, "APTEVA_UPDATE_CHECK_FULL=1")
	}
	ctx, cancel := context.WithTimeoutCause(context.Background(), updateCheckCeiling, errors.New("the database check did not finish within "+updateCheckCeiling.String()))
	defer cancel()
	stallCtx, stall := context.WithCancelCause(ctx)
	defer stall(nil)
	cmd := osexec.CommandContext(stallCtx, server, "--preflight")
	cmd.Env = env
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	// SIGTERM lets the check remove its copy and any partial backup.
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = 20 * time.Second
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	runningCheckPID.Store(int64(cmd.Process.Pid))
	defer runningCheckPID.Store(0)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	err := followCheckProgress(dir, done, o.job, func() {
		stall(fmt.Errorf("the database check reported no progress for %s", updateCheckStall))
	})
	if err != nil {
		if backupDir != "" {
			_ = os.RemoveAll(backupDir)
		}
		if cause := context.Cause(stallCtx); cause != nil && !errors.Is(cause, context.Canceled) {
			return nil, fmt.Errorf("%v (%w)", cause, err)
		}
		return nil, err
	}
	raw, err := os.ReadFile(filepath.Join(dir, "report.json"))
	if err != nil {
		return nil, fmt.Errorf("the release did not write a database check report: %w", err)
	}
	var report struct {
		Version string `json:"version"`
		updateCheckSummary
		BackupInfo *struct {
			Path  string `json:"path"`
			Bytes int64  `json:"bytes"`
		} `json:"backup"`
	}
	if err := json.Unmarshal(raw, &report); err != nil {
		return nil, err
	}
	if report.Version != o.version {
		return nil, fmt.Errorf("the database check report is for v%s, not v%s", report.Version, o.version)
	}
	summary := report.updateCheckSummary
	summary.Backup = ""
	if report.BackupInfo != nil {
		summary.Backup, summary.BackupBytes = report.BackupInfo.Path, report.BackupInfo.Bytes
	} else if backupDir != "" {
		_ = os.RemoveAll(backupDir)
	}
	return &summary, nil
}

// followCheckProgress waits for the check, copying its progress into the job
// and onto the terminal, and calls stall when progress stops.
func followCheckProgress(dir string, done <-chan error, job *dashboardUpdateJob, stall func()) error {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	started := time.Now()
	shownPhase, printed := "", time.Time{}
	stalled := false
	for {
		select {
		case err := <-done:
			return err
		case <-ticker.C:
		}
		var p struct {
			Phase     string    `json:"phase"`
			Message   string    `json:"message"`
			Done      int64     `json:"done"`
			Total     int64     `json:"total"`
			UpdatedAt time.Time `json:"updated_at"`
		}
		last := started
		if raw, err := os.ReadFile(filepath.Join(dir, "progress.json")); err == nil && json.Unmarshal(raw, &p) == nil {
			if p.UpdatedAt.After(last) {
				last = p.UpdatedAt
			}
			if p.Message != "" {
				job.checkProgress(p.Message, updateJobProgress{Phase: p.Phase, Done: p.Done, Total: p.Total})
				// A new step prints at once; progress within a step at most
				// every few seconds.
				if p.Phase != shownPhase || time.Since(printed) > 5*time.Second {
					fmt.Fprintf(os.Stderr, "  %s\n", p.Message)
					shownPhase, printed = p.Phase, time.Now()
				}
			}
		}
		if !stalled && time.Since(last) > updateCheckStall {
			stalled = true
			stall()
		}
	}
}

// runLegacyPreflight serves releases whose server predates the reduced-copy
// check: dashboard jobs keep their full-copy check and backup, other updates
// get the basic preflight.
func runLegacyPreflight(server string, env []string, o releaseCheckOptions) (*updateCheckSummary, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	backup := ""
	if o.job.dashboard() {
		backup = filepath.Join(aptevaDir(), "update-backups", o.job.ID, "apteva.db")
		if err := os.MkdirAll(filepath.Dir(backup), 0o700); err != nil {
			return nil, err
		}
		env = append(env, "APTEVA_UPDATE_PREFLIGHT="+backup)
	}
	cmd := osexec.CommandContext(ctx, server, "--preflight")
	cmd.Env = env
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	if err := cmd.Run(); err != nil {
		return nil, err
	}
	if backup == "" {
		return nil, nil
	}
	raw, err := os.ReadFile(backup + ".json")
	var report struct {
		Version       string `json:"version"`
		SchemaChanged bool   `json:"schema_changed"`
		RollbackSafe  bool   `json:"rollback_safe"`
	}
	if err != nil || json.Unmarshal(raw, &report) != nil || report.Version != o.version {
		return nil, errors.New("new release did not produce a matching database preflight report")
	}
	summary := &updateCheckSummary{RollbackSafe: report.RollbackSafe, SchemaChanged: report.SchemaChanged, Compatible: report.RollbackSafe && !report.SchemaChanged, Classification: "incompatible", Backup: backup}
	if summary.Compatible {
		summary.Classification = "unchanged"
	}
	return summary, nil
}

// ---- jobs for CLI updates -----------------------------------------------

// dashboard reports whether the job came from the dashboard or Fleet rather
// than from this CLI.
func (j *dashboardUpdateJob) dashboard() bool { return j != nil && j.Source != "cli" }

// newCLIUpdateJob records an update started from this CLI in the same job
// file the dashboard reads, so an update is visible and recoverable the same
// way however it started. The caller holds the update lock.
func newCLIUpdateJob(target, previous, policy string) (*dashboardUpdateJob, error) {
	if old, err := readUpdateJob(); err == nil && old.Request.RequestID != "" {
		if err := archiveFleetUpdateJob(old); err != nil {
			return nil, err
		}
	}
	job := &dashboardUpdateJob{
		ID: strconv.FormatInt(time.Now().UnixNano(), 36), Source: "cli", State: "preparing",
		Message: "Update started from the command line", Target: target, Previous: previous,
		WorkerPID: os.Getpid(),
		Request:   dashboardUpdateRequest{Home: aptevaDir(), DBPath: updateDBPath(), Port: updatePort(), AgentPolicy: policy},
	}
	job.mu.Lock()
	err := job.saveLocked()
	job.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return job, nil
}

// heartbeat keeps the job's updated_at current while a step runs without
// reporting, so the dashboard can tell a working update from a dead one.
func (j *dashboardUpdateJob) heartbeat() (stop func()) {
	if j == nil {
		return func() {}
	}
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				j.mu.Lock()
				_ = j.saveLocked()
				j.mu.Unlock()
			}
		}
	}()
	return func() { close(done) }
}

func (j *dashboardUpdateJob) checkProgress(message string, p updateJobProgress) {
	if j == nil {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.Message == message && j.Progress != nil && *j.Progress == p {
		return
	}
	j.Message, j.Progress = message, &p
	_ = j.saveLocked()
}

func (j *dashboardUpdateJob) recordCheck(s *updateCheckSummary) {
	if j == nil || s == nil {
		return
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	j.Check = s
	j.Progress = nil
	j.Backup = s.Backup
	j.SchemaChanged = s.SchemaChanged
	j.RollbackSafe = s.RollbackSafe
	_ = j.saveLocked()
}

// previousRunsOnDatabase reports whether the previous release can run on the
// database this update leaves behind.
func (j *dashboardUpdateJob) previousRunsOnDatabase() bool {
	if j.Check != nil {
		return j.Check.Compatible
	}
	return !j.SchemaChanged && j.RollbackSafe
}

func (j *dashboardUpdateJob) checkSummary() *updateCheckSummary {
	if j == nil {
		return nil
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.Check
}

// finish records the outcome of a command-line update that did not record one
// itself. Dashboard and Fleet jobs are finished by their worker.
func (j *dashboardUpdateJob) finish(code int) {
	if j == nil || j.dashboard() {
		return
	}
	j.mu.Lock()
	state := j.State
	j.mu.Unlock()
	if updateJobTerminal(state) {
		return
	}
	switch {
	case code == 0:
		_ = j.phase("succeeded", "Update installed")
	case state == "activating" || state == "restarting":
		_ = j.phase("failed", "The update stopped while activating v"+j.Target+"; check `apteva service status` to see which version runs")
	default:
		_ = j.phase("failed", "Update failed before activation. The current version is unchanged.")
	}
}

// stopOnInterrupt ends a command-line update cleanly on Ctrl-C or SIGTERM
// before activation: it stops a running database check (which removes its
// copy and any partial backup) and records the update as canceled. Once
// activation starts the update runs to completion.
func (j *dashboardUpdateJob) stopOnInterrupt() (stop func()) {
	if j == nil || j.dashboard() {
		return func() {}
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case <-done:
				return
			case <-signals:
			}
			j.mu.Lock()
			state := j.State
			j.mu.Unlock()
			if state == "activating" || state == "restarting" {
				fmt.Fprintln(os.Stderr, "\nthe new version is being activated; the update finishes on its own")
				continue
			}
			fmt.Fprintln(os.Stderr, "\ncanceling the update…")
			if pid := int(runningCheckPID.Load()); pid > 0 {
				_ = syscall.Kill(pid, syscall.SIGTERM)
				for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline) && syscall.Kill(pid, 0) == nil; {
					time.Sleep(200 * time.Millisecond)
				}
			}
			_ = j.phase("failed", "Update canceled before activation. The current version is unchanged.")
			os.Exit(130)
		}
	}()
	return func() {
		signal.Stop(signals)
		close(done)
	}
}

// settleInterruptedCLIJob closes a command-line update whose process ended
// without recording an outcome. The caller holds the update lock, which that
// process held for its whole run, so it is no longer running.
func settleInterruptedCLIJob(job *dashboardUpdateJob) {
	if job == nil || job.Source != "cli" || updateJobTerminal(job.State) {
		return
	}
	job.finish(1)
}
