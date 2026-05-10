package main

// `apteva update` — fetch the latest published bundle (CLI + server
// + core), verify it, install it alongside the running version, and
// flip the load-bearing `bin/current` symlink. Triggers a graceful
// drain on the running stack via SIGTERM; the supervisor (systemd /
// launchd) or parent CLI re-execs through the now-flipped symlink.
//
// Source of truth: apteva/version.json on raw.githubusercontent.com.
// Each release bumps it via the workflow's "Update version.json on
// main" step (see apteva/.github/workflows/release.yml).
//
// This replaces the pre-v0.12 destructive in-place swap, which:
//   - lied about the directory name after upgrade (bin/0.10.0/ now
//     contains 0.11.0 binaries)
//   - had no rollback (the .bak rename was per-binary, not
//     per-version, and got overwritten on the next update)
//   - fought systemd Restart=on-failure (kill → restart race against
//     binary replacement; "text file busy" on Linux)
//
// New flow: extract → preflight → atomic symlink flip → SIGTERM →
// exit 11 → supervisor re-execs. Old version dir stays on disk
// (pruned to last 3); rollback is `apteva rollback`.

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	osexec "os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const versionManifestURL = "https://raw.githubusercontent.com/apteva/apteva/main/version.json"

// versionManifest is the schema apteva/version.json publishes. Add
// fields as needed; readers ignore unknown keys.
type versionManifest struct {
	Schema          string                       `json:"schema"`
	Version         string                       `json:"version"`
	ReleasedAt      string                       `json:"released_at"`
	ReleaseNotesURL string                       `json:"release_notes_url"`
	Components      map[string]string            `json:"components"`
	Artifacts       map[string]artifactReference `json:"artifacts"`
}

type artifactReference struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size,omitempty"`
}

// installMethod is how the running apteva binary reached disk.
// Each method has a different update path; only `installStandalone`
// (and its cousin `installVersioned`) actually run the swap path —
// the rest defer to whatever package manager / build system put
// the binaries there.
type installMethod int

const (
	installUnknown    installMethod = iota
	installNpx                      // ~/.npm/_npx/<hash>/node_modules/apteva/
	installNpmGlobal                // npm install -g apteva
	installDocker                   // /.dockerenv exists
	installSource                   // sibling-path build (server/, core/ alongside)
	installVersioned                // ~/.apteva/bin/current symlink chain (the new layout)
	installStandalone               // raw tarball extracted somewhere (legacy or third-party)
	installPackaged                 // dpkg/rpm-owned (someone packaged us)
)

