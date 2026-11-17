//go:build !windows

package cli

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// restartHost answers like apteva-host, records request bodies by path and
// lets each test shape the reply.
func restartHost(t *testing.T, reply func(path string, body map[string]any, w http.ResponseWriter, s *hostState)) (string, map[string][]map[string]any) {
	t.Helper()
	bodies := map[string][]map[string]any{}
	var home string
	home = hostedCLIFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		bodies[r.URL.Path] = append(bodies[r.URL.Path], body)
		s := hostState{Protocol: 1, Home: home, DBPath: filepath.Join(home, "apteva.db"), PID: 123, ListenAddr: "127.0.0.1:5280", Version: "1.0.0"}
		if reply != nil {
			reply(r.URL.Path, body, w, &s)
		}
		if w.Header().Get("X-Replied") == "" {
			_ = json.NewEncoder(w).Encode(s)
		}
	}))
	return home, bodies
}

func refuse(w http.ResponseWriter, status int, message string) {
	w.Header().Set("X-Replied", "1")
	http.Error(w, message, status)
}

const hostRestartRefusal = "release changes stored schema or data; a restart migration is required, and the current server remains active"

func TestServingVersionComesFromTheStableHost(t *testing.T) {
	restartHost(t, nil)
	if got := servingVersion(); got != "1.0.0" {
		t.Fatalf("serving version %q, want the host's 1.0.0 (CLI is %s)", got, Version)
	}
	t.Setenv("APTEVA_HOME", t.TempDir())
	if got := servingVersion(); got != Version {
		t.Fatalf("without a host the CLI version applies, got %q", got)
	}
}

func TestHostCapabilitiesAndRestartRefusal(t *testing.T) {
	restartHost(t, func(_ string, _ map[string]any, _ http.ResponseWriter, s *hostState) {
		s.Capabilities = []string{"something", hostCapabilityRestartMigration}
	})
	state, _, err := probeHost()
	if err != nil || !state.supports(hostCapabilityRestartMigration) || state.supports("other") {
		t.Fatalf("capabilities: %v %v", state.Capabilities, err)
	}
	if !restartMigrationRequired(errors.New("host: HTTP 409: " + hostRestartRefusal)) {
		t.Fatal("host refusal not recognised")
	}
	if !restartMigrationRequired(errors.New("failed: " + hostRestartRefusal)) {
		t.Fatal("failed deployment not recognised")
	}
	if restartMigrationRequired(errors.New("failed: candidate preflight failed")) || restartMigrationRequired(nil) {
		t.Fatal("unrelated failure treated as a restart migration")
	}
}

func TestValidateAndDeployAskForRestartOnlyWhenAllowed(t *testing.T) {
	home, bodies := restartHost(t, func(path string, body map[string]any, w http.ResponseWriter, s *hostState) {
		switch path {
		case "/validate":
			w.Header().Set("X-Replied", "1")
			_ = json.NewEncoder(w).Encode(map[string]bool{"validated": true, "restart_required": body["allow_restart"] == true})
		case "/deploy":
			s.Version = "2.0.0"
			s.Job = &hostDeployment{ID: "job", Phase: "succeeded", Version: "2.0.0"}
		}
	})
	target := filepath.Join(home, "versions", "2.0.0")
	if restart, err := validateThroughHost(target, "2.0.0", false); err != nil || restart {
		t.Fatalf("plain validate: %v %v", restart, err)
	}
	if restart, err := validateThroughHost(target, "2.0.0", true); err != nil || !restart {
		t.Fatalf("validate with restart: %v %v", restart, err)
	}
	if err := deployThroughHost(target, "2.0.0", nil, "preserve", false); err != nil {
		t.Fatal(err)
	}
	if err := deployThroughHost(target, "2.0.0", nil, "preserve", true); err != nil {
		t.Fatal(err)
	}
	if _, ok := bodies["/validate"][0]["allow_restart"]; ok {
		t.Fatal("plain validate sent allow_restart")
	}
	if _, ok := bodies["/deploy"][0]["allow_restart"]; ok {
		t.Fatal("plain deploy sent allow_restart")
	}
	if bodies["/deploy"][1]["allow_restart"] != true || bodies["/deploy"][1]["binary"] != filepath.Join(target, "apteva-server") {
		t.Fatalf("restart deploy request: %v", bodies["/deploy"][1])
	}
}

func TestDeployReportsRestartRefusal(t *testing.T) {
	home, _ := restartHost(t, func(path string, _ map[string]any, w http.ResponseWriter, s *hostState) {
		s.Job = &hostDeployment{ID: "job", Phase: "failed", Version: "2.0.0", Message: hostRestartRefusal}
	})
	err := deployThroughHost(filepath.Join(home, "versions", "2.0.0"), "2.0.0", nil, "preserve", false)
	if !restartMigrationRequired(err) {
		t.Fatalf("refusal: %v", err)
	}
}

