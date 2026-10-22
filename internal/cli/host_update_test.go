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
	"testing"
)

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
