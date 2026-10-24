//go:build !windows

package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
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

func hostSocket() string { return filepath.Join(aptevaDir(), "host", "control.sock") }
func hostControlClient() *http.Client {
	return &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", hostSocket())
	}}}
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
		return s, fmt.Errorf("host: HTTP %d: %s", resp.StatusCode, b)
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
	s, err := hostRequest(ctx, c, "POST", "/deploy", map[string]string{"binary": filepath.Join(target, "apteva-server"), "version": version, "agent_policy": policy})
	if err != nil {
		return err
	}
	if s.Job == nil {
		return fmt.Errorf("host did not return a deployment identity")
	}
	id := s.Job.ID
	for {
		if s.Job == nil || s.Job.ID != id {
			return fmt.Errorf("host deployment identity changed")
		}
		if err = job.phase(s.Job.Phase, s.Job.Message); err != nil {
			return err
		}
		switch s.Job.Phase {
		case "succeeded":
			if s.Version != version {
				return fmt.Errorf("host activated a different version")
			}
			return nil
		case "failed", "rolled_back", "recovery_required":
			return fmt.Errorf("%s: %s", s.Job.Phase, s.Job.Message)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("host deployment continues independently; check status before retrying: %w", ctx.Err())
		case <-time.After(time.Second):
		}
		s, err = hostRequest(ctx, c, "GET", "/status", nil)
		if err != nil {
			return fmt.Errorf("host status unavailable; no restart fallback attempted: %w", err)
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
