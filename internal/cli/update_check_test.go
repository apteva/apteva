//go:build !windows

package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeCheckServer writes an apteva-server stand-in for the database check.
// FAKE_CHECK picks its report: unchanged, compatible, incompatible, stall or
// fail. With legacy=true it predates the update_check capability.
func fakeCheckServer(t *testing.T, legacy bool) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "versions", "2.0.0")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	capabilities := `["control_token","update_check"]`
	if legacy {
		capabilities = `["control_token"]`
	}
	script := `#!/bin/sh
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
case "$1" in
--host-protocol)
	echo '{"protocol":1,"existing_schema":true,"version":"2.0.0","capabilities":` + capabilities + `}'
	exit 0 ;;
--preflight) ;;
*) exit 2 ;;
esac
env | grep -E '^(DB_PATH|APTEVA_UPDATE_[A-Z_]+)=' | sort > "$APTEVA_HOME/check-env"
if [ -n "$APTEVA_UPDATE_PREFLIGHT" ]; then
	# Earlier servers: a full backup and a report next to it, always.
	echo backup > "$APTEVA_UPDATE_PREFLIGHT"
	echo '{"version":"2.0.0","schema_changed":true,"rollback_safe":false}' > "$APTEVA_UPDATE_PREFLIGHT.json"
	exit 0
fi
[ -z "$APTEVA_UPDATE_CHECK_DIR" ] && exit 0
echo "{\"phase\":\"copy\",\"message\":\"Copying the database (1/2)\",\"done\":1,\"total\":2,\"updated_at\":\"$(now)\"}" > "$APTEVA_UPDATE_CHECK_DIR/progress.json"
case "$FAKE_CHECK" in
stall)
	echo partial > "$APTEVA_UPDATE_BACKUP"
	sleep 30 &
	trap 'kill $!; rm -f "$APTEVA_UPDATE_BACKUP"; exit 1' TERM
	wait
	exit 0 ;;
fail) exit 3 ;;
esac
backup=null
if [ "$FAKE_CHECK" = incompatible ] && [ "$APTEVA_UPDATE_BACKUP_WHEN" = incompatible ]; then
	echo backup > "$APTEVA_UPDATE_BACKUP"
	backup="{\"path\":\"$APTEVA_UPDATE_BACKUP\",\"bytes\":7}"
fi
compatible=true; safe=false
[ "$FAKE_CHECK" = incompatible ] && compatible=false
[ "$FAKE_CHECK" = unchanged ] && safe=true
echo "{\"version\":\"2.0.0\",\"schema_hash\":\"h\",\"classification\":\"$FAKE_CHECK\",\"compatible\":$compatible,\"rollback_safe\":$safe,\"reasons\":[\"why\"],\"backup\":$backup,\"duration_ms\":12}" > "$APTEVA_UPDATE_CHECK_DIR/report.json"
`
	if err := os.WriteFile(filepath.Join(dir, "apteva-server"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

func checkJob(t *testing.T, source string) *dashboardUpdateJob {
	t.Helper()
	return &dashboardUpdateJob{ID: "job1", Source: source, State: "preflight", Target: "2.0.0", Previous: "1.0.0"}
}

func TestReleaseCheckBacksUpOnlyIncompatibleUpdates(t *testing.T) {
	for _, mode := range []string{"unchanged", "compatible", "incompatible"} {
		t.Run(mode, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("APTEVA_HOME", home)
			t.Setenv("DB_PATH", "")
			t.Setenv("FAKE_CHECK", mode)
			job := checkJob(t, "cli")
			summary, err := runReleaseCheck(releaseCheckOptions{target: fakeCheckServer(t, false), version: "2.0.0", job: job})
			if err != nil {
				t.Fatal(err)
			}
			if summary.Classification != mode || summary.Compatible != (mode != "incompatible") || summary.RollbackSafe != (mode == "unchanged") {
				t.Fatalf("summary %+v", summary)
			}
			backup := filepath.Join(home, "update-backups", "job1", "apteva.db")
			_, statErr := os.Stat(backup)
			if mode == "incompatible" {
				if summary.Backup != backup || summary.BackupBytes != 7 || statErr != nil {
					t.Fatalf("incompatible update needs its backup: %+v %v", summary, statErr)
				}
			} else if summary.Backup != "" || !os.IsNotExist(statErr) {
				t.Fatalf("no backup expected: %+v %v", summary, statErr)
			}
			if _, err := os.Stat(filepath.Join(home, "update-backups", "job1")); mode != "incompatible" && !os.IsNotExist(err) {
				t.Fatal("empty backup directory left behind")
			}
			env, _ := os.ReadFile(filepath.Join(home, "check-env"))
			for _, want := range []string{"DB_PATH=" + filepath.Join(home, "apteva.db"), "APTEVA_UPDATE_BACKUP_WHEN=incompatible", "APTEVA_UPDATE_CHECK_DIR=" + filepath.Join(home, "update-check", "job1")} {
				if !strings.Contains(string(env), want+"\n") {
					t.Fatalf("check env lacks %s:\n%s", want, env)
				}
			}
			if entries, _ := os.ReadDir(filepath.Join(home, "update-check")); len(entries) != 0 {
				t.Fatal("check directory left behind")
			}
		})
	}
}

func TestReleaseCheckDryRunNeverBacksUp(t *testing.T) {
	home := t.TempDir()
	t.Setenv("APTEVA_HOME", home)
	t.Setenv("FAKE_CHECK", "incompatible")
	summary, err := runReleaseCheck(releaseCheckOptions{target: fakeCheckServer(t, false), version: "2.0.0", full: true})
	if err != nil || summary.Compatible || summary.Backup != "" {
		t.Fatalf("dry run: %+v %v", summary, err)
	}
	env, _ := os.ReadFile(filepath.Join(home, "check-env"))
	if !strings.Contains(string(env), "APTEVA_UPDATE_BACKUP_WHEN=never\n") || !strings.Contains(string(env), "APTEVA_UPDATE_CHECK_FULL=1\n") {
		t.Fatalf("dry run env:\n%s", env)
	}
	if _, err := os.Stat(filepath.Join(home, "update-backups")); !os.IsNotExist(err) {
		t.Fatal("dry run created a backup directory")
	}
}

func TestReleaseCheckStopsWhenProgressStalls(t *testing.T) {
	home := t.TempDir()
	t.Setenv("APTEVA_HOME", home)
	t.Setenv("FAKE_CHECK", "stall")
	old := updateCheckStall
	updateCheckStall = 2 * time.Second
	t.Cleanup(func() { updateCheckStall = old })
	started := time.Now()
	job := checkJob(t, "cli")
	_, err := runReleaseCheck(releaseCheckOptions{target: fakeCheckServer(t, false), version: "2.0.0", job: job})
	if err == nil || !strings.Contains(err.Error(), "no progress") {
		t.Fatalf("stalled check: %v", err)
	}
	if job.Progress == nil || job.Progress.Done != 1 || job.Progress.Total != 2 || !strings.Contains(job.Message, "Copying") {
		t.Fatalf("progress not recorded on the job: %+v %q", job.Progress, job.Message)
	}
	if time.Since(started) > 20*time.Second {
		t.Fatal("stalled check was not stopped promptly")
	}
	if _, err := os.Stat(filepath.Join(home, "update-backups", "job1")); !os.IsNotExist(err) {
		t.Fatal("partial backup left behind")
	}
	if runningCheckPID.Load() != 0 {
		t.Fatal("check still registered as running")
	}
}

func TestReleaseCheckFailureRefusesTheUpdate(t *testing.T) {
	t.Setenv("APTEVA_HOME", t.TempDir())
	t.Setenv("FAKE_CHECK", "fail")
	if _, err := runReleaseCheck(releaseCheckOptions{target: fakeCheckServer(t, false), version: "2.0.0", job: checkJob(t, "cli")}); err == nil {
		t.Fatal("failed check accepted")
	}
	if _, err := runReleaseCheck(releaseCheckOptions{target: fakeCheckServer(t, false), version: "3.0.0", job: checkJob(t, "cli")}); err == nil {
		t.Fatal("report for another release accepted")
	}
}

func TestReleaseCheckOnEarlierServers(t *testing.T) {
	home := t.TempDir()
	t.Setenv("APTEVA_HOME", home)
	target := fakeCheckServer(t, true)
	// A command-line update gets the basic preflight, as before.
	summary, err := runReleaseCheck(releaseCheckOptions{target: target, version: "2.0.0", job: checkJob(t, "cli")})
	if err != nil || summary != nil {
		t.Fatalf("cli on an earlier server: %+v %v", summary, err)
	}
	if env, _ := os.ReadFile(filepath.Join(home, "check-env")); strings.Contains(string(env), "APTEVA_UPDATE_PREFLIGHT=/") {
		t.Fatal("cli asked an earlier server for a full backup")
	}
	// A dashboard update keeps its full check and backup.
	summary, err = runReleaseCheck(releaseCheckOptions{target: target, version: "2.0.0", job: checkJob(t, "")})
	backup := filepath.Join(home, "update-backups", "job1", "apteva.db")
	if err != nil || summary == nil || summary.Compatible || summary.Classification != "incompatible" || summary.Backup != backup {
		t.Fatalf("dashboard on an earlier server: %+v %v", summary, err)
	}
}

func TestRecoveryRestartsPreviousWhenItCanRunOnTheDatabase(t *testing.T) {
	t.Setenv("APTEVA_HOME", t.TempDir())
	// Added columns change the schema, but the previous version still runs.
	j := &dashboardUpdateJob{ID: "test", Source: "cli", Previous: "1.0.0", SchemaChanged: true,
		Check: &updateCheckSummary{Classification: "compatible", Compatible: true}, Request: dashboardUpdateRequest{Port: 5287}}
	flipped := ""
	err := j.recoverActivationWith(scopeUser, os.ErrInvalid,
		func(v string) error { flipped = v; return nil },
		func(serviceScope) error { return nil },
		func(int, string, time.Duration) error { return nil })
	if err == nil || flipped != "1.0.0" || j.State != "rolled_back" || strings.Contains(j.Message, "platform-update.log") {
		t.Fatalf("compatible update was not rolled back: %v %q %s %q", err, flipped, j.State, j.Message)
	}
	j = &dashboardUpdateJob{ID: "test", Previous: "1.0.0", Backup: "/b/apteva.db",
		Check: &updateCheckSummary{Classification: "incompatible"}, Request: dashboardUpdateRequest{Port: 5287}}
	flipped = ""
	_ = j.recoverActivationWith(scopeUser, os.ErrInvalid,
		func(v string) error { flipped = v; return nil },
		func(serviceScope) error { return nil },
		func(int, string, time.Duration) error { return nil })
	if flipped != "" || j.State != "recovery_required" || !strings.Contains(j.Message, "/b/apteva.db") || !strings.Contains(j.Message, "cannot run") {
		t.Fatalf("incompatible update: %q %s %q", flipped, j.State, j.Message)
	}
}

func TestCLIUpdateJobLifecycle(t *testing.T) {
	t.Setenv("APTEVA_HOME", t.TempDir())
	t.Setenv("PORT", "5299")
	job, err := newCLIUpdateJob("2.0.0", "1.0.0", "preserve")
	if err != nil {
		t.Fatal(err)
	}
	saved, err := readUpdateJob()
	if err != nil || saved.Source != "cli" || saved.Target != "2.0.0" || saved.Previous != "1.0.0" || saved.Request.Port != 5299 || job.dashboard() {
		t.Fatalf("cli job: %+v %v", saved, err)
	}
	job.recordCheck(&updateCheckSummary{Classification: "compatible", Compatible: true})
	job.finish(0)
	if saved, _ = readUpdateJob(); saved.State != "succeeded" || saved.Check == nil || saved.Check.Classification != "compatible" {
		t.Fatalf("finished cli job: %+v", saved)
	}
	// A job whose process ended mid-update is closed by the next updater.
	stale := &dashboardUpdateJob{ID: "x", Source: "cli", State: "preflight"}
	settleInterruptedCLIJob(stale)
	if stale.State != "failed" || !strings.Contains(stale.Message, "unchanged") {
		t.Fatalf("interrupted before activation: %+v", stale)
	}
	stale = &dashboardUpdateJob{ID: "x", Source: "cli", State: "restarting", Target: "2.0.0"}
	settleInterruptedCLIJob(stale)
	if stale.State != "failed" || !strings.Contains(stale.Message, "service status") {
		t.Fatalf("interrupted while activating: %+v", stale)
	}
	dashboard := &dashboardUpdateJob{ID: "x", State: "preflight"}
	settleInterruptedCLIJob(dashboard)
	if dashboard.State != "preflight" {
		t.Fatal("a dashboard job was settled by the CLI")
	}
}

func TestRollbackBlockersFollowIncompatibleUpdates(t *testing.T) {
	t.Setenv("APTEVA_HOME", t.TempDir())
	recordUpdateHistory("1.0.0", "1.1.0", &updateCheckSummary{Classification: "compatible", Compatible: true})
	recordUpdateHistory("1.1.0", "1.2.0", &updateCheckSummary{Classification: "incompatible", Backup: "/b/apteva.db"})
	recordUpdateHistory("1.2.0", "1.3.0", &updateCheckSummary{Classification: "unchanged", Compatible: true})
	recordUpdateHistory("1.3.0", "1.3.0", &updateCheckSummary{Classification: "incompatible"})
	recordUpdateHistory("1.3.0", "1.4.0", nil)
	for _, tc := range []struct {
		current, target string
		blocked         bool
	}{
		{"1.3.0", "1.2.0", false}, // after the incompatible update
		{"1.3.0", "1.1.0", true},  // across it
		{"1.3.0", "1.0.0", true},
		{"1.1.0", "1.0.0", false}, // only compatible updates in between
		{"1.2.0", "1.1.0", true},
	} {
		blockers := rollbackBlockers(tc.current, tc.target)
		if (len(blockers) > 0) != tc.blocked {
			t.Fatalf("%s -> %s: blockers %+v", tc.current, tc.target, blockers)
		}
		if tc.blocked && (blockers[0].From != "1.1.0" || blockers[0].Backup != "/b/apteva.db") {
			t.Fatalf("wrong blocker %+v", blockers[0])
		}
	}
	if len(readUpdateHistory()) != 3 {
		t.Fatalf("history kept entries it should not: %+v", readUpdateHistory())
	}
}

func TestPruneUpdateBackupsKeepsTheNewest(t *testing.T) {
	home := t.TempDir()
	t.Setenv("APTEVA_HOME", home)
	root := filepath.Join(home, "update-backups")
	for i, name := range []string{"old", "newer", "host-x"} {
		dir := filepath.Join(root, name)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		at := time.Now().Add(time.Duration(i-3) * time.Hour)
		_ = os.Chtimes(dir, at, at)
	}
	pruneUpdateBackups("")
	entries, _ := os.ReadDir(root)
	if len(entries) != 1 || entries[0].Name() != "host-x" {
		t.Fatalf("kept %v", entries)
	}
	pruneUpdateBackups(filepath.Join(root, "missing", "apteva.db"))
	if entries, _ := os.ReadDir(root); len(entries) != 0 {
		t.Fatalf("named backup should be the only one kept, got %v", entries)
	}
}