func cmdUpdate(args []string) int {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	check := fs.Bool("check", false, "show what would update without applying")
	yes := fs.Bool("yes", false, "skip the confirmation prompt")
	dryRun := fs.Bool("dry-run", false, "download + verify + preflight, but skip the symlink flip")
	keepN := fs.Int("keep", 3, "number of prior versions to keep on disk")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	// One-shot migration from v0.11.x layout. Idempotent — does
	// nothing on already-migrated installs. Has to run BEFORE we
	// decide install method, since the migration is what makes the
	// `bin/current` symlink exist.
	if err := migrateLegacyLayout(); err != nil {
		fmt.Fprintf(os.Stderr, "warning: legacy-layout migration failed: %v\n", err)
		fmt.Fprintln(os.Stderr, "(continuing — `apteva update` will work on a fresh layout)")
	}

	fmt.Fprintf(os.Stderr, "current: v%s\n", Version)
	fmt.Fprintln(os.Stderr, "fetching version manifest…")

	m, err := fetchVersionManifest(versionManifestURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to fetch manifest: %v\n", err)
		return 1
	}
	if m.Version == "" {
		fmt.Fprintln(os.Stderr, "manifest missing version field")
		return 1
	}

	// Semver-aware compare. The pre-v0.12.3 path used string
	// equality, which would offer to "update" v0.12.1 → v0.12.0
	// the moment version.json went stale (a regression we lived
	// through twice). semverGreater is in layout.go.
	if Version == m.Version || (Version != "dev" && semverGreater(Version, m.Version)) {
		if Version == m.Version {
			fmt.Fprintf(os.Stderr, "already on latest (v%s)\n", Version)
		} else {
			fmt.Fprintf(os.Stderr, "running v%s, manifest says v%s — already ahead, nothing to do.\n", Version, m.Version)
			fmt.Fprintln(os.Stderr, "(if the manifest looks wrong, the dashboard's update banner reads from the same file at")
			fmt.Fprintln(os.Stderr, " https://raw.githubusercontent.com/apteva/apteva/main/version.json — file an issue if it's stale.)")
		}
		return 0
	}

	fmt.Fprintln(os.Stderr)
	fmt.Fprintf(os.Stderr, "  update available: v%s → v%s\n", Version, m.Version)
	if m.ReleaseNotesURL != "" {
		fmt.Fprintf(os.Stderr, "  release notes:    %s\n", m.ReleaseNotesURL)
	}
	if len(m.Components) > 0 {
		fmt.Fprintln(os.Stderr, "  bundled component versions:")
		for _, c := range []string{"apteva", "apteva-server", "apteva-core", "apteva-dashboard", "apteva-integrations"} {
			if v := m.Components[c]; v != "" {
				fmt.Fprintf(os.Stderr, "    %-22s %s\n", c, v)
			}
		}
	}
	fmt.Fprintln(os.Stderr)

	if *check {
		return 0
	}

	method := detectInstallMethod()
	switch method {
	case installNpx, installNpmGlobal:
		fmt.Fprintln(os.Stderr, "this looks like an npm install — run:")
		fmt.Fprintln(os.Stderr, "    npm install -g apteva@latest")
		return 1
	case installDocker:
		fmt.Fprintln(os.Stderr, "this looks like a Docker install — pull the new image:")
		fmt.Fprintln(os.Stderr, "    docker pull apteva:latest")
		fmt.Fprintln(os.Stderr, "    docker compose up -d")
		return 1
	case installSource:
		fmt.Fprintln(os.Stderr, "this looks like a source build (sibling server/ and core/ dirs).")
		fmt.Fprintln(os.Stderr, "`apteva update` won't overwrite a working tree — pull and rebuild:")
		fmt.Fprintln(os.Stderr, "    cd <your monorepo> && git pull && ./scripts/build-local.sh")
		return 1
	case installPackaged:
		fmt.Fprintln(os.Stderr, "this binary appears to be managed by a system package — use your package manager:")
		fmt.Fprintln(os.Stderr, "    apt upgrade apteva   # or yum / dnf / pacman")
		return 1
	case installVersioned, installStandalone:
		// continue
	default:
		fmt.Fprintln(os.Stderr, "couldn't identify install method; refusing to overwrite anything.")
		return 1
	}

	artKey := runtime.GOOS + "-" + runtime.GOARCH
	art, ok := m.Artifacts[artKey]
	if !ok || art.URL == "" {
		fmt.Fprintf(os.Stderr, "no artifact in manifest for %s\n", artKey)
		fmt.Fprintln(os.Stderr, "available platforms:")
		for k := range m.Artifacts {
			fmt.Fprintf(os.Stderr, "  %s\n", k)
		}
		return 1
	}

	if !*yes {
		fmt.Fprint(os.Stderr, "proceed? [y/N] ")
		var ans string
		fmt.Scanln(&ans)
		if !(ans == "y" || ans == "Y" || ans == "yes") {
			fmt.Fprintln(os.Stderr, "cancelled.")
			return 0
		}
	}

	if err := ensureLayout(); err != nil {
		fmt.Fprintf(os.Stderr, "ensureLayout: %v\n", err)
		return 1
	}

	// 1. Download into ~/.apteva/releases/. Cached so a flake mid-
	//    update can resume without re-downloading.
	tarballName := fmt.Sprintf("apteva-%s-%s-%s.tar.gz", m.Version, runtime.GOOS, runtime.GOARCH)
	tarball := filepath.Join(releasesDir(), tarballName)
	needsDownload := true
	if _, err := os.Stat(tarball); err == nil && art.SHA256 != "" {
		// Cached file present — verify before reusing.
		if err := verifySHA256(tarball, art.SHA256); err == nil {
			fmt.Fprintln(os.Stderr, "using cached download (sha256 verified)")
			needsDownload = false
		}
	}
	if needsDownload {
		fmt.Fprintf(os.Stderr, "downloading %s\n", art.URL)
		if err := downloadFile(art.URL, tarball); err != nil {
			fmt.Fprintf(os.Stderr, "download failed: %v\n", err)
			return 1
		}
		if art.SHA256 != "" {
			fmt.Fprintln(os.Stderr, "verifying sha256…")
			if err := verifySHA256(tarball, art.SHA256); err != nil {
				fmt.Fprintf(os.Stderr, "checksum mismatch: %v\n", err)
				return 1
			}
		} else {
			fmt.Fprintln(os.Stderr, "warning: manifest has no sha256 — skipping verification")
		}
	}

	// 2. Extract into versions/<new>/. If a partial extraction is
	//    sitting there from a crashed earlier attempt, wipe it
	//    first — checksumming protected the bytes, so the only
	//    thing on disk we need to worry about is half-extracted
	//    files.
	target := versionDir(m.Version)
	_ = os.RemoveAll(target)
	if err := os.MkdirAll(target, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "mkdir %s: %v\n", target, err)
		return 1
	}
	fmt.Fprintln(os.Stderr, "extracting…")
	if err := extractTarGz(tarball, target); err != nil {
		fmt.Fprintf(os.Stderr, "extract failed: %v\n", err)
		_ = os.RemoveAll(target)
		return 1
	}

	// 3. Sanity check: the three binaries must be present.
	for _, name := range binNames {
		p := filepath.Join(target, name)
		if _, err := os.Stat(p); err != nil {
			fmt.Fprintf(os.Stderr, "extracted bundle missing %s\n", name)
			_ = os.RemoveAll(target)
			return 1
		}
		// Tar's permission bits sometimes lose the +x; force it.
		_ = os.Chmod(p, 0o755)
	}

	// 4. Preflight — run apteva-server --preflight against the new
	//    binary. Loads config, runs DB migrations dry, opens an
	//    ephemeral port, exits 0. Catches the "new binary won't
	//    even boot" class of failure BEFORE we flip the symlink.
	fmt.Fprintln(os.Stderr, "preflight…")
	preflight := osexec.Command(filepath.Join(target, "apteva-server"), "--preflight")
	preflight.Env = append(os.Environ(), "APTEVA_HOME="+aptevaDir())
	preflight.Stdout = os.Stderr
	preflight.Stderr = os.Stderr
	if err := preflight.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "preflight failed: %v\n", err)
		fmt.Fprintln(os.Stderr, "(new version not activated — old version still in use)")
		return 1
	}

	if *dryRun {
		fmt.Fprintf(os.Stderr, "dry run: extracted to %s, preflight ok, NOT flipping bin/current.\n", target)
		return 0
	}

	// 5. Atomic flip. pointSymlinks writes a temp symlink and
	//    renames it onto `current` — POSIX-atomic on the same
	//    filesystem.
	prior := activeVersion()
	fmt.Fprintf(os.Stderr, "activating v%s…\n", m.Version)
	if err := pointSymlinks(m.Version); err != nil {
		fmt.Fprintf(os.Stderr, "activate failed: %v\n", err)
		return 1
	}

	// Reset the boot-attempts counter so the new version gets a
	// clean budget; auto-revert won't kick in until /health
	// success has had a chance to write last-good.
	_ = writeBootAttempts(0)

	// 6. Restart the running stack so the new binary is what's
	//    serving requests. Three flavors:
	//
	//    a. Service install (systemd/launchd): supervisor owns the
	//       restart. We send `systemctl restart` (or launchctl
	//       kickstart) — same idempotent path as `apteva service
	//       restart`. The supervisor re-execs through bin/current.
	//
	//    b. Foreground stack already up on this host (someone is
	//       running `apteva` in another terminal): SIGTERM the
	//       server, let the parent CLI catch the child exit and
	//       re-spawn. Same `stopRunningStack` path that pre-v0.12
	//       used, just on top of a versioned layout now.
	//
	//    c. Nothing running: nothing to restart. Operator next
	//       runs `apteva` and it picks up the new version
	//       automatically.
	if scope, ok := detectInstalledScope(); ok {
		fmt.Fprintln(os.Stderr, "  restarting service…")
		if err := restartServiceForRollback(scope); err != nil {
			fmt.Fprintf(os.Stderr, "service restart returned %v — check `apteva service status`\n", err)
		}
	} else if isStackRunning() {
		fmt.Fprintln(os.Stderr, "  draining running stack…")
		stopRunningStack()
		fmt.Fprintln(os.Stderr, "  re-run `apteva` to start with v"+m.Version+".")
	}

	// 7. Prune. Keep `--keep` newest plus the active one and the
	//    prior we just rolled forward from (so manual rollback
	//    has somewhere to land).
	if removed, err := pruneVersions(*keepN, prior, m.Version); err == nil && len(removed) > 0 {
		fmt.Fprintf(os.Stderr, "  pruned old versions: %s\n", strings.Join(removed, ", "))
	}

	fmt.Fprintf(os.Stderr, "\n  apteva updated to v%s.\n", m.Version)
	if prior != "" {
		fmt.Fprintf(os.Stderr, "  rollback: apteva rollback %s\n", prior)
	}
	fmt.Fprintln(os.Stderr)
	return 0
}

