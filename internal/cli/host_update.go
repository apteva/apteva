//go:build !windows

package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type hostDeployment struct {
	ID      string `json:"id"`
	Phase   string `json:"phase"`
	Message string `json:"message"`
	Version string `json:"version"`
}
type hostState struct {
	HostBinary string          `json:"host_binary"`
	Protocol   int             `json:"protocol"`
	Home       string          `json:"home"`
	DBPath     string          `json:"db_path"`
	ListenAddr string          `json:"listen_addr"`
	PID        int             `json:"pid"`
	Binary     string          `json:"binary"`
	Version    string          `json:"version"`
	Job        *hostDeployment `json:"job"`
	// Capabilities lists optional host features; older hosts send none.
	Capabilities []string `json:"capabilities"`
}

// hostCapabilityRestartMigration: the host deploys a release that changes
// stored schema itself, by stopping the current server and booting the new one.
const hostCapabilityRestartMigration = "restart_migration"

func (s hostState) supports(capability string) bool {
	for _, c := range s.Capabilities {
		if c == capability {
			return true
		}
	}
	return false
}

// restartMigrationRequired reports a host refusal of a release that changes
// stored schema, which cannot run beside the current server.
func restartMigrationRequired(err error) bool {
	return err != nil && strings.Contains(err.Error(), "restart migration is required")
}

// apteva-host authenticates control-socket callers with a per-host token it
// mints on every start: server slots receive it in the environment, local
// tools read it from control.token next to the socket (mode 0600, so only
// the user that runs the host can). Hosts that predate the token ignore it.
const (
	hostControlTokenHeader = "X-Apteva-Host-Token"
	hostControlTokenEnv    = "APTEVA_HOST_CONTROL_TOKEN"
	hostControlTokenFile   = "control.token"
)

func hostSocket() string { return filepath.Join(aptevaDir(), "host", "control.sock") }

// hostControlToken is resolved per request, so a host restarted mid-deploy
// (which rotates the token) keeps being reachable.
func hostControlToken() string {
	if token := strings.TrimSpace(os.Getenv(hostControlTokenEnv)); token != "" {
		return token
	}
	b, err := os.ReadFile(filepath.Join(filepath.Dir(hostSocket()), hostControlTokenFile))
	if err != nil || len(b) > 512 {
		return ""
	}
	return strings.TrimSpace(string(b))
}

type hostTokenTransport struct{ base *http.Transport }

func (t *hostTokenTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if token := hostControlToken(); token != "" && r.Header.Get(hostControlTokenHeader) == "" {
		r = r.Clone(r.Context())
		r.Header.Set(hostControlTokenHeader, token)
	}
	return t.base.RoundTrip(r)
}

func (t *hostTokenTransport) CloseIdleConnections() { t.base.CloseIdleConnections() }

func hostControlClient() *http.Client {
	base := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", hostSocket())
	}}
	return &http.Client{Timeout: 10 * time.Second, Transport: &hostTokenTransport{base: base}}
}

