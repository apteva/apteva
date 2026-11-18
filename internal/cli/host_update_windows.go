//go:build windows

package cli

import "fmt"

type hostDeployment struct{ Phase string }
type hostState struct {
	Version, Binary, HostBinary string
	Job                         *hostDeployment
}

func probeHost() (hostState, bool, error) { return hostState{}, false, nil }
func optionalHostBinary(string) string    { return "" }
func deployThroughHost(string, string, *dashboardUpdateJob, string, bool) error {
	return fmt.Errorf("hosted deployments are unavailable on Windows")
}
func validateThroughHost(string, string, bool) (bool, error) {
	return false, fmt.Errorf("hosted deployments are unavailable on Windows")
}

const hostCapabilityRestartMigration = "restart_migration"

func (hostState) supports(string) bool    { return false }
func restartMigrationRequired(error) bool { return false }
func restartServiceOntoRelease(string, string, hostState, string) error {
	return fmt.Errorf("hosted deployments are unavailable on Windows")
}
