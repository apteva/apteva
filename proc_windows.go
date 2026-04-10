//go:build windows

package main

import (
	"os"
	"os/exec"
)

// setProcGroup is a no-op on Windows (no Setpgid).
func setProcGroup(cmd *exec.Cmd) {}

// killProcGroup kills the process directly on Windows.
func killProcGroup(cmd *exec.Cmd, force bool) {
	if cmd.Process != nil {
		cmd.Process.Kill()
	}
}

// shutdownSignals returns the OS signals to listen for.
func shutdownSignals() []os.Signal {
	return []os.Signal{os.Interrupt}
}
