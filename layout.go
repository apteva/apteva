package main

// layout.go — versioned-directory layout for the local apteva install.
//
// Pre-v0.12: binaries lived flat in the npm package dir, with a
// per-version cache at ~/.apteva/bin/<v>/. `apteva update` did a
// destructive in-place swap. Bad for systemd (fights Restart=on-
// failure), bad for foreground (no rollback if the new binary
// crashes), and the directory name lied after an update.
//
// v0.12+: Homebrew-Cellar shape. Binaries live in
// ~/.apteva/versions/<v>/. A two-level symlink chain
//
//     ~/.apteva/bin/apteva       → current/apteva
//     ~/.apteva/bin/apteva-server → current/apteva-server
//     ~/.apteva/bin/apteva-core  → current/apteva-core
//     ~/.apteva/bin/current      → ../versions/<v>
//
// keeps PATH stable through atomic version flips. Updating means
// extract → preflight → flip `current` → SIGTERM → exit-11. Rollback
// is just flipping `current` back at a prior version still on disk.
//
// This file owns:
//   - canonical paths (versionsDir, binDir, currentLink, …)
//   - symlink writers for the layout
//   - one-shot migration from the v0.11.x cache layout
//   - boot-status tracking for auto-revert on failed boot

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// versionsDir is ~/.apteva/versions (or APTEVA_HOME/versions).
func versionsDir() string {
	return filepath.Join(aptevaDir(), "versions")
}

// binDir is ~/.apteva/bin — holds the per-binary symlinks (apteva,
// apteva-server, apteva-core) plus the load-bearing "current"
// symlink. Stable across upgrades; this is what systemd's ExecStart
// and the npm cli.js shim point at.
func binDir() string {
	return filepath.Join(aptevaDir(), "bin")
}

// currentLink is binDir/current — a relative symlink whose target is
// the active versions/<v>/ directory. Updates flip this atomically.
func currentLink() string {
	return filepath.Join(binDir(), "current")
}

// releasesDir caches downloaded tarballs so a flake mid-update can
// resume without re-downloading. Cleaned by `apteva update --gc`.
func releasesDir() string {
	return filepath.Join(aptevaDir(), "releases")
}

// versionDir returns the directory the given version's binaries
// extract into: versions/<v>/.
func versionDir(version string) string {
	return filepath.Join(versionsDir(), version)
}

// binNames is the canonical set of binaries each version dir holds.
// Order matters for symlink rebuild: apteva first so foreground
// users get an executable shim even if a partial extract didn't
// produce the others.
var binNames = []string{"apteva", "apteva-server", "apteva-core", "apteva-mcp-runner"}

// resolveBin returns the path inside binDir() for a given binary
// name — e.g. resolveBin("apteva-server") → ~/.apteva/bin/apteva-server.
// Always a symlink target; the real file lives under
// versions/<v>/<name>.
func resolveBin(name string) string {
	return filepath.Join(binDir(), name)
}

// installedVersions returns every version directory present under
// versions/, newest first by semver. Used for `apteva versions`,
// rollback target picking, and pruning.
func installedVersions() ([]string, error) {
	entries, err := os.ReadDir(versionsDir())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		// Only directories that actually contain at least the apteva
		// binary count — half-extracted dirs from a crashed update
		// shouldn't show up as rollback targets.
		if _, err := os.Stat(filepath.Join(versionsDir(), e.Name(), "apteva")); err != nil {
			continue
		}
		out = append(out, e.Name())
	}
	sort.Slice(out, func(i, j int) bool { return semverGreater(out[i], out[j]) })
	return out, nil
}

// activeVersion returns the version `bin/current` currently points
// at, or "" if no symlink is set up yet (e.g. pre-migration v0.11.x
// install whose binaries are in the npm package dir).
func activeVersion() string {
	target, err := os.Readlink(currentLink())
	if err != nil {
		return ""
	}
	// We always write the link as relative ("../versions/<v>") to
	// keep ~/.apteva portable across moves. Take the basename either
	// way.
	return filepath.Base(target)
}

// ensureLayout creates ~/.apteva, versions/, bin/, releases/ if any
// are missing. Idempotent — safe to call on every command. Doesn't
// touch the symlinks; that's pointSymlinks' job once a version dir
// is populated.
func ensureLayout() error {
	for _, d := range []string{versionsDir(), binDir(), releasesDir()} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return fmt.Errorf("mkdir %s: %w", d, err)
		}
	}
	return nil
}

