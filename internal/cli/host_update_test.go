//go:build !windows

package cli

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestFleetStableHostRequiresConfirmedDeploymentAndCLICommit(t *testing.T) {
	for _, scenario := range []struct {
		name    string
		reply   int
		phase   string
		wantErr bool
	}{
		{"lost reply", http.StatusServiceUnavailable, "recovery_required", true},
		{"stable host activated", http.StatusOK, "activating", false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			home := hostedCLIFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(scenario.reply)
				_ = json.NewEncoder(w).Encode(hostState{Version: "1.2.3", Job: &hostDeployment{
					ID: "host-job", Phase: "succeeded", Version: "1.2.3",
				}})
			}))
			job := &dashboardUpdateJob{ID: "fleet-job", Target: "1.2.3",
				Request: dashboardUpdateRequest{RequestID: strings.Repeat("a", 32)}}
			err := deployThroughHost(home, "1.2.3", job, "preserve", false)
			if (err != nil) != scenario.wantErr {
				t.Fatalf("unexpected deployment result: %v", err)
			}
			saved, err := readUpdateJob()
			if err != nil || saved.State != scenario.phase {
				t.Fatalf("unexpected durable deployment state: %+v (%v)", saved, err)
			}
		})
	}
}

func hostedCLIFixture(t *testing.T, handler http.Handler) string {
	t.Helper()
	root := os.TempDir()
	if runtime.GOOS == "darwin" {
		root = "/private/tmp"
	}
	home, err := os.MkdirTemp(root, "apteva-cli-host-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	t.Setenv("APTEVA_HOME", home)
	t.Setenv("DB_PATH", "")
	if err := os.MkdirAll(filepath.Dir(hostSocket()), 0700); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", hostSocket())
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: handler}
	go server.Serve(listener)
	t.Cleanup(func() { server.Close() })
	return home
}

func TestHostIdentityMismatchNeverFallsBackToLegacyRestart(t *testing.T) {
	var state hostState
	home := hostedCLIFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(state) }))
	state = hostState{Protocol: 1, Home: home, DBPath: filepath.Join(home, "apteva.db"), PID: 123, ListenAddr: "127.0.0.1:5280"}
	if _, present, err := probeHost(); !present || err != nil {
		t.Fatalf("valid host: %v", err)
	}
	state.DBPath = filepath.Join(home, "other.db")
	if _, present, err := probeHost(); !present || err == nil {
		t.Fatal("identity mismatch allowed restart fallback")
	}
	state.DBPath = filepath.Join(home, "apteva.db")
	if _, err := hostedServiceIdentity(dashboardUpdateRequest{DBPath: state.DBPath, ServerPID: 123, Port: 5281}); err == nil {
		t.Fatal("wrong service port accepted")
	}
}

func TestHostSocketFailureNeverLooksLikeLegacyInstallation(t *testing.T) {
	root := os.TempDir()
	if runtime.GOOS == "darwin" {
		root = "/private/tmp"
	}
	home, err := os.MkdirTemp(root, "apteva-cli-stale-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(home)
	t.Setenv("APTEVA_HOME", home)
	if err := os.MkdirAll(filepath.Dir(hostSocket()), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hostSocket(), []byte("stale socket identity"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, present, err := probeHost(); !present || err == nil {
		t.Fatal("unavailable host allowed restart fallback")
	}
}

func TestHostedRollbackKeepsPointerOnFailureAndUsesExistingCommand(t *testing.T) {
	var home string
	fail := true
	deployments := 0
	home = hostedCLIFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s := hostState{Protocol: 1, Home: home, DBPath: filepath.Join(home, "apteva.db"), PID: 123, ListenAddr: "127.0.0.1:5280", Version: "2.0.0"}
		if r.URL.Path == "/deploy" {
			deployments++
			if fail {
				http.Error(w, "refusing incompatible release", 409)
				return
			}
			var request map[string]string
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Error(err)
			}
			if request["version"] != "1.0.0" || request["agent_policy"] != "preserve" {
				t.Errorf("rollback changed semantics: %v", request)
			}
			s.Version = "1.0.0"
			s.Job = &hostDeployment{ID: "rollback-test", Version: "1.0.0", Phase: "succeeded"}
		}
		json.NewEncoder(w).Encode(s)
	}))
	for _, version := range []string{"1.0.0", "2.0.0"} {
		if err := os.MkdirAll(versionDir(version), 0755); err != nil {
			t.Fatal(err)
		}
		for _, bin := range binNames {
			if err := os.WriteFile(filepath.Join(versionDir(version), bin), []byte("test"), 0755); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := pointSymlinks("2.0.0"); err != nil {
		t.Fatal(err)
	}
	// The CLI recorded the update it is rolling back; an unrecorded one is
	// refused before reaching the host (TestRollbackRefusesUnrecordedUpdate).
	recordUpdateHistory("1.0.0", "2.0.0", &updateCheckSummary{Classification: "compatible", Compatible: true})
	if code := cmdRollback([]string{"1.0.0"}); code == 0 || activeVersion() != "2.0.0" {
		t.Fatal("failed hosted rollback changed CLI pointer")
	}
	fail = false
	if code := cmdRollback([]string{"1.0.0"}); code != 0 || activeVersion() != "1.0.0" || deployments != 2 {
		t.Fatal("existing rollback command failed")
	}
}

func TestOptionalHostDoesNotInvalidateOlderArchives(t *testing.T) {
	t.Setenv("APTEVA_HOME", t.TempDir())
	dir := versionDir("1.0.0")
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
	for _, bin := range binNames {
		if err := os.WriteFile(filepath.Join(dir, bin), []byte("test"), 0755); err != nil {
			t.Fatal(err)
		}
	}
	if got := optionalHostBinary(filepath.Join(dir, "apteva-server")); got != "" {
		t.Fatal("old archive requires host")
	}
	if err := pointSymlinks("1.0.0"); err != nil {
		t.Fatal(err)
	}
	host := filepath.Join(dir, "apteva-host")
	if err := os.WriteFile(host, []byte("test"), 0755); err != nil {
		t.Fatal(err)
	}
	if got := optionalHostBinary(filepath.Join(dir, "apteva-server")); got != host {
		t.Fatal("host not discovered")
	}
	if err := pointSymlinks("1.0.0"); err != nil {
		t.Fatal(err)
	}
	host, _ = filepath.EvalSymlinks(host)
	target, err := filepath.EvalSymlinks(resolveBin("apteva-host"))
	if err != nil || target != host {
		t.Fatalf("optional host shim: %s %v", target, err)
	}
	c := hostControlClient()
	defer c.CloseIdleConnections()
	if _, err := hostRequest(context.Background(), c, "POST", "/deploy", make(chan int)); err == nil {
		t.Fatal("unencodable deployment accepted")
	}
}

// recordingHost answers like apteva-host and remembers the control token
// each request carried.
func recordingHost(t *testing.T, status int) (string, *[]string) {
	t.Helper()
	var seen []string
	var home string
	home = hostedCLIFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Header.Get(hostControlTokenHeader))
		if status != http.StatusOK {
			http.Error(w, "missing or invalid host control token", status)
			return
		}
		_ = json.NewEncoder(w).Encode(hostState{Protocol: 1, Home: home, DBPath: filepath.Join(home, "apteva.db"), PID: 123, ListenAddr: "127.0.0.1:5280"})
	}))
	return home, &seen
}

