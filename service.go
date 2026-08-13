package main

// service.go — `apteva service install/start/stop/restart/status/logs/uninstall`
//
// Wraps systemd (Linux) and launchd (macOS) so operators don't need
// to remember `systemctl --user enable --now apteva` vs.
// `launchctl bootstrap gui/...`. Always points the unit's ExecStart
// at ~/.apteva/bin/apteva-server — the symlink kept stable by
// pointSymlinks() — so updates don't need to rewrite the unit file.
//
// Defaults are intentionally minimal:
//   - Linux non-root → user-level systemd (~/.config/systemd/user/apteva.service)
//   - Linux root     → system-level systemd (/etc/systemd/system/apteva.service)
//   - macOS non-root → user LaunchAgent (~/Library/LaunchAgents/ai.apteva.plist)
//   - macOS root     → system LaunchDaemon (/Library/LaunchDaemons/ai.apteva.plist)
//
// `--system` and `--user` overrides on `service install` for
// operators who want non-default placement (e.g. a non-root user
// who has sudo and wants the unit under /etc).

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const serviceUnitName = "apteva"
const systemdUpdateDropInName = "50-apteva-cli-update.conf"
const launchdLabel = "ai.apteva"

// serviceScope picks where the unit/plist gets written and which
// command-line flavor (`systemctl` vs `systemctl --user`,
// `launchctl bootstrap system/` vs `gui/`) wraps it.
type serviceScope int

const (
	scopeAuto serviceScope = iota
	scopeUser
	scopeSystem
)

func cmdService(args []string) int {
	if len(args) == 0 {
		printServiceUsage()
		return 2
	}
	sub := args[0]
	rest := args[1:]
	switch sub {
	case "install":
		return cmdServiceInstall(rest)
	case "uninstall", "remove":
		return cmdServiceUninstall(rest)
	case "start":
		return runServiceCmd("start")
	case "stop":
		return cmdServiceLifecycle("stop", rest)
	case "restart":
		return cmdServiceLifecycle("restart", rest)
	case "status":
		return runServiceCmd("status")
	case "logs":
		return cmdServiceLogs(rest)
	case "-h", "--help", "help":
		printServiceUsage()
		return 0
	}
	fmt.Fprintf(os.Stderr, "apteva service: unknown subcommand %q\n", sub)
	printServiceUsage()
	return 2
}

