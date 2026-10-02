//go:build windows

package main

import (
	"fmt"
	"os"
	"sync"
	"time"
)

// Service-driven dashboard updates currently support systemd and launchd.
type dashboardUpdateJob struct {
	ID, State, Target, Backup, Previous string
	SchemaChanged                       bool
	RollbackSafe                        bool
	Request                             struct {
		Port                int
		Method, AgentPolicy string
	}
	mu sync.Mutex
}

func cmdDashboardUpdate([]string) int {
	fmt.Fprintln(os.Stderr, "dashboard updates are unavailable on Windows")
	return 1
}
func acquireUpdateLock() (*os.File, error) {
	return nil, fmt.Errorf("automatic updates are unavailable on Windows")
}
func readUpdateJob() (*dashboardUpdateJob, error)      { return nil, os.ErrNotExist }
func updateJobTerminal(string) bool                    { return true }
func (*dashboardUpdateJob) phase(string, string) error { return nil }
func (*dashboardUpdateJob) recoverActivation(serviceScope, error) error {
	return fmt.Errorf("unsupported platform")
}
func validateUpdateService(any) error          { return fmt.Errorf("unsupported platform") }
func updateScope(string) (serviceScope, error) { return scopeAuto, fmt.Errorf("unsupported platform") }
func waitForUpdateVersion(int, string, time.Duration) error {
	return fmt.Errorf("unsupported platform")
}