// hostAccessHint explains a refused control-socket call in terms the
// operator can act on.
func hostAccessHint(status int) string {
	dir := filepath.Dir(hostSocket())
	switch status {
	case http.StatusUnauthorized:
		return fmt.Sprintf(" (the host requires its control token: run this as the user that owns %s so %s is readable, or set %s)", dir, filepath.Join(dir, hostControlTokenFile), hostControlTokenEnv)
	case http.StatusForbidden:
		return fmt.Sprintf(" (the host only accepts its own OS user or root on %s; run this as that user)", hostSocket())
	}
	return ""
}
func hostRequest(ctx context.Context, c *http.Client, method, path string, input any) (hostState, error) {
	var s hostState
	err := hostCall(ctx, c, method, path, input, &s)
	return s, err
}
func hostCall(ctx context.Context, c *http.Client, method, path string, input, output any) error {
	var body io.Reader
	if input != nil {
		b, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://host"+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("host: HTTP %d: %s%s", resp.StatusCode, bytes.TrimSpace(b), hostAccessHint(resp.StatusCode))
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(output)
}
func probeHost() (hostState, bool, error) {
	var zero hostState
	if _, err := os.Lstat(hostSocket()); os.IsNotExist(err) {
		return zero, false, nil
	} else if err != nil {
		return zero, true, err
	}
	c := hostControlClient()
	defer c.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s, err := hostRequest(ctx, c, "GET", "/status", nil)
	if err != nil {
		return s, true, err
	}
	home, _ := filepath.Abs(aptevaDir())
	db := os.Getenv("DB_PATH")
	if db == "" {
		db = filepath.Join(home, "apteva.db")
	}
	db, _ = filepath.Abs(db)
	if s.Protocol != 1 || s.Home != home || s.DBPath != db || s.PID < 1 {
		return s, true, fmt.Errorf("host identity does not match this installation; refusing a restart fallback")
	}
	return s, true, nil
}

// deployThroughHost asks the host to activate version. allowRestart lets a
// release that changes stored schema deploy as a restart migration (hosts
// without that capability ignore it and refuse such releases).
func deployThroughHost(target, version string, job *dashboardUpdateJob, policy string, allowRestart bool) error {
	c := hostControlClient()
	defer c.CloseIdleConnections()
	// Deployment is owned by the host, independent of this terminal/updater.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	fleetJob := job != nil && job.Request.RequestID != ""
	unverified := func(err error) error {
		if fleetJob {
			return errors.Join(err, job.phase("recovery_required", err.Error()))
		}
		return err
	}
	if fleetJob {
		if err := job.phase("activating", "Requesting activation from the stable host"); err != nil {
			return err
		}
	}
	request := map[string]any{"binary": filepath.Join(target, "apteva-server"), "version": version, "agent_policy": policy}
	if allowRestart {
		request["allow_restart"] = true
	}
	s, err := hostRequest(ctx, c, "POST", "/deploy", request)
	if err != nil {
		return unverified(err)
	}
	if s.Job == nil || (fleetJob && (s.Job.ID == "" || s.Job.Version != version)) {
		return unverified(fmt.Errorf("host did not return a deployment identity"))
	}
	id := s.Job.ID
	shown := ""
	for {
		if s.Job == nil || s.Job.ID != id || (fleetJob && s.Job.Version != version) {
			return unverified(fmt.Errorf("host deployment identity changed"))
		}
		phase, message := s.Job.Phase, s.Job.Message
		if job == nil && phase != shown && !updateJobTerminal(phase) {
			// A restart migration has downtime; show where it is.
			fmt.Fprintf(os.Stderr, "  %s: %s\n", phase, message)
			shown = phase
		}
		if fleetJob && phase == "succeeded" {
			phase, message = "activating", "Committing the CLI release after the stable host activated"
		}
		if err = job.phase(phase, message); err != nil {
			return unverified(err)
		}
		switch s.Job.Phase {
		case "succeeded":
			if s.Version != version {
				return unverified(fmt.Errorf("host activated a different version"))
			}
			return nil
		case "failed", "rolled_back", "recovery_required":
			return fmt.Errorf("%s: %s", s.Job.Phase, s.Job.Message)
		}
		select {
		case <-ctx.Done():
			return unverified(fmt.Errorf("host deployment continues independently; check status before retrying: %w", ctx.Err()))
		case <-time.After(time.Second):
		}
		s, err = hostRequest(ctx, c, "GET", "/status", nil)
		if err != nil {
			return unverified(fmt.Errorf("host status unavailable; no restart fallback attempted: %w", err))
		}
	}
}
func hostedServiceIdentity(r dashboardUpdateRequest) (bool, error) {
	s, present, err := probeHost()
	if !present {
		return false, nil
	}
	if err != nil {
		return true, err
	}
	_, port, err := net.SplitHostPort(s.ListenAddr)
	if err != nil || port != strconv.Itoa(r.Port) || s.PID != r.ServerPID || s.DBPath != r.DBPath {
		return true, fmt.Errorf("dashboard update does not match the stable host")
	}
	return true, nil
}
func optionalHostBinary(serverBin string) string {
	p := filepath.Join(filepath.Dir(serverBin), "apteva-host")
	if info, err := os.Stat(p); err == nil && !info.IsDir() {
		return p
	}
	return ""
}

// validateThroughHost runs the host's preflight. With allowRestart, a release
// that changes stored schema validates and restartRequired is reported
// instead of a refusal.
func validateThroughHost(target, version string, allowRestart bool) (restartRequired bool, err error) {
	c := hostControlClient()
	defer c.CloseIdleConnections()
	c.Timeout = 6 * time.Minute
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()
	request := map[string]any{"binary": filepath.Join(target, "apteva-server"), "version": version}
	if allowRestart {
		request["allow_restart"] = true
	}
	var result struct {
		RestartRequired bool `json:"restart_required"`
	}
	err = hostCall(ctx, c, "POST", "/validate", request, &result)
	return result.RestartRequired, err
}

// hostNextServerFile is read by the next host start (host.NextServerPath).
const hostNextServerFile = "next-server.json"

// restartServiceOntoRelease migrates through a host too old to run restart
// migrations itself: it restarts the service onto the new release, whose host
// boots the new server fresh, so it applies its migrations as it starts. The
// host's preflight already ran those migrations on a copy of the database.
//
// If the new server does not come up but the previous one does, nothing was
// migrated and the CLI links go back. Otherwise the new version stays in
// place: an older server is never started on a database that may be migrated.
func restartServiceOntoRelease(target, version string, state hostState, policy string) error {
	return restartServiceOntoReleaseWith(target, version, state, policy, serviceControl{
		detect:  detectInstalledScope,
		restart: restartServiceForRollback,
		wait:    waitForUpdateVersion,
	})
}

type serviceControl struct {
	detect  func() (serviceScope, bool)
	restart func(serviceScope) error
	wait    func(port int, version string, timeout time.Duration) error
}

func restartServiceOntoReleaseWith(target, version string, state hostState, policy string, service serviceControl) error {
	if optionalHostBinary(filepath.Join(target, "apteva-server")) == "" {
		return fmt.Errorf("v%s has no apteva-host, so it cannot take over the stable host", version)
	}
	scope, installed := service.detect()
	if !installed {
		return errors.New("the stable host is not running as a service; stop it, then start it again on the new version")
	}
	_, portText, err := net.SplitHostPort(state.ListenAddr)
	port, convErr := strconv.Atoi(portText)
	if err != nil || convErr != nil {
		return fmt.Errorf("cannot read the stable host's port from %q", state.ListenAddr)
	}
	request := filepath.Join(filepath.Dir(hostSocket()), hostNextServerFile)
	raw, _ := json.Marshal(map[string]string{"binary": filepath.Join(target, "apteva-server"), "version": version})
	if err := writeFileAtomic(request, raw, 0o600); err != nil {
		return err
	}
	if err := writeLifecycleIntent("update", policy); err != nil {
		_ = os.Remove(request)
		return err
	}
	// The service starts bin/apteva-host, which follows bin/current.
	if err := pointSymlinks(version); err != nil {
		_ = os.Remove(request)
		clearLifecycleIntent()
		return err
	}
	fmt.Fprintf(os.Stderr, "  restarting the service onto v%s; it migrates the database as it starts…\n", version)
	if err := service.restart(scope); err != nil {
		return fmt.Errorf("service restart: %w; check `apteva service status`", err)
	}
	err = service.wait(port, version, 6*time.Minute)
	if err == nil {
		return nil
	}
	if state.Version != "" && state.Version != version && service.wait(port, state.Version, 5*time.Second) == nil {
		// The new host did not follow the request (for example it predates
		// it), so the previous server booted and nothing was migrated.
		_ = os.Remove(request)
		clearLifecycleIntent()
		if linkErr := pointSymlinks(state.Version); linkErr != nil {
			return fmt.Errorf("v%s did not start (%v) and v%s is serving, but the CLI links could not be restored: %w", version, err, state.Version, linkErr)
		}
		return fmt.Errorf("v%s did not start: %w; v%s is still serving and the database was not migrated", version, err, state.Version)
	}
	return fmt.Errorf("v%s did not become healthy: %w. It may have started migrating the database, so the previous version was not restarted; check `apteva service logs`", version, err)
}

func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