func cmdServiceLifecycle(verb string, args []string) int {
	fs := flag.NewFlagSet("service "+verb, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	agentPolicy := fs.String("agents", "", "agent handling for restart: restart, rolling, or preserve")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if verb == "stop" && *agentPolicy != "" {
		fmt.Fprintln(os.Stderr, "service stop always stops agents; --agents is only valid for restart")
		return 2
	}
	if _, err := normalizeLifecyclePolicy(*agentPolicy); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if err := writeLifecycleIntent(verb, *agentPolicy); err != nil {
		fmt.Fprintf(os.Stderr, "failed to prepare service %s: %v\n", verb, err)
		return 1
	}
	code := runServiceCmd(verb)
	if code != 0 {
		clearLifecycleIntent()
	}
	return code
}

func printServiceUsage() {
	fmt.Fprint(os.Stderr, `usage: apteva service <command>

Run apteva as a long-lived background service. Wraps systemd on
Linux and launchd on macOS.

Commands:
  install [--system|--user] [--bind <addr>] [--no-start] [--no-enable]
                  Write the unit/plist and start it (default).
                  --bind defaults to 0.0.0.0 for --system installs
                  (typical VPS shape) and 127.0.0.1 for --user installs
                  (typical laptop). Pass --bind 127.0.0.1 on a system
                  install if you want loopback-only.
  uninstall       Stop and remove the unit/plist.
  start           Start the running service.
  stop            Stop the service and all agent processes.
  restart [--agents restart|rolling|preserve]
                  Restart the service with an optional agent policy override.
  status          Print supervisor status.
  logs [--follow] Tail the service log.

Defaults: user-scope when not running as root, system-scope when run as
root. Use --system or --user to override.

Once installed: 'apteva' (no args) connects to the running service.
`)
}

// ─── install ────────────────────────────────────────────────────────

func cmdServiceInstall(args []string) int {
	fs := flag.NewFlagSet("service install", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	system := fs.Bool("system", false, "install as system service (requires root)")
	user := fs.Bool("user", false, "install as user service")
	noStart := fs.Bool("no-start", false, "don't start after install")
	noEnable := fs.Bool("no-enable", false, "don't enable for boot/login start")
	// --bind picks the listen interface for apteva-server. Default
	// chosen by scope (see resolveBindDefault) so a `service install
	// --system` on a public VPS doesn't silently bind to loopback
	// (pre-v0.14.4 behaviour — server defaulted APTEVA_BIND=127.0.0.1
	// and the unit never overrode it, so operators couldn't reach
	// the dashboard from outside the box). Auth (bearer + setup
	// token) gates every /api/ route so binding 0.0.0.0 on a system
	// service is the expected shape, not a footgun.
	bind := fs.String("bind", "", "listen address (default: 0.0.0.0 for --system, 127.0.0.1 for --user)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *system && *user {
		fmt.Fprintln(os.Stderr, "apteva service install: --system and --user are mutually exclusive")
		return 2
	}
	scope := scopeAuto
	switch {
	case *system:
		scope = scopeSystem
	case *user:
		scope = scopeUser
	}
	scope = resolveScope(scope)
	bindAddr := *bind
	if bindAddr == "" {
		bindAddr = resolveBindDefault(scope)
	}

	// Precondition: the bin/ symlinks must exist. Without them the
	// unit file's ExecStart path doesn't resolve. ensureLayout +
	// pointSymlinks if there's a versions/<v>/ to point at;
	// otherwise the operator hasn't run apteva yet — give them
	// a clear error rather than writing a unit that won't start.
	if err := ensureLayout(); err != nil {
		fmt.Fprintf(os.Stderr, "apteva service install: %v\n", err)
		return 1
	}
	if activeVersion() == "" {
		all, _ := installedVersions()
		if len(all) == 0 {
			fmt.Fprintln(os.Stderr, "apteva service install: no installed version found.")
			fmt.Fprintln(os.Stderr, "Run `apteva` once first, then re-run `apteva service install`.")
			return 1
		}
		// We have a version on disk but no `current` symlink yet.
		// Point it at the newest and continue.
		if err := pointSymlinks(all[0]); err != nil {
			fmt.Fprintf(os.Stderr, "apteva service install: pointSymlinks: %v\n", err)
			return 1
		}
	}

	switch runtime.GOOS {
	case "linux":
		return installSystemd(scope, !*noStart, !*noEnable, bindAddr)
	case "darwin":
		return installLaunchd(scope, !*noStart, !*noEnable, bindAddr)
	default:
		fmt.Fprintf(os.Stderr, "apteva service install: unsupported platform %s\n", runtime.GOOS)
		return 1
	}
}

// resolveScope turns scopeAuto into scopeUser or scopeSystem based
// on euid. Already-explicit scopes pass through.
func resolveScope(s serviceScope) serviceScope {
	if s != scopeAuto {
		return s
	}
	if os.Geteuid() == 0 {
		return scopeSystem
	}
	return scopeUser
}

// resolveBindDefault picks the default listen address for a service
// install based on scope. System-scope is the "real server" shape —
// running as root, exposed for the network, typically on a VPS —
// so bind every interface (0.0.0.0). User-scope is the laptop / dev
// box shape — bind loopback so an unsuspecting localhost dev doesn't
// accidentally publish their apteva to the network. Either default
// can be overridden via the explicit `--bind` flag; the chosen
// value lands as Environment=APTEVA_BIND=... in the unit/plist so
// operators can see what they got.
func resolveBindDefault(s serviceScope) string {
	if s == scopeSystem {
		return "0.0.0.0"
	}
	return "127.0.0.1"
}

// ─── systemd ────────────────────────────────────────────────────────

// systemdUnitTemplate — the unit installed by `apteva service
// install`. Field order:
//  1. ExecStart                  → bin/apteva-server symlink
//  2. APTEVA_HOME                → install root
//  3. PORT                       → 5280, the canonical apteva port
//  4. APTEVA_BIND                → listen interface (per-scope default,
//     overridable via `--bind`)
//  5. DB_PATH                    → APTEVA_HOME/apteva.db (v0.11 path)
//  6. DATA_DIR                   → APTEVA_HOME
//  7. CORE_CMD                   → APTEVA_HOME/bin/apteva-core symlink
//  8. WorkingDirectory           → APTEVA_HOME
//  9. WantedBy                   → default.target / multi-user.target
//
// Why we set every env var explicitly even though apteva-server
// derives the same values from APTEVA_HOME by default: an operator
// running `cat /etc/systemd/system/apteva.service` should be able
// to see the runtime configuration without consulting source.
// Override via `systemctl edit apteva` (drops an override.conf
// next to the unit) — the install path doesn't touch override.conf
// so operator overrides survive `apteva update`.
const systemdUnitTemplate = `[Unit]
Description=Apteva continuous thinking engine
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%s
Restart=on-failure
RestartSec=2
# Let apteva-server own child lifecycle. On restart/update, systemd
# should signal only the server process; the server stops agent cores
# by default, or preserves them when its detach policy is enabled.
KillMode=process
# Exit code 11 = "binary updated, please re-exec." Treating it as
# a clean exit lets systemd's Restart=on-failure path fire — which
# now picks up the new binary through the bin/current symlink.
SuccessExitStatus=11
Environment=APTEVA_HOME=%s
Environment=PORT=5280
Environment=APTEVA_BIND=%s
Environment=DB_PATH=%s/apteva.db
Environment=DATA_DIR=%s
Environment=CORE_CMD=%s/bin/apteva-core
WorkingDirectory=%s

[Install]
WantedBy=%s
`

func installSystemd(scope serviceScope, start, enable bool, bindAddr string) int {
	unitPath, target, err := systemdUnitPath(scope)
	if err != nil {
		fmt.Fprintf(os.Stderr, "apteva service install: %v\n", err)
		return 1
	}
	if err := os.MkdirAll(filepath.Dir(unitPath), 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "apteva service install: mkdir %s: %v\n", filepath.Dir(unitPath), err)
		return 1
	}

	exec := resolveBin("apteva-server")
	home := aptevaDir()
	body := fmt.Sprintf(systemdUnitTemplate,
		exec,     // ExecStart
		home,     // APTEVA_HOME
		bindAddr, // APTEVA_BIND
		home,     // DB_PATH=$home/apteva.db
		home,     // DATA_DIR
		home,     // CORE_CMD=$home/bin/apteva-core
		home,     // WorkingDirectory
		target,   // WantedBy
	)
	if err := os.WriteFile(unitPath, []byte(body), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "apteva service install: write %s: %v\n", unitPath, err)
		return 1
	}
	fmt.Fprintf(os.Stderr, "✓ Wrote unit: %s\n", unitPath)

	if err := systemctl(scope, "daemon-reload"); err != nil {
		fmt.Fprintf(os.Stderr, "apteva service install: daemon-reload: %v\n", err)
		return 1
	}

	if enable {
		// `enable --now` would also start, but we split for clearer
		// error messages: an enable failure (lingering not enabled
		// for user-mode) is recoverable; a start failure is not.
		if err := systemctl(scope, "enable", serviceUnitName); err != nil {
			fmt.Fprintf(os.Stderr, "apteva service install: enable: %v\n", err)
			return 1
		}
		fmt.Fprintln(os.Stderr, "✓ Enabled (will start on login/boot)")
		// User-mode systemd needs `loginctl enable-linger` to keep
		// the unit running across logout. Try once; non-fatal if it
		// can't (some distros / containers).
		if scope == scopeUser {
			u := os.Getenv("USER")
			if u != "" {
				_ = exec_loginctl("enable-linger", u)
			}
		}
	}

	if start {
		if err := systemctl(scope, "start", serviceUnitName); err != nil {
			fmt.Fprintf(os.Stderr, "apteva service install: start: %v\n", err)
			return 1
		}
		fmt.Fprintf(os.Stderr, "✓ Started — %s\n", reachableURL(bindAddr))
	}

	fmt.Fprintln(os.Stderr)
	fmt.Fprintf(os.Stderr, "  Listening: %s:5280\n", bindAddr)
	fmt.Fprintln(os.Stderr, "  Status:    apteva service status")
	fmt.Fprintln(os.Stderr, "  Logs:      apteva service logs --follow")
	fmt.Fprintln(os.Stderr, "  Stop:      apteva service stop")
	fmt.Fprintln(os.Stderr, "  Remove:    apteva service uninstall")
	if bindAddr == "0.0.0.0" {
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "  ⚠ Bound to all interfaces. Auth (bearer token + setup token)")
		fmt.Fprintln(os.Stderr, "    gates every /api/ route; the setup token is printed at boot")
		fmt.Fprintln(os.Stderr, "    and required for the FIRST admin registration. Lock down the")
		fmt.Fprintln(os.Stderr, "    port at the firewall level if you want a private deployment.")
	}
	return 0
}