// fetchVersionManifest GETs the version manifest. Short timeout —
// this runs on the user's interactive path; better to fail fast than
// hang for 30s on a flaky network.
func fetchVersionManifest(url string) (*versionManifest, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d from %s", resp.StatusCode, url)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	var m versionManifest
	if err := json.Unmarshal(body, &m); err != nil {
		return nil, fmt.Errorf("manifest unmarshal: %w", err)
	}
	return &m, nil
}

// detectInstallMethod inspects the running binary's path and a few
// environmental tells to classify how apteva got onto disk.
// Conservative — when in doubt returns installUnknown so we refuse
// the swap rather than corrupting an install we don't understand.
func detectInstallMethod() installMethod {
	self, err := os.Executable()
	if err != nil {
		return installUnknown
	}
	resolved, _ := filepath.EvalSymlinks(self)
	if resolved == "" {
		resolved = self
	}

	if _, err := os.Stat("/.dockerenv"); err == nil {
		return installDocker
	}
	if strings.Contains(resolved, "/_npx/") {
		return installNpx
	}
	if strings.Contains(resolved, "node_modules/apteva") {
		return installNpmGlobal
	}

	// Source build: the build-local.sh layout puts each binary
	// inside its own component dir, so apteva's parent has a
	// sibling `server/` and `core/` directory.
	dir := filepath.Dir(resolved)
	parent := filepath.Dir(dir)
	if hasDir(filepath.Join(parent, "server")) && hasDir(filepath.Join(parent, "core")) &&
		hasDir(filepath.Join(parent, "app-sdk")) {
		return installSource
	}

	// Distro-packaged binaries usually live under /usr/{,local}/bin
	// or are owned by dpkg/rpm. dpkg -S / rpm -qf are the
	// authoritative checks; running them is fast (single-digit ms).
	// If either claims ownership, refuse the swap and tell the
	// operator to use their package manager.
	if isPackagedBinary(resolved) {
		return installPackaged
	}

	// Versioned layout: the resolved binary lives under
	// ~/.apteva/versions/<v>/. That's the v0.12+ shape and the
	// happy path for `apteva update`.
	if isInsideVersionsDir(resolved) {
		return installVersioned
	}

	return installStandalone
}

