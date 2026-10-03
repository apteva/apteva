//go:build !windows

package cli

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDashboardUpdateJobPersistenceAndLock(t *testing.T) {
	t.Setenv("APTEVA_HOME", t.TempDir())
	lock, err := acquireUpdateLock()
	if err != nil {
		t.Fatal(err)
	}
	if other, err := acquireUpdateLock(); err == nil {
		other.Close()
		t.Fatal("concurrent updater acquired lock")
	}
	lock.Close()
	lock, err = acquireUpdateLock()
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	job := &dashboardUpdateJob{ID: "test", Target: "1.2.3", Previous: "1.2.2"}
	job.phase("downloading", "Downloading release")
	saved, err := readUpdateJob()
	if err != nil {
		t.Fatal(err)
	}
	if saved.ID != job.ID || saved.State != "downloading" || saved.UpdatedAt.IsZero() {
		t.Fatalf("invalid durable job: %+v", saved)
	}
	info, err := os.Stat(updateJobPath())
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("job must be private")
	}
	job.phase("failed", "Download failed")
	saved, err = readUpdateJob()
	if err != nil || !updateJobTerminal(saved.State) {
		t.Fatal("terminal state not persisted")
	}
}

func TestUpdateHealthRequiresExpectedVersion(t *testing.T) {
	for _, tc := range []struct {
		name, version string
		ok            bool
		status        int
		wantSuccess   bool
	}{
		{"right version", "1.2.3", true, 200, true},
		{"old process", "1.2.2", true, 200, false},
		{"not ready", "1.2.3", false, 200, false},
		{"error status", "1.2.3", true, 503, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/health" {
					t.Error("unexpected health path")
				}
				w.WriteHeader(tc.status)
				_ = json.NewEncoder(w).Encode(map[string]any{"ok": tc.ok, "cli": tc.version})
			}))
			defer srv.Close()
			err := waitForUpdateVersion(srv.Listener.Addr().(*net.TCPAddr).Port, "1.2.3", 100*time.Millisecond)
			if (err == nil) != tc.wantSuccess {
				t.Fatalf("health result: %v", err)
			}
		})
	}
}

func TestDashboardUpdateRecoveryDoesNotRevertMigratedDatabase(t *testing.T) {
	t.Setenv("APTEVA_HOME", t.TempDir())
	j := &dashboardUpdateJob{ID: "test", SchemaChanged: true, Backup: filepath.Join(aptevaDir(), "backup.db")}
	err := j.recoverActivation(scopeUser, os.ErrInvalid)
	if err == nil {
		t.Fatal("activation failure disappeared")
	}
	saved, err := readUpdateJob()
	if err != nil {
		t.Fatal(err)
	}
	if saved.State != "recovery_required" || !strings.Contains(saved.Message, j.Backup) {
		t.Fatalf("missing recovery instructions: %+v", saved)
	}
	if _, err := os.Lstat(currentLink()); !os.IsNotExist(err) {
		t.Fatal("recovery changed the active version despite migrated data")
	}
}

func TestDashboardUpdateRejectsInvalidIdentity(t *testing.T) {
	t.Setenv("APTEVA_HOME", t.TempDir())
	for _, req := range []dashboardUpdateRequest{
		{},
		{Home: "/different", DBPath: "/tmp/db", Port: 5280, ServerPID: 1, Method: "systemd-user", AgentPolicy: "restart"},
		{Home: aptevaDir(), DBPath: "relative", Port: 5280, ServerPID: 1, Method: "systemd-user", AgentPolicy: "restart"},
	} {
		if err := validateUpdateService(req); err == nil {
			t.Fatal("invalid identity accepted")
		}
	}
	if _, err := updateScope("foreground"); err == nil {
		t.Fatal("foreground restart incorrectly advertised")
	}
}

func TestDashboardUpdateRollbackVerifiesPreviousVersion(t *testing.T) {
	for _, fail := range []string{"", "flip", "restart", "health"} {
		t.Run("failure_"+fail, func(t *testing.T) {
			t.Setenv("APTEVA_HOME", t.TempDir())
			j := &dashboardUpdateJob{ID: "test", Previous: "1.2.2", RollbackSafe: true, Request: dashboardUpdateRequest{Port: 5287}}
			var steps []string
			err := j.recoverActivationWith(scopeUser, os.ErrInvalid,
				func(version string) error {
					steps = append(steps, "flip")
					if version != "1.2.2" {
						t.Error("wrong rollback version")
					}
					if fail == "flip" {
						return os.ErrPermission
					}
					return nil
				},
				func(scope serviceScope) error {
					steps = append(steps, "restart")
					if scope != scopeUser {
						t.Error("wrong service scope")
					}
					if fail == "restart" {
						return os.ErrPermission
					}
					return nil
				},
				func(port int, version string, _ time.Duration) error {
					steps = append(steps, "health")
					if port != 5287 || version != "1.2.2" {
						t.Error("wrong recovery target")
					}
					if fail == "health" {
						return os.ErrDeadlineExceeded
					}
					return nil
				},
			)
			if err == nil {
				t.Fatal("initial activation failure was swallowed")
			}
			saved, err := readUpdateJob()
			if err != nil {
				t.Fatal(err)
			}
			want := "recovery_required"
			if fail == "" {
				want = "rolled_back"
				if strings.Join(steps, ",") != "flip,restart,health" {
					t.Fatalf("recovery order: %v", steps)
				}
			}
			if saved.State != want {
				t.Fatalf("state=%s want=%s", saved.State, want)
			}
		})
	}
}