// reachableURL turns a bind address into a human-facing URL for the
// success banner. 0.0.0.0 / :: are wildcards — operators reach the
// dashboard through the box's actual hostname/IP, not "0.0.0.0", so
// we substitute "<host>" as a placeholder. 127.0.0.1 and named
// addresses pass through as-is.
func reachableURL(bindAddr string) string {
	switch bindAddr {
	case "0.0.0.0", "::", "[::]":
		return "http://<host>:5280"
	case "127.0.0.1", "localhost":
		return "http://localhost:5280"
	}
	return fmt.Sprintf("http://%s:5280", bindAddr)
}

func systemdUnitPath(scope serviceScope) (path, wantedBy string, err error) {
	switch scope {
	case scopeUser:
		home, e := os.UserHomeDir()
		if e != nil {
			return "", "", e
		}
		return filepath.Join(home, ".config", "systemd", "user", serviceUnitName+".service"),
			"default.target", nil
	case scopeSystem:
		return filepath.Join("/etc/systemd/system", serviceUnitName+".service"),
			"multi-user.target", nil
	}
	return "", "", fmt.Errorf("invalid scope %d", scope)
}

func systemctl(scope serviceScope, args ...string) error {
	full := []string{}
	if scope == scopeUser {
		full = append(full, "--user")
	}
	full = append(full, args...)
	cmd := exec.Command("systemctl", full...)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// systemctlValue runs a read-only systemctl query and returns its trimmed
// stdout. Unlike systemctl, it keeps stderr out of successful command output
// while retaining it in failures so update diagnostics remain actionable.
func systemctlValue(scope serviceScope, args ...string) (string, error) {
	full := []string{}
	if scope == scopeUser {
		full = append(full, "--user")
	}
	full = append(full, args...)
	cmd := exec.Command("systemctl", full...)
	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			if detail := strings.TrimSpace(string(exitErr.Stderr)); detail != "" {
				return "", fmt.Errorf("%w: %s", err, detail)
			}
		}
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func systemdUpdateDropInPath(scope serviceScope) (string, error) {
	unitPath, _, err := systemdUnitPath(scope)
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(unitPath), serviceUnitName+".service.d", systemdUpdateDropInName), nil
}

