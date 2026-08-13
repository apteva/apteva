package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestSystemdUpdateMigrationPreservesOperatorDropIns(t *testing.T) {
	dir := t.TempDir()
	operatorPath := filepath.Join(dir, "override.conf")
	managedPath := filepath.Join(dir, systemdUpdateDropInName)
	operatorBody := []byte("[Service]\nEnvironment=KEEP_ME=yes\n")
	if err := os.WriteFile(operatorPath, operatorBody, 0o644); err != nil {
		t.Fatal(err)
	}

	var calls []string
	err := ensureSystemdUpdateCompatibilityAt(
		managedPath,
		func() error {
			calls = append(calls, "daemon-reload")
			return nil
		},
		func() (string, error) {
			calls = append(calls, "show")
			return "process", nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(calls, []string{"daemon-reload", "show"}) {
		t.Fatalf("systemctl calls = %v", calls)
	}
	gotManaged, err := os.ReadFile(managedPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotManaged) != systemdUpdateDropIn {
		t.Fatalf("managed drop-in = %q", gotManaged)
	}
	gotOperator, err := os.ReadFile(operatorPath)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gotOperator, operatorBody) {
		t.Fatalf("operator drop-in changed: %q", gotOperator)
	}
}

func TestSystemdUpdateDropInPathUsesInstalledScope(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	userPath, err := systemdUpdateDropInPath(scopeUser)
	if err != nil {
		t.Fatal(err)
	}
	wantUser := filepath.Join(home, ".config", "systemd", "user", "apteva.service.d", systemdUpdateDropInName)
	if userPath != wantUser {
		t.Fatalf("user drop-in path = %q, want %q", userPath, wantUser)
	}

	systemPath, err := systemdUpdateDropInPath(scopeSystem)
	if err != nil {
		t.Fatal(err)
	}
	wantSystem := filepath.Join("/etc", "systemd", "system", "apteva.service.d", systemdUpdateDropInName)
	if systemPath != wantSystem {
		t.Fatalf("system drop-in path = %q, want %q", systemPath, wantSystem)
	}
}

func TestSystemdUpdateMigrationRejectsReloadAndEffectiveMismatch(t *testing.T) {
	t.Run("daemon reload", func(t *testing.T) {
		showCalled := false
		err := ensureSystemdUpdateCompatibilityAt(
			filepath.Join(t.TempDir(), systemdUpdateDropInName),
			func() error { return errors.New("reload denied") },
			func() (string, error) {
				showCalled = true
				return "process", nil
			},
		)
		if err == nil || !strings.Contains(err.Error(), "reload denied") {
			t.Fatalf("error = %v", err)
		}
		if showCalled {
			t.Fatal("effective configuration queried after daemon-reload failure")
		}
	})

	t.Run("effective override", func(t *testing.T) {
		err := ensureSystemdUpdateCompatibilityAt(
			filepath.Join(t.TempDir(), systemdUpdateDropInName),
			func() error { return nil },
			func() (string, error) { return "control-group", nil },
		)
		if err == nil || !strings.Contains(err.Error(), `effective KillMode is "control-group"`) {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestWaitForUpdateHealthRetriesUntilHealthy(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		if requests < 2 {
			http.Error(w, "starting", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	if err := waitForUpdateHealth(server.URL, time.Second); err != nil {
		t.Fatal(err)
	}
	if requests < 2 {
		t.Fatalf("requests = %d, want retry", requests)
	}
}

func TestWaitForUpdateHealthTimesOut(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "starting", http.StatusServiceUnavailable)
	}))
	defer server.Close()

	err := waitForUpdateHealth(server.URL, 20*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "did not become healthy") {
		t.Fatalf("error = %v", err)
	}
}

func TestRestartAndVerifyUpdatedService(t *testing.T) {
	t.Run("restart failure is fatal and skips health", func(t *testing.T) {
		healthCalled := false
		err := restartAndVerifyUpdatedService(
			scopeSystem,
			"http://127.0.0.1:5280/health",
			time.Second,
			func(serviceScope) error { return errors.New("restart failed") },
			func(string, time.Duration) error {
				healthCalled = true
				return nil
			},
		)
		if err == nil || !strings.Contains(err.Error(), "restart failed") {
			t.Fatalf("error = %v", err)
		}
		if healthCalled {
			t.Fatal("health checked after failed restart")
		}
	})

	t.Run("health failure is fatal", func(t *testing.T) {
		err := restartAndVerifyUpdatedService(
			scopeUser,
			"http://127.0.0.1:5280/health",
			time.Second,
			func(serviceScope) error { return nil },
			func(string, time.Duration) error { return errors.New("health timeout") },
		)
		if err == nil || !strings.Contains(err.Error(), "health timeout") {
			t.Fatalf("error = %v", err)
		}
	})
}
