//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

// setProcGroup makes the command a process group leader.
func setProcGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killProcGroup sends a signal to the entire process group.
func killProcGroup(cmd *exec.Cmd, force bool) {
	pgid := cmd.Process.Pid
	if force {
		syscall.Kill(-pgid, syscall.SIGKILL)
	} else {
		syscall.Kill(-pgid, syscall.SIGTERM)
	}
}

// shutdownSignals returns the OS signals to listen for.
func shutdownSignals() []os.Signal {
	return []os.Signal{syscall.SIGINT, syscall.SIGTERM}
}