const systemdUpdateDropIn = `[Service]
KillMode=process
`

// ensureSystemdUpdateCompatibility migrates legacy service installations
// without rewriting the operator's unit or any operator-owned drop-ins. The
// effective value is queried after daemon-reload because a later-sorting
// operator drop-in may intentionally override this managed setting.
func ensureSystemdUpdateCompatibility(scope serviceScope) error {
	path, err := systemdUpdateDropInPath(scope)
	if err != nil {
		return err
	}
	return ensureSystemdUpdateCompatibilityAt(
		path,
		func() error { return systemctl(scope, "daemon-reload") },
		func() (string, error) {
			return systemctlValue(scope, "show", serviceUnitName+".service", "-p", "KillMode", "--value")
		},
	)
}

// ensureSystemdUpdateCompatibilityAt contains the filesystem migration behind
// small callbacks so it can be regression-tested without invoking systemd or
// writing under /etc.
func ensureSystemdUpdateCompatibilityAt(
	path string,
	daemonReload func() error,
	effectiveKillMode func() (string, error),
) error {
	if err := writeManagedSystemdDropIn(path, []byte(systemdUpdateDropIn)); err != nil {
		return fmt.Errorf("write managed systemd drop-in %s: %w", path, err)
	}
	if err := daemonReload(); err != nil {
		return fmt.Errorf("systemctl daemon-reload: %w", err)
	}
	mode, err := effectiveKillMode()
	if err != nil {
		return fmt.Errorf("verify effective KillMode: %w", err)
	}
	if mode != "process" {
		return fmt.Errorf("effective KillMode is %q, want %q (check later-sorting operator drop-ins)", mode, "process")
	}
	return nil
}

