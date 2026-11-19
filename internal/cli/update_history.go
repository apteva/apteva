package cli

// What an update's database check found, and the history of updates whose
// result an earlier release cannot run on. Shared by every platform build;
// the check itself runs in update_check.go.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// updateCheckSummary is what the job, the dashboard and the update history
// keep from the server's check report.
type updateCheckSummary struct {
	// unchanged, compatible or incompatible
	Classification string   `json:"classification"`
	Compatible     bool     `json:"compatible"`
	RollbackSafe   bool     `json:"rollback_safe"`
	SchemaChanged  bool     `json:"schema_changed,omitempty"`
	Reasons        []string `json:"reasons,omitempty"`
	Backup         string   `json:"backup,omitempty"`
	BackupBytes    int64    `json:"backup_bytes,omitempty"`
	SampledTables  []string `json:"sampled_tables,omitempty"`
	FullTables     []string `json:"full_tables,omitempty"`
	DurationMS     int64    `json:"duration_ms,omitempty"`
}

type updateJobProgress struct {
	Phase string `json:"phase"`
	Done  int64  `json:"done"`
	Total int64  `json:"total"`
}

func describeCheck(s *updateCheckSummary) string {
	if s == nil {
		return "database check unavailable for this release"
	}
	var b strings.Builder
	switch s.Classification {
	case "unchanged":
		b.WriteString("database check: this release changes no stored data")
	case "compatible":
		b.WriteString("database check: this release adds to the database; the previous version can still run on it")
	default:
		b.WriteString("database check: this release migrates the database in a way the previous version cannot use")
		if len(s.Reasons) > 0 {
			b.WriteString(" (" + strings.Join(s.Reasons, "; ") + ")")
		}
	}
	if s.Backup != "" {
		fmt.Fprintf(&b, "; backup: %s", s.Backup)
	}
	if s.DurationMS > 0 {
		fmt.Fprintf(&b, "; %.1fs", float64(s.DurationMS)/1000)
	}
	return b.String()
}

// sweepUpdateChecks removes check directories left by checks that did not
// finish.
func sweepUpdateChecks(root string) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if info, err := entry.Info(); err == nil && time.Since(info.ModTime()) > time.Hour {
			_ = os.RemoveAll(filepath.Join(root, entry.Name()))
		}
	}
}

// pruneUpdateBackups runs after a successful update. When that update took
// its own backup (keep, a non-empty file), backups of earlier updates are
// removed. Otherwise every backup stays: the newest existing one may still be
// the only way back across an earlier incompatible update.
func pruneUpdateBackups(keep string) {
	keepDir := filepath.Dir(keep)
	if info, err := os.Stat(keep); err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
		// Only an empty directory left by a check that took no backup.
		_ = os.Remove(keepDir)
		return
	}
	root := filepath.Dir(keepDir)
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		dir := filepath.Join(root, entry.Name())
		if entry.IsDir() && dir != keepDir {
			_ = os.RemoveAll(dir)
		}
	}
}

// ---- update history -----------------------------------------------------

// updateHistoryEntry records one release change and whether the release it
// replaced can still run on the database afterwards.
type updateHistoryEntry struct {
	From           string    `json:"from"`
	To             string    `json:"to"`
	At             time.Time `json:"at"`
	Classification string    `json:"classification"`
	Compatible     bool      `json:"compatible"`
	Backup         string    `json:"backup,omitempty"`
}

func updateHistoryPath() string { return filepath.Join(aptevaDir(), "update-history.json") }

func readUpdateHistory() []updateHistoryEntry {
	raw, err := os.ReadFile(updateHistoryPath())
	if err != nil {
		return nil
	}
	var entries []updateHistoryEntry
	_ = json.Unmarshal(raw, &entries)
	return entries
}

// recordUpdateHistory records an update. Without a check summary (a release
// server older than the database check) the update is recorded as unknown:
// nothing says whether the release it replaced can still run afterwards.
func recordUpdateHistory(from, to string, s *updateCheckSummary) {
	if from == "" || to == "" || from == to {
		return
	}
	entry := updateHistoryEntry{From: from, To: to, At: time.Now().UTC(), Classification: "unknown"}
	if s != nil {
		entry.Classification, entry.Compatible, entry.Backup = s.Classification, s.Compatible, s.Backup
	}
	entries := append(readUpdateHistory(), entry)
	if len(entries) > 50 {
		entries = entries[len(entries)-50:]
	}
	raw, err := json.MarshalIndent(entries, "", "  ")
	if err == nil {
		tmp := updateHistoryPath() + ".tmp"
		if err = os.WriteFile(tmp, raw, 0o600); err == nil {
			err = os.Rename(tmp, updateHistoryPath())
		}
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "warning: could not record update history: %v\n", err)
	}
}

// rollbackBlockers lists recorded updates between target and current that the
// target release cannot run after, or may not (unknown: no check ran):
// rolling back past them needs the backup.
func rollbackBlockers(current, target string) []updateHistoryEntry {
	var blockers []updateHistoryEntry
	for _, e := range readUpdateHistory() {
		if e.Compatible || e.To == "" || e.From == "" {
			continue
		}
		// Releases up to e.From cannot run after the update (target <=
		// e.From), and the update is in effect (e.To <= current).
		if semverGreater(target, e.From) || semverGreater(e.To, current) {
			continue
		}
		blockers = append(blockers, e)
	}
	return blockers
}

// rollbackUnrecorded returns the version whose arrival the history cannot
// account for on the way from current back to target. Updates made by an
// older CLI, by apteva-host from the dashboard, or by Fleet leave no record,
// so the history cannot say whether target still runs on this database.
// It follows the most recent recorded update into each version, newest
// first, until it reaches target or a version below it.
func rollbackUnrecorded(current, target string) (string, bool) {
	history := readUpdateHistory()
	at := current
	for semverGreater(at, target) {
		found := false
		for i := len(history) - 1; i >= 0; i-- {
			e := history[i]
			if e.To == at && e.From != "" && semverGreater(at, e.From) {
				at, found = e.From, true
				break
			}
		}
		if !found {
			return at, true
		}
	}
	return "", false
}