// pointSymlinks atomically (re)points the layout's symlinks at the
// given version. Sequence:
//
//  1. Write a temp symlink "current.tmp" → ../versions/<v>
//  2. os.Rename the temp onto current (POSIX-atomic on same fs)
//  3. Recreate each per-binary shim: bin/<name> → current/<name>
//
// Step 2 is the load-bearing atomic flip. Step 3 just keeps the
// per-binary shims valid; they don't need to be atomic because they
// resolve through `current` anyway, but having them as concrete
// symlinks (rather than chasing through `current/`) keeps `which
// apteva-server` output legible.
func pointSymlinks(version string) error {
	if version == "" {
		return errors.New("pointSymlinks: empty version")
	}
	vdir := versionDir(version)
	if _, err := os.Stat(vdir); err != nil {
		return fmt.Errorf("version dir missing: %s", vdir)
	}

	if err := ensureLayout(); err != nil {
		return err
	}

	// Always write `current` as a relative path so the whole tree
	// can be moved without breaking. ../versions/<v> is interpreted
	// relative to the link itself (which lives in bin/).
	relTarget := filepath.Join("..", "versions", version)
	tmp := currentLink() + ".tmp"
	_ = os.Remove(tmp)
	if err := os.Symlink(relTarget, tmp); err != nil {
		return fmt.Errorf("symlink current.tmp: %w", err)
	}
	if err := os.Rename(tmp, currentLink()); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("rename current: %w", err)
	}

	// Per-binary shims point at current/<name>. Replace them every
	// time so a missing one (e.g. v0.12.0 install that ships a new
	// binary v0.13.0 doesn't) is fixed up by the next pointSymlinks.
	for _, name := range binNames {
		dst := resolveBin(name)
		_ = os.Remove(dst)
		// Relative target: bin/<name> → current/<name> resolves the
		// same regardless of bin/'s absolute path.
		if err := os.Symlink(filepath.Join("current", name), dst); err != nil {
			return fmt.Errorf("symlink %s: %w", name, err)
		}
	}
	return nil
}

// pruneVersions deletes every version dir except the `keep` newest
// AND `protect` (typically the active version + any version we just
// flipped to but haven't yet confirmed healthy). Returns the list of
// removed versions for logging.
func pruneVersions(keep int, protect ...string) ([]string, error) {
	if keep < 1 {
		keep = 1
	}
	all, err := installedVersions()
	if err != nil {
		return nil, err
	}
	keepSet := map[string]bool{}
	for _, v := range protect {
		if v != "" {
			keepSet[v] = true
		}
	}
	for i, v := range all {
		if i < keep {
			keepSet[v] = true
		}
	}
	var removed []string
	for _, v := range all {
		if keepSet[v] {
			continue
		}
		if err := os.RemoveAll(versionDir(v)); err == nil {
			removed = append(removed, v)
		}
	}
	return removed, nil
}

// migrateLegacyLayout is the v0.11.x → v0.12.0 one-shot. Pre-v0.12
// `apteva` (the npm shim) downloaded each tarball into
// ~/.apteva/bin/<v>/<binaries>. We promote those into the new
// versions/<v>/ shape and set up the symlinks pointing at the
// largest-semver version found.
//
// Idempotent: if no legacy dirs exist OR everything's already
// migrated, returns nil with no side effects. Safe to run on every
// `apteva` invocation.
func migrateLegacyLayout() error {
	legacyBin := binDir()
	entries, err := os.ReadDir(legacyBin)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}

	// Collect candidate legacy version dirs: bin/<v>/ where <v>
	// contains an apteva binary. Skip any entry that's already a
	// symlink (the new layout's per-binary shims) or our `current`
	// link or `releases`. Also skip entries that don't look like a
	// semver — operators sometimes drop tarballs into bin/ by hand.
	var legacyVersions []string
	for _, e := range entries {
		name := e.Name()
		if name == "current" || name == "releases" {
			continue
		}
		full := filepath.Join(legacyBin, name)
		info, err := os.Lstat(full)
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		if !info.IsDir() {
			continue
		}
		if !looksLikeSemver(name) {
			continue
		}
		if _, err := os.Stat(filepath.Join(full, "apteva")); err != nil {
			continue
		}
		legacyVersions = append(legacyVersions, name)
	}

	if len(legacyVersions) == 0 {
		return nil
	}

	if err := ensureLayout(); err != nil {
		return err
	}

	for _, v := range legacyVersions {
		oldDir := filepath.Join(legacyBin, v)
		newDir := versionDir(v)
		if _, err := os.Stat(newDir); err == nil {
			// Already migrated this version — just clean up the
			// legacy one. RemoveAll is safe; the binaries we care
			// about are in newDir.
			_ = os.RemoveAll(oldDir)
			continue
		}
		// Cross-fs rename can fail (e.g. ~/.apteva on a different
		// volume than $TMPDIR is irrelevant here, but Docker
		// bind-mounts have surprised us before). Try rename, fall
		// back to recursive copy.
		if err := os.Rename(oldDir, newDir); err != nil {
			if err := copyDir(oldDir, newDir); err != nil {
				return fmt.Errorf("migrate %s: %w", v, err)
			}
			_ = os.RemoveAll(oldDir)
		}
	}

	// Point `current` at the highest-semver migrated version. If
	// `current` already exists and points somewhere valid, leave it
	// alone — operator may have manually rolled back.
	if _, err := os.Lstat(currentLink()); err == nil {
		return nil
	}
	all, err := installedVersions()
	if err != nil || len(all) == 0 {
		return err
	}
	return pointSymlinks(all[0])
}

