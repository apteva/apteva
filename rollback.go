package main

// rollback.go — `apteva versions` and `apteva rollback`.
//
// Both work off the layout in layout.go: `versions` lists every
// usable version dir on disk, marking which one `bin/current`
// points at; `rollback` flips `bin/current` to a different version
// and asks any running stack to come back up against the new
// binaries (same path the post-update flip uses — SIGTERM the
// running server, supervisor / parent re-execs through the now-
// updated symlink).

import (
	"fmt"
	"net"
	"os"
	"runtime"
	"strconv"
	"time"
)

func cmdVersions(args []string) int {
	all, err := installedVersions()
	if err != nil {
		fmt.Fprintf(os.Stderr, "apteva versions: %v\n", err)
		return 1
	}
	if len(all) == 0 {
		fmt.Fprintln(os.Stderr, "no versions installed.")
		return 1
	}
	active := activeVersion()
	for _, v := range all {
		marker := "  "
		if v == active {
			marker = "* "
		}
		fmt.Printf("%s%s\n", marker, v)
	}
	if active == "" {
		fmt.Fprintln(os.Stderr)
		fmt.Fprintln(os.Stderr, "(no active version — run `apteva rollback <version>` to pick one)")
	}
	return 0
}

func cmdRollback(args []string) int {
	all, err := installedVersions()
	if err != nil {
		fmt.Fprintf(os.Stderr, "apteva rollback: %v\n", err)
		return 1
	}
	if len(all) == 0 {
		fmt.Fprintln(os.Stderr, "apteva rollback: no versions on disk.")
		return 1
	}
	active := activeVersion()

	var target string
	switch len(args) {
	case 0:
		// Default: roll back to the prior version (the highest
		// semver that isn't the active one). If only one version
		// is on disk, error — there's nowhere to go.
		for _, v := range all {
			if v != active {
				target = v
				break
			}
		}
		if target == "" {
			fmt.Fprintln(os.Stderr, "apteva rollback: only one version on disk; nothing to roll back to.")
			fmt.Fprintln(os.Stderr, "Pass an explicit version, or run `apteva update` first.")
			return 1
		}
	case 1:
		target = args[0]
		// Allow a leading "v" — folks paste tags here.
		if len(target) > 0 && (target[0] == 'v' || target[0] == 'V') {
			target = target[1:]
		}
	default:
		fmt.Fprintln(os.Stderr, "usage: apteva rollback [<version>]")
		return 2
	}

	found := false
	for _, v := range all {
		if v == target {
			found = true
			break
		}
	}
	if !found {
		fmt.Fprintf(os.Stderr, "apteva rollback: version %q not on disk.\n", target)
		fmt.Fprintln(os.Stderr, "Available versions:")
		for _, v := range all {
			fmt.Fprintf(os.Stderr, "  %s\n", v)
		}
		return 1
	}

	if target == active {
		fmt.Fprintf(os.Stderr, "apteva rollback: already on v%s.\n", active)
		return 0
	}

	if err := pointSymlinks(target); err != nil {
		fmt.Fprintf(os.Stderr, "apteva rollback: %v\n", err)
		return 1
	}
	fmt.Fprintf(os.Stderr, "✓ bin/current → versions/%s\n", target)

	// Restart whatever's running so the new binaries take effect.
	// Service install: send SIGTERM via systemctl/launchctl; the
	// supervisor re-execs through bin/current.
	// Foreground: kill the running stack and tell the operator to
	// re-run apteva.
	if scope, ok := detectInstalledScope(); ok {
		fmt.Fprintln(os.Stderr, "  restarting service…")
		_ = restartServiceForRollback(scope)
	} else if isStackRunning() {
		fmt.Fprintln(os.Stderr, "  stopping running stack…")
		stopRunningStack()
		fmt.Fprintln(os.Stderr, "  re-run `apteva` to start with the rolled-back version.")
	}

	// Reset the boot-attempts counter so the auto-revert path
	// doesn't immediately flip us forward again on a problematic
	// active version.
	_ = writeBootAttempts(0)
	_ = writeLastGoodVersion(target)
	return 0
}

// restartServiceForRollback is a thin shim — the runServiceCmd
// path is general but goes through stderr-prefixed logging that
// looks weird inside a rollback message. Issue the equivalent
// commands silently.
func restartServiceForRollback(scope serviceScope) error {
	switch runtime.GOOS {
	case "linux":
		return systemctl(scope, "restart", serviceUnitName)
	case "darwin":
		return launchctl(scope, "kickstart")
	}
	return nil
}

// isStackRunning returns true if anything is listening on the
// default apteva-server port. We don't try to be more clever than
// that — if the operator is running on a custom port, they'll
// already have stopped it themselves before invoking rollback.
func isStackRunning() bool {
	conn, err := net.DialTimeout("tcp",
		net.JoinHostPort("127.0.0.1", strconv.Itoa(defaultServerPort)),
		200*time.Millisecond,
	)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}