func installVersions(t *testing.T, withHost bool, versions ...string) {
	t.Helper()
	for _, version := range versions {
		if err := os.MkdirAll(versionDir(version), 0755); err != nil {
			t.Fatal(err)
		}
		names := append([]string(nil), binNames...)
		if withHost {
			names = append(names, "apteva-host")
		}
		for _, bin := range names {
			if err := os.WriteFile(filepath.Join(versionDir(version), bin), []byte("test"), 0755); err != nil {
				t.Fatal(err)
			}
		}
	}
}

// fakeService restarts nothing; healthy lists the versions /health reports.
func fakeService(restarts *int, healthy ...string) serviceControl {
	return serviceControl{
		detect:  func() (serviceScope, bool) { return scopeUser, true },
		restart: func(serviceScope) error { *restarts++; return nil },
		wait: func(port int, version string, _ time.Duration) error {
			if port != 5280 {
				return errors.New("wrong port")
			}
			for _, v := range healthy {
				if v == version {
					return nil
				}
			}
			return errors.New("not healthy")
		},
	}
}

func readNextServer(t *testing.T) map[string]string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(hostSocket()), hostNextServerFile))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var request map[string]string
	if err := json.Unmarshal(raw, &request); err != nil {
		t.Fatal(err)
	}
	return request
}

func TestRestartServiceOntoReleaseThroughOlderHost(t *testing.T) {
	restartHost(t, nil)
	installVersions(t, true, "1.0.0", "2.0.0")
	if err := pointSymlinks("1.0.0"); err != nil {
		t.Fatal(err)
	}
	state, _, err := probeHost()
	if err != nil {
		t.Fatal(err)
	}
	target := versionDir("2.0.0")

	restarts := 0
	if err := restartServiceOntoReleaseWith(target, "2.0.0", state, "preserve", fakeService(&restarts, "2.0.0")); err != nil {
		t.Fatal(err)
	}
	if restarts != 1 || activeVersion() != "2.0.0" {
		t.Fatalf("restarts=%d active=%s", restarts, activeVersion())
	}
	// The new host reads this on start and removes it once the server serves.
	if request := readNextServer(t); request["version"] != "2.0.0" || request["binary"] != filepath.Join(target, "apteva-server") {
		t.Fatalf("next-server request: %v", request)
	}
}

func TestRestartServiceOntoReleaseRestoresLinksWhenNothingMigrated(t *testing.T) {
	restartHost(t, nil)
	installVersions(t, true, "1.0.0", "2.0.0")
	if err := pointSymlinks("1.0.0"); err != nil {
		t.Fatal(err)
	}
	state, _, _ := probeHost()
	restarts := 0
	err := restartServiceOntoReleaseWith(versionDir("2.0.0"), "2.0.0", state, "preserve", fakeService(&restarts, "1.0.0"))
	if err == nil || !strings.Contains(err.Error(), "database was not migrated") {
		t.Fatalf("previous version serving: %v", err)
	}
	if activeVersion() != "1.0.0" || readNextServer(t) != nil {
		t.Fatalf("links or request not restored: active=%s request=%v", activeVersion(), readNextServer(t))
	}
}

func TestRestartServiceOntoReleaseNeverRestartsPreviousAfterMigrationMayHaveStarted(t *testing.T) {
	restartHost(t, nil)
	installVersions(t, true, "1.0.0", "2.0.0")
	if err := pointSymlinks("1.0.0"); err != nil {
		t.Fatal(err)
	}
	state, _, _ := probeHost()
	restarts := 0
	err := restartServiceOntoReleaseWith(versionDir("2.0.0"), "2.0.0", state, "preserve", fakeService(&restarts))
	if err == nil || !strings.Contains(err.Error(), "previous version was not restarted") {
		t.Fatalf("nothing healthy: %v", err)
	}
	if restarts != 1 || activeVersion() != "2.0.0" || readNextServer(t)["version"] != "2.0.0" {
		t.Fatalf("new version must stay in place: restarts=%d active=%s", restarts, activeVersion())
	}
}

func TestRestartServiceOntoReleaseNeedsTheNewHost(t *testing.T) {
	restartHost(t, nil)
	installVersions(t, false, "2.0.0")
	state, _, _ := probeHost()
	restarts := 0
	err := restartServiceOntoReleaseWith(versionDir("2.0.0"), "2.0.0", state, "preserve", fakeService(&restarts, "2.0.0"))
	if err == nil || restarts != 0 || readNextServer(t) != nil {
		t.Fatalf("release without apteva-host: err=%v restarts=%d", err, restarts)
	}
}