// looksLikeSemver: cheap "could this be x.y.z" check. Doesn't
// validate strictly — semverGreater handles weird inputs gracefully.
func looksLikeSemver(s string) bool {
	parts := strings.Split(strings.SplitN(s, "-", 2)[0], ".")
	if len(parts) < 2 || len(parts) > 4 {
		return false
	}
	for _, p := range parts {
		if p == "" {
			return false
		}
		if _, err := strconv.Atoi(p); err != nil {
			return false
		}
	}
	return true
}

// semverGreater returns true if a > b under numeric semver ordering.
// Pre-release / build suffixes are ignored. Mirrors the helper in
// server/platform_status.go — kept duplicated rather than shared
// because the CLI and server live in separate go.mod trees.
func semverGreater(a, b string) bool {
	strip := func(s string) string {
		for _, sep := range []string{"-", "+"} {
			if i := strings.Index(s, sep); i >= 0 {
				s = s[:i]
			}
		}
		return s
	}
	ap := strings.Split(strip(a), ".")
	bp := strings.Split(strip(b), ".")
	n := len(ap)
	if len(bp) > n {
		n = len(bp)
	}
	for i := 0; i < n; i++ {
		var av, bv string
		if i < len(ap) {
			av = ap[i]
		}
		if i < len(bp) {
			bv = bp[i]
		}
		ai, aerr := strconv.Atoi(av)
		bi, berr := strconv.Atoi(bv)
		if aerr == nil && berr == nil {
			if ai != bi {
				return ai > bi
			}
			continue
		}
		if av != bv {
			return av > bv
		}
	}
	return false
}

// copyDir is the cross-device fallback for migrateLegacyLayout. Not
// performance-critical — runs once per legacy install, on a few
// MB of binaries. Doesn't preserve symlinks; release tarballs are
// flat regular files anyway.
func copyDir(src, dst string) error {
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	for _, e := range entries {
		s := filepath.Join(src, e.Name())
		d := filepath.Join(dst, e.Name())
		if e.IsDir() {
			if err := copyDir(s, d); err != nil {
				return err
			}
			continue
		}
		if err := copyFileWithMode(s, d); err != nil {
			return err
		}
	}
	return nil
}

func copyFileWithMode(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, info.Mode())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// ─── Boot status / auto-rollback ────────────────────────────────────
//
// The contract:
//
//   - On every apteva-server start, the server increments
//     bootAttemptsFile.
//   - Once the server passes a /health check ~30s into running, it
//     writes lastGoodVersionFile = active version and resets the
//     attempts counter to 0.
//   - On apteva-server start, BEFORE bumping the counter, it reads
//     it; if it's already ≥ rollbackThreshold AND the active
//     version != lastGood, the server refuses to start, the CLI
//     re-points `current` at lastGood, and re-execs the supervisor.
//
// This handles the systemd Restart=on-failure storm: a new binary
// that crashes immediately gets retried 3 times, then auto-reverts.

const rollbackThreshold = 3

func bootAttemptsFile() string    { return filepath.Join(aptevaDir(), "boot-attempts") }
func lastGoodVersionFile() string { return filepath.Join(aptevaDir(), "last-good-version") }

// readBootAttempts returns the count, defaulting to 0 on any error.
func readBootAttempts() int {
	b, err := os.ReadFile(bootAttemptsFile())
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.TrimSpace(string(b)))
	return n
}

func writeBootAttempts(n int) error {
	return os.WriteFile(bootAttemptsFile(), []byte(strconv.Itoa(n)), 0o644)
}

func readLastGoodVersion() string {
	b, err := os.ReadFile(lastGoodVersionFile())
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func writeLastGoodVersion(v string) error {
	return os.WriteFile(lastGoodVersionFile(), []byte(v), 0o644)
}

// rollbackIfFailed is the auto-revert hook. Called by the CLI before
// every spawn of the active server. Returns the version that ended
// up active (possibly after a revert) and a human-readable note for
// logging if a revert happened.
func rollbackIfFailed() (active string, note string) {
	active = activeVersion()
	if active == "" {
		return "", ""
	}
	attempts := readBootAttempts()
	if attempts < rollbackThreshold {
		return active, ""
	}
	lastGood := readLastGoodVersion()
	if lastGood == "" || lastGood == active {
		// No safe target. Reset the counter so the user can
		// foreground-debug without an infinite revert loop.
		_ = writeBootAttempts(0)
		return active, ""
	}
	if _, err := os.Stat(versionDir(lastGood)); err != nil {
		// Last-good was pruned (operator ran a third-party cleanup,
		// or our pruner over-pruned). Same story — give up the
		// revert; the operator will see the failure on the next
		// foreground run.
		_ = writeBootAttempts(0)
		return active, ""
	}
	if err := pointSymlinks(lastGood); err != nil {
		return active, fmt.Sprintf("auto-rollback to %s failed: %v", lastGood, err)
	}
	_ = writeBootAttempts(0)
	return lastGood, fmt.Sprintf("auto-rolled back to v%s after %d failed boots of v%s", lastGood, attempts, active)
}
