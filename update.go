package main

// `apteva update` — fetch the latest published bundle (CLI + server +
// core, all together), verify it, and replace the on-disk binaries
// in place.
//
// Source of truth: apteva/version.json, served via raw.githubusercontent.com
// (no API rate limits, no auth). Same publish path the apps marketplace
// uses for registry.json. Each release commits a new version.json that
// points at GitHub-Releases artifacts produced by scripts/release.sh.
//
// Doesn't try to do anything clever for installs that have their own
// update story (npx / npm-global, Docker, in-tree source builds): it
// detects those and prints the right instruction instead. Only the
// "standalone tarball, dropped somewhere on disk" case actually runs
// the download + swap path.

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

// installMethod is how the running apteva binary reached disk. Each
// method has a different update path; only `installStandalone` is the
// one `apteva update` actually services.
type installMethod int

const (
	installUnknown    installMethod = iota
	installNpx                      // ~/.npm/_npx/<hash>/node_modules/apteva/
	installNpmGlobal                // npm install -g apteva
	installDocker                   // /.dockerenv exists
	installSource                   // sibling-path build (server/, core/ alongside)
	installStandalone               // raw tarball extracted somewhere
)

func cmdUpdate(args []string) int {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	check := fs.Bool("check", false, "show what would update without applying")
	yes := fs.Bool("yes", false, "skip the confirmation prompt")
	if err := fs.Parse(args); err != nil {
		return 2
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

	if Version == m.Version {
		fmt.Fprintf(os.Stderr, "already on latest (v%s)\n", Version)
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
		fmt.Fprintln(os.Stderr, "    docker compose up -d   # or whatever your compose file calls for")
		return 1
	case installSource:
		fmt.Fprintln(os.Stderr, "this looks like a source build (sibling server/ and core/ dirs).")
		fmt.Fprintln(os.Stderr, "`apteva update` won't overwrite a working tree — pull and rebuild:")
		fmt.Fprintln(os.Stderr, "    cd <your monorepo> && git pull && ./scripts/build-local.sh")
		return 1
	case installStandalone:
		// continue
	default:
		fmt.Fprintln(os.Stderr, "couldn't identify install method; refusing to overwrite anything.")
		fmt.Fprintln(os.Stderr, "Re-download the tarball manually if you want to update.")
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

	// 1. Stop any running stack so we don't try to overwrite a busy
	//    binary. macOS allows replacing a running ELF/Mach-O via
	//    rename, but the process keeps the old text segment in
	//    memory; restarting is required either way for the new
	//    behaviour to take effect, so we may as well stop cleanly now.
	fmt.Fprintln(os.Stderr, "stopping running apteva-server / apteva-core…")
	stopRunningStack()

	// 2. Download to a temp file.
	tmpDir, err := os.MkdirTemp("", "apteva-update-*")
	if err != nil {
		fmt.Fprintf(os.Stderr, "tempdir: %v\n", err)
		return 1
	}
	defer os.RemoveAll(tmpDir)

	tarball := filepath.Join(tmpDir, "bundle.tar.gz")
	fmt.Fprintf(os.Stderr, "downloading %s\n", art.URL)
	if err := downloadFile(art.URL, tarball); err != nil {
		fmt.Fprintf(os.Stderr, "download failed: %v\n", err)
		return 1
	}

	// 3. Verify checksum if the manifest provided one. A missing
	//    sha256 is treated as a soft warning rather than a hard fail
	//    so the manifest can be hand-edited in a pinch — but a
	//    mismatched one is a hard fail every time.
	if art.SHA256 != "" {
		fmt.Fprintln(os.Stderr, "verifying sha256…")
		if err := verifySHA256(tarball, art.SHA256); err != nil {
			fmt.Fprintf(os.Stderr, "checksum mismatch: %v\n", err)
			return 1
		}
	} else {
		fmt.Fprintln(os.Stderr, "warning: manifest has no sha256 — skipping verification")
	}

	// 4. Extract.
	fmt.Fprintln(os.Stderr, "extracting…")
	extractDir := filepath.Join(tmpDir, "extract")
	if err := os.MkdirAll(extractDir, 0755); err != nil {
		fmt.Fprintf(os.Stderr, "mkdir extract: %v\n", err)
		return 1
	}
	if err := extractTarGz(tarball, extractDir); err != nil {
		fmt.Fprintf(os.Stderr, "extract failed: %v\n", err)
		return 1
	}

	// 5. Swap. The release tarball lays the three binaries flat —
	//    apteva, apteva-server, apteva-core — so we can move each
	//    into the directory the running apteva lives in.
	fmt.Fprintln(os.Stderr, "swapping binaries…")
	if err := swapBinaries(extractDir); err != nil {
		fmt.Fprintf(os.Stderr, "swap failed: %v\n", err)
		return 1
	}

	fmt.Fprintf(os.Stderr, "\n  apteva updated to v%s.\n", m.Version)
	fmt.Fprintln(os.Stderr, "  run `apteva` to start with the new version.")
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
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20)) // 1 MiB cap
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
// tells (Docker control file, monorepo siblings) to classify how
// apteva got onto disk. Conservative — when in doubt returns
// installUnknown so we refuse the swap rather than corrupting an
// install we don't understand.
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
	if strings.Contains(resolved, "/_npx/") || strings.Contains(resolved, "/node_modules/apteva/") {
		return installNpx
	}
	// npm-global puts binaries under <prefix>/lib/node_modules/apteva/ on most
	// systems; npm symlinks <prefix>/bin/apteva → there. resolved follows the
	// symlink, so we land in node_modules.
	if strings.Contains(resolved, "node_modules/apteva") {
		return installNpmGlobal
	}

	// Source build: the build-local.sh layout puts each binary inside
	// its own component dir, so apteva's parent has a sibling
	// `server/` and `core/` directory (NOT just sibling binaries —
	// those exist in standalone tarballs too).
	dir := filepath.Dir(resolved)
	parent := filepath.Dir(dir)
	if hasDir(filepath.Join(parent, "server")) && hasDir(filepath.Join(parent, "core")) &&
		hasDir(filepath.Join(parent, "app-sdk")) {
		return installSource
	}

	return installStandalone
}

func hasDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

// stopRunningStack kills any running apteva-server and apteva-core
// processes on the local box. Reuses the same lsof/fuser shell-out
// the CLI's own Phase-1 cleanup uses. Best-effort: failures don't
// abort the update — the user will just have to kill them by hand.
func stopRunningStack() {
	// Server's well-known port first.
	killProcessOnPort(defaultServerPort)
	// Then any stragglers by name.
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
	f, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, resp.Body)
	return err
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
		// Reject path traversal — release tarballs are flat (apteva,
		// apteva-server, apteva-core), so anything with .. or absolute
		// paths is malformed.
		if strings.Contains(hdr.Name, "..") || strings.HasPrefix(hdr.Name, "/") {
			return fmt.Errorf("unsafe path in archive: %q", hdr.Name)
		}
		out := filepath.Join(destDir, hdr.Name)
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(out, 0755); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(out), 0755); err != nil {
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

// swapBinaries moves the three new binaries into the directory the
// current apteva binary lives in. Each is renamed to .bak first; on
// any failure the .bak is rolled back. Atomic per file (rename is
// atomic within a filesystem); not transactional across the three.
// In practice they live in the same dir and the worst case is a
// half-swapped install with one or two .bak files left behind, which
// the user can spot and roll back manually.
func swapBinaries(extractDir string) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	resolved, _ := filepath.EvalSymlinks(self)
	if resolved == "" {
		resolved = self
	}
	targetDir := filepath.Dir(resolved)

	type swap struct{ name string }
	swaps := []swap{
		{"apteva"},
		{"apteva-server"},
		{"apteva-core"},
	}

	type swapped struct{ src, dst, bak string }
	var done []swapped

	rollback := func() {
		for _, s := range done {
			_ = os.Rename(s.dst, s.dst+".failed")
			_ = os.Rename(s.bak, s.dst)
		}
	}

	for _, s := range swaps {
		src := filepath.Join(extractDir, s.name)
		dst := filepath.Join(targetDir, s.name)
		if _, err := os.Stat(src); err != nil {
			rollback()
			return fmt.Errorf("missing %s in archive", s.name)
		}
		bak := dst + ".bak"
		// If the target doesn't exist yet (rare — partial install),
		// skip the backup step but still place the new binary.
		if _, err := os.Stat(dst); err == nil {
			_ = os.Remove(bak) // remove any stale .bak from a prior run
			if err := os.Rename(dst, bak); err != nil {
				rollback()
				return fmt.Errorf("rename old %s: %w", s.name, err)
			}
		}
		if err := moveFile(src, dst); err != nil {
			rollback()
			return fmt.Errorf("move new %s: %w", s.name, err)
		}
		_ = os.Chmod(dst, 0755)
		done = append(done, swapped{src: src, dst: dst, bak: bak})
	}

	// All three placed successfully — clean up the .bak files.
	for _, s := range done {
		_ = os.Remove(s.bak)
	}
	return nil
}

// moveFile prefers rename (atomic, fast) but falls back to copy when
// rename fails with EXDEV (cross-device). Tarball extraction lands in
// /tmp which on macOS shares the volume with $HOME, so the rename
// path is the common case; on Linux + tmpfs the fallback fires.
func moveFile(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Remove(src)
}