func writeManagedSystemdDropIn(path string, body []byte) error {
	if existing, err := os.ReadFile(path); err == nil && string(existing) == string(body) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".apteva-systemd-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(body); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

func exec_loginctl(args ...string) error {
	return exec.Command("loginctl", args...).Run()
}

// ─── launchd ────────────────────────────────────────────────────────

// launchdPlistTemplate — same set of env vars systemd's unit
// declares, written into EnvironmentVariables. Same rationale: the
// operator can `cat ~/Library/LaunchAgents/ai.apteva.plist` to see
// the full runtime config.
//
// Format-string positions (in order):
//  1. Label
//  2. ProgramArguments[0] — the binary
//  3. APTEVA_HOME
//  4. APTEVA_BIND
//  5. DB_PATH
//  6. DATA_DIR
//  7. CORE_CMD
//  8. WorkingDirectory
//  9. RunAtLoad — "true"/"false"
//  10. StandardOutPath
//  11. StandardErrorPath
const launchdPlistTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>%s</string>
    <key>ProgramArguments</key>
    <array>
        <string>%s</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>APTEVA_HOME</key>
        <string>%s</string>
        <key>PORT</key>
        <string>5280</string>
        <key>APTEVA_BIND</key>
        <string>%s</string>
        <key>DB_PATH</key>
        <string>%s/apteva.db</string>
        <key>DATA_DIR</key>
        <string>%s</string>
        <key>CORE_CMD</key>
        <string>%s/bin/apteva-core</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>%s</string>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>RunAtLoad</key>
    <%s/>
    <key>StandardOutPath</key>
    <string>%s</string>
    <key>StandardErrorPath</key>
    <string>%s</string>
</dict>
</plist>
`

func installLaunchd(scope serviceScope, start, enable bool, bindAddr string) int {
	plistPath, err := launchdPlistPath(scope)
	if err != nil {
		fmt.Fprintf(os.Stderr, "apteva service install: %v\n", err)
		return 1
	}
	if err := os.MkdirAll(filepath.Dir(plistPath), 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "apteva service install: mkdir: %v\n", err)
		return 1
	}

	exec := resolveBin("apteva-server")
	home := aptevaDir()
	logDir := filepath.Join(home, "logs")
	_ = os.MkdirAll(logDir, 0o755)
	stdoutLog := filepath.Join(logDir, "service.out.log")
	stderrLog := filepath.Join(logDir, "service.err.log")

	runAtLoad := "true"
	if !start {
		runAtLoad = "false"
	}
	body := fmt.Sprintf(launchdPlistTemplate,
		launchdLabel, // Label
		exec,         // ProgramArguments[0]
		home,         // APTEVA_HOME
		bindAddr,     // APTEVA_BIND
		home,         // DB_PATH=$home/apteva.db
		home,         // DATA_DIR
		home,         // CORE_CMD=$home/bin/apteva-core
		home,         // WorkingDirectory
		runAtLoad,    // RunAtLoad
		stdoutLog,    // StandardOutPath
		stderrLog,    // StandardErrorPath
	)
	if err := os.WriteFile(plistPath, []byte(body), 0o644); err != nil {
		fmt.Fprintf(os.Stderr, "apteva service install: write %s: %v\n", plistPath, err)
		return 1
	}
	fmt.Fprintf(os.Stderr, "✓ Wrote plist: %s\n", plistPath)

	// launchctl bootstrap is the modern replacement for `load`.
	// Domain target picks system vs gui.
	if enable {
		if err := launchctl(scope, "bootstrap"); err != nil {
			// `bootstrap` errors if the plist is already loaded.
			// Non-fatal; downstream start handles the running case.
			fmt.Fprintf(os.Stderr, "  (note: bootstrap returned %v — plist may already be loaded)\n", err)
		} else {
			fmt.Fprintln(os.Stderr, "✓ Loaded (will start at login)")
		}
	}

	if start {
		if err := launchctl(scope, "kickstart"); err != nil {
			fmt.Fprintf(os.Stderr, "apteva service install: kickstart: %v\n", err)
			return 1
		}
		fmt.Fprintf(os.Stderr, "✓ Started — %s\n", reachableURL(bindAddr))
	}

	fmt.Fprintln(os.Stderr)
	fmt.Fprintf(os.Stderr, "  Listening: %s:5280\n", bindAddr)
	fmt.Fprintln(os.Stderr, "  Status:    apteva service status")
	fmt.Fprintln(os.Stderr, "  Logs:      apteva service logs --follow")
	fmt.Fprintln(os.Stderr, "  Stop:      apteva service stop")
	fmt.Fprintln(os.Stderr, "  Remove:    apteva service uninstall")
	if bindAddr == "0.0.0.0" {
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "  ⚠ Bound to all interfaces. Auth (bearer token + setup token)")
		fmt.Fprintln(os.Stderr, "    gates every /api/ route; the setup token is printed at boot.")
		fmt.Fprintln(os.Stderr, "    Lock down the port at the firewall level for private deployments.")
	}
	return 0
}

func launchdPlistPath(scope serviceScope) (string, error) {
	switch scope {
	case scopeUser:
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "Library", "LaunchAgents", launchdLabel+".plist"), nil
	case scopeSystem:
		return filepath.Join("/Library/LaunchDaemons", launchdLabel+".plist"), nil
	}
	return "", fmt.Errorf("invalid scope %d", scope)
}

// launchctl runs `launchctl <verb> <domain-target>` with the right
// domain target for the current scope. domain target is "gui/<uid>"
// for user agents, "system" for daemons. Verbs we use: bootstrap,
// bootout, kickstart, print.
func launchctl(scope serviceScope, verb string, extra ...string) error {
	dt, plist, err := launchdDomainTarget(scope)
	if err != nil {
		return err
	}
	args := []string{verb}
	switch verb {
	case "bootstrap":
		args = append(args, dt, plist)
	case "bootout":
		args = append(args, dt+"/"+launchdLabel)
	case "kickstart":
		args = append(args, "-k", dt+"/"+launchdLabel)
	case "print":
		args = append(args, dt+"/"+launchdLabel)
	default:
		args = append(args, dt+"/"+launchdLabel)
	}
	args = append(args, extra...)
	cmd := exec.Command("launchctl", args...)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func launchdDomainTarget(scope serviceScope) (target, plistPath string, err error) {
	plistPath, err = launchdPlistPath(scope)
	if err != nil {
		return "", "", err
	}
	switch scope {
	case scopeUser:
		// gui/<uid>: persists across logouts since we set
		// KeepAlive. Alternative is "user/<uid>" which dies with
		// the session; gui is what the operator-friendly tools use.
		return fmt.Sprintf("gui/%d", os.Getuid()), plistPath, nil
	case scopeSystem:
		return "system", plistPath, nil
	}
	return "", "", fmt.Errorf("invalid scope %d", scope)
}

// ─── shared ─────────────────────────────────────────────────────────

// detectInstalledScope picks user vs system based on which path
// exists. If both somehow exist (operator switched), system wins
// because it has more authority. Used by start/stop/etc. to find
// the unit/plist without re-asking for the flag.
func detectInstalledScope() (serviceScope, bool) {
	switch runtime.GOOS {
	case "linux":
		if p, _, err := systemdUnitPath(scopeSystem); err == nil {
			if _, e := os.Stat(p); e == nil {
				return scopeSystem, true
			}
		}
		if p, _, err := systemdUnitPath(scopeUser); err == nil {
			if _, e := os.Stat(p); e == nil {
				return scopeUser, true
			}
		}
	case "darwin":
		if p, err := launchdPlistPath(scopeSystem); err == nil {
			if _, e := os.Stat(p); e == nil {
				return scopeSystem, true
			}
		}
		if p, err := launchdPlistPath(scopeUser); err == nil {
			if _, e := os.Stat(p); e == nil {
				return scopeUser, true
			}
		}
	}
	return scopeAuto, false
}

func runServiceCmd(verb string) int {
	scope, ok := detectInstalledScope()
	if !ok {
		fmt.Fprintln(os.Stderr, "apteva service: no installed service found.")
		fmt.Fprintln(os.Stderr, "Run `apteva service install` first.")
		return 1
	}
	switch runtime.GOOS {
	case "linux":
		switch verb {
		case "start", "stop", "restart":
			if err := systemctl(scope, verb, serviceUnitName); err != nil {
				return 1
			}
			return 0
		case "status":
			// status returns non-zero when inactive, which is
			// informational not an error condition. Print and
			// pass through the exit code so scripts can use it.
			cmd := exec.Command("systemctl")
			args := []string{}
			if scope == scopeUser {
				args = append(args, "--user")
			}
			args = append(args, "status", serviceUnitName, "--no-pager")
			cmd = exec.Command("systemctl", args...)
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
			_ = cmd.Run()
			return 0
		}
	case "darwin":
		switch verb {
		case "start":
			if err := launchctl(scope, "kickstart"); err != nil {
				return 1
			}
			return 0
		case "stop":
			// `launchctl kill` sends a signal; SIGTERM lets
			// apteva-server drain. With KeepAlive set, launchd
			// would restart it — so we follow up with bootout to
			// fully stop. Operators expecting "stop = stay stopped"
			// get that behaviour; a subsequent `apteva service
			// start` re-loads via kickstart.
			_ = launchctl(scope, "kill", "SIGTERM")
			if err := launchctl(scope, "bootout"); err != nil {
				return 1
			}
			return 0
		case "restart":
			if err := launchctl(scope, "kickstart"); err != nil {
				return 1
			}
			return 0
		case "status":
			cmd := exec.Command("launchctl", "print", launchdDomainTargetMust(scope))
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
			_ = cmd.Run()
			return 0
		}
	}
	fmt.Fprintf(os.Stderr, "apteva service: %s not supported on %s\n", verb, runtime.GOOS)
	return 1
}

