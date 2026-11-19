//go:build windows

package cli

import "fmt"

// Service-driven updates are unavailable on Windows (acquireUpdateLock always
// fails there); these keep the shared update code compiling.

type releaseCheckOptions struct {
	target, version string
	job             *dashboardUpdateJob
	full            bool
}

func runReleaseCheck(releaseCheckOptions) (*updateCheckSummary, error) {
	return nil, fmt.Errorf("unsupported platform")
}
func newCLIUpdateJob(string, string, string) (*dashboardUpdateJob, error) { return nil, nil }
func settleInterruptedCLIJob(*dashboardUpdateJob)                         {}
func (*dashboardUpdateJob) dashboard() bool                               { return false }
func (*dashboardUpdateJob) heartbeat() func()                             { return func() {} }
func (*dashboardUpdateJob) stopOnInterrupt() func()                       { return func() {} }
func (*dashboardUpdateJob) finish(int)                                    {}
func (*dashboardUpdateJob) recordCheck(*updateCheckSummary)               {}
func (*dashboardUpdateJob) checkSummary() *updateCheckSummary             { return nil }