// isInsideVersionsDir is true iff `path` is somewhere under
// aptevaDir()/versions/. We use string prefix rather than chasing
// up the directory tree because aptevaDir is canonical and the
// versions/<v>/ shape is fixed.
func isInsideVersionsDir(path string) bool {
	prefix, err := filepath.Abs(versionsDir())
	if err != nil {
		return false
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	prefix = strings.TrimRight(prefix, string(filepath.Separator)) + string(filepath.Separator)
	return strings.HasPrefix(abs, prefix)
}

// isPackagedBinary asks dpkg / rpm / pacman whether the binary
// path is owned by an installed package. Best-effort: any error
// (tool not installed, returns non-zero, etc.) means "no" — we
// don't want a missing dpkg to misclassify a homebrew tarball
// install. The point is to catch the ONE case where a real
// system package owns the binary; everything else falls through
// to standalone/versioned.
func isPackagedBinary(path string) bool {
	for _, probe := range [][]string{
		{"dpkg", "-S", path},
		{"rpm", "-qf", path},
		{"pacman", "-Qo", path},
	} {
		if _, err := osexec.LookPath(probe[0]); err != nil {
			continue
		}
		out, err := osexec.Command(probe[0], probe[1:]...).Output()
		if err == nil && len(out) > 0 {
			// Outputs vary but they all print a package name on
			// stdout when ownership is found and a non-zero exit
			// when not. We check both: err==nil AND output non-
			// empty.
			return true
		}
	}
	return false
}

func hasDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

// stopRunningStack kills any running apteva-server and apteva-core
// processes on the local box. Best-effort — the supervisor path
// (systemctl/launchctl) is preferred for service installs;
// stopRunningStack is the fallback for foreground.
func stopRunningStack() {
	killProcessOnPort(defaultServerPort)
	for _, name := range []string{"apteva-server", "apteva-core"} {
		_ = osexec.Command("pkill", "-f", name).Run()
	}
	time.Sleep(300 * time.Millisecond)
}

func downloadFile(url, dst string) error {
	client := &http.Client{Timeout: 5 * time.Minute}
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "apteva-update/"+Version)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp := dst + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}

func verifySHA256(path, want string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	got := hex.EncodeToString(h.Sum(nil))
	want = strings.ToLower(strings.TrimSpace(want))
	if got != want {
		return fmt.Errorf("sha256: got %s, want %s", got, want)
	}
	return nil
}

func extractTarGz(tarball, destDir string) error {
	f, err := os.Open(tarball)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		// Reject path traversal.
		if strings.Contains(hdr.Name, "..") || strings.HasPrefix(hdr.Name, "/") {
			return fmt.Errorf("unsafe path in archive: %q", hdr.Name)
		}
		out := filepath.Join(destDir, hdr.Name)
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(out, 0o755); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
				return err
			}
			w, err := os.OpenFile(out, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, os.FileMode(hdr.Mode)&0777)
			if err != nil {
				return err
			}
			if _, err := io.Copy(w, tr); err != nil {
				w.Close()
				return err
			}
			w.Close()
		}
	}
	return nil
}