func TestHostControlTokenFromEnvironment(t *testing.T) {
	_, seen := recordingHost(t, http.StatusOK)
	t.Setenv(hostControlTokenEnv, "  env-token  ")
	if _, present, err := probeHost(); !present || err != nil {
		t.Fatalf("probe: %v", err)
	}
	if len(*seen) != 1 || (*seen)[0] != "env-token" {
		t.Fatalf("token sent: %q", *seen)
	}
}

func TestHostControlTokenFromFileFollowsRotation(t *testing.T) {
	t.Setenv(hostControlTokenEnv, "")
	home, seen := recordingHost(t, http.StatusOK)
	tokenPath := filepath.Join(home, "host", hostControlTokenFile)
	if err := os.WriteFile(tokenPath, []byte("first-token\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := probeHost(); err != nil {
		t.Fatal(err)
	}
	// A host restart mints a new token; the same CLI run must pick it up.
	if err := os.WriteFile(tokenPath, []byte("second-token\n"), 0600); err != nil {
		t.Fatal(err)
	}
	c := hostControlClient()
	defer c.CloseIdleConnections()
	if _, err := hostRequest(context.Background(), c, "GET", "/status", nil); err != nil {
		t.Fatal(err)
	}
	if len(*seen) != 2 || (*seen)[0] != "first-token" || (*seen)[1] != "second-token" {
		t.Fatalf("tokens sent: %q", *seen)
	}
}

func TestHostControlWithoutTokenStillReachesOlderHosts(t *testing.T) {
	t.Setenv(hostControlTokenEnv, "")
	_, seen := recordingHost(t, http.StatusOK)
	if _, present, err := probeHost(); !present || err != nil {
		t.Fatalf("older host without token support: %v", err)
	}
	if len(*seen) != 1 || (*seen)[0] != "" {
		t.Fatalf("unexpected token header: %q", *seen)
	}
}

func TestHostControlRefusalExplainsHowToGetAccess(t *testing.T) {
	t.Setenv(hostControlTokenEnv, "")
	for status, want := range map[int]string{
		http.StatusUnauthorized: hostControlTokenEnv,
		http.StatusForbidden:    "OS user",
	} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			recordingHost(t, status)
			_, present, err := probeHost()
			if !present || err == nil || !strings.Contains(err.Error(), want) || !strings.Contains(err.Error(), "HTTP "+strconv.Itoa(status)) {
				t.Fatalf("refusal not explained: %v", err)
			}
		})
	}
}

// A rollback across an update the CLI has no record of is refused without
// --force, before the host is asked to deploy anything.
func TestRollbackRefusesUnrecordedUpdate(t *testing.T) {
	t.Setenv("APTEVA_HOME", t.TempDir())
	for _, version := range []string{"1.0.0", "2.0.0"} {
		if err := os.MkdirAll(versionDir(version), 0755); err != nil {
			t.Fatal(err)
		}
		for _, bin := range binNames {
			if err := os.WriteFile(filepath.Join(versionDir(version), bin), []byte("test"), 0755); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := pointSymlinks("2.0.0"); err != nil {
		t.Fatal(err)
	}
	if code := cmdRollback([]string{"1.0.0"}); code != 1 || activeVersion() != "2.0.0" {
		t.Fatalf("unrecorded rollback: code %d, active %s", code, activeVersion())
	}
}
