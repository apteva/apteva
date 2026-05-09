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
		return runServiceCmd("stop")
	case "restart":
		return runServiceCmd("restart")
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

func printServiceUsage() {
	fmt.Fprint(os.Stderr, `usage: apteva service <command>

Run apteva as a long-lived background service. Wraps systemd on
Linux and launchd on macOS.

Commands:
  install [--system|--user] [--no-start] [--no-enable]
                  Write the unit/plist and start it (default).
  uninstall       Stop and remove the unit/plist.
  start           Start the running service.
  stop            Stop the running service.
  restart         Restart (graceful drain → exit-11 → supervisor).
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
		return installSystemd(scope, !*noStart, !*noEnable)
	case "darwin":
		return installLaunchd(scope, !*noStart, !*noEnable)
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

// ─── systemd ────────────────────────────────────────────────────────

const systemdUnitTemplate = `[Unit]
Description=Apteva continuous thinking engine
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%s
Restart=on-failure
RestartSec=2
# Exit code 11 = "binary updated, please re-exec." Treating it as
# a clean exit lets systemd's Restart=on-failure path fire — which
# now picks up the new binary through the bin/current symlink.
SuccessExitStatus=11
# Reasonable defaults; operators can drop in an override.conf
# if they need to bind privileged ports / change the data dir / etc.
Environment=APTEVA_HOME=%s
WorkingDirectory=%s

[Install]
WantedBy=%s
`

func installSystemd(scope serviceScope, start, enable bool) int {
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
	body := fmt.Sprintf(systemdUnitTemplate, exec, home, home, target)
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
		fmt.Fprintln(os.Stderr, "✓ Started — http://localhost:5280")
	}

	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "  Status:  apteva service status")
	fmt.Fprintln(os.Stderr, "  Logs:    apteva service logs --follow")
	fmt.Fprintln(os.Stderr, "  Stop:    apteva service stop")
	fmt.Fprintln(os.Stderr, "  Remove:  apteva service uninstall")
	return 0
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

func exec_loginctl(args ...string) error {
	return exec.Command("loginctl", args...).Run()
}

// ─── launchd ────────────────────────────────────────────────────────

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

func installLaunchd(scope serviceScope, start, enable bool) int {
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
	body := fmt.Sprintf(launchdPlistTemplate, launchdLabel, exec, home, home, runAtLoad, stdoutLog, stderrLog)
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
		fmt.Fprintln(os.Stderr, "✓ Started — http://localhost:5280")
	}

	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "  Status:  apteva service status")
	fmt.Fprintln(os.Stderr, "  Logs:    apteva service logs --follow")
	fmt.Fprintln(os.Stderr, "  Stop:    apteva service stop")
	fmt.Fprintln(os.Stderr, "  Remove:  apteva service uninstall")
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