func launchdDomainTargetMust(scope serviceScope) string {
	t, _, _ := launchdDomainTarget(scope)
	return t + "/" + launchdLabel
}

// ─── uninstall ──────────────────────────────────────────────────────

func cmdServiceUninstall(args []string) int {
	scope, ok := detectInstalledScope()
	if !ok {
		fmt.Fprintln(os.Stderr, "apteva service uninstall: nothing to remove.")
		return 0
	}
	switch runtime.GOOS {
	case "linux":
		_ = systemctl(scope, "stop", serviceUnitName)
		_ = systemctl(scope, "disable", serviceUnitName)
		path, _, _ := systemdUnitPath(scope)
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			fmt.Fprintf(os.Stderr, "remove %s: %v\n", path, err)
			return 1
		}
		_ = systemctl(scope, "daemon-reload")
		fmt.Fprintf(os.Stderr, "✓ Removed unit: %s\n", path)
		return 0
	case "darwin":
		_ = launchctl(scope, "kill", "SIGTERM")
		_ = launchctl(scope, "bootout")
		path, _ := launchdPlistPath(scope)
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			fmt.Fprintf(os.Stderr, "remove %s: %v\n", path, err)
			return 1
		}
		fmt.Fprintf(os.Stderr, "✓ Removed plist: %s\n", path)
		return 0
	}
	return 1
}

