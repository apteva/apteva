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
	var body io.Reader
	if input != nil {
		b, err := json.Marshal(input)
		if err != nil {
			return s, err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, "http://host"+path, body)
	if err != nil {
		return s, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Do(req)
	if err != nil {
		return s, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return s, fmt.Errorf("host: HTTP %d: %s%s", resp.StatusCode, bytes.TrimSpace(b), hostAccessHint(resp.StatusCode))
	}
	err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&s)
	return s, err
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
func deployThroughHost(target, version string, job *dashboardUpdateJob, policy string) error {
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
	s, err := hostRequest(ctx, c, "POST", "/deploy", map[string]string{"binary": filepath.Join(target, "apteva-server"), "version": version, "agent_policy": policy})
	if err != nil {
		return unverified(err)
	}
	if s.Job == nil || (fleetJob && (s.Job.ID == "" || s.Job.Version != version)) {
		return unverified(fmt.Errorf("host did not return a deployment identity"))
	}
	id := s.Job.ID
	for {
		if s.Job == nil || s.Job.ID != id || (fleetJob && s.Job.Version != version) {
			return unverified(fmt.Errorf("host deployment identity changed"))
		}
		phase, message := s.Job.Phase, s.Job.Message
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

func validateThroughHost(target, version string) error {
	c := hostControlClient()
	defer c.CloseIdleConnections()
	c.Timeout = 6 * time.Minute
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()
	_, err := hostRequest(ctx, c, "POST", "/validate", map[string]string{"binary": filepath.Join(target, "apteva-server"), "version": version})
	return err
}