// ─── logs ───────────────────────────────────────────────────────────

func cmdServiceLogs(args []string) int {
	fs := flag.NewFlagSet("service logs", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	follow := fs.Bool("follow", false, "tail logs continuously")
	fs.BoolVar(follow, "f", false, "alias of --follow")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	scope, ok := detectInstalledScope()
	if !ok {
		fmt.Fprintln(os.Stderr, "apteva service logs: no installed service found.")
		return 1
	}
	switch runtime.GOOS {
	case "linux":
		args := []string{}
		if scope == scopeUser {
			args = append(args, "--user")
		}
		args = append(args, "-u", serviceUnitName)
		if *follow {
			args = append(args, "-f")
		} else {
			args = append(args, "-n", "100", "--no-pager")
		}
		cmd := exec.Command("journalctl", args...)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		_ = cmd.Run()
		return 0
	case "darwin":
		// launchd writes to the StandardOut/Err paths configured
		// in the plist. Tail those.
		log := filepath.Join(aptevaDir(), "logs", "service.err.log")
		bin := "tail"
		args := []string{"-n", "100"}
		if *follow {
			args = append(args, "-f")
		}
		args = append(args, log)
		cmd := exec.Command(bin, args...)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		_ = cmd.Run()
		return 0
	}
	return 1
}

// ─── awareness helpers used by the dashboard banner ──────────────────

// describeInstallEnv returns a short tag describing how apteva-server
// is currently being supervised, for the dashboard's update banner.
// Looked at by the platform-status handler when it hands data to
// the UI. Kept here (not in update.go) so service.go owns the
// "supervisor knowledge" in one place.
func describeInstallEnv() string {
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return "docker"
	}
	if scope, ok := detectInstalledScope(); ok {
		switch runtime.GOOS {
		case "linux":
			if scope == scopeSystem {
				return "systemd-system"
			}
			return "systemd-user"
		case "darwin":
			if scope == scopeSystem {
				return "launchd-system"
			}
			return "launchd-user"
		}
	}
	return "foreground"
}

// helper to silence unused-import tally if a build flag pulls bits out
var _ = strings.TrimSpace
