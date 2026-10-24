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
func deployThroughHost(string, string, *dashboardUpdateJob, string) error {
	return fmt.Errorf("hosted deployments are unavailable on Windows")
}
func validateThroughHost(string, string) error {
	return fmt.Errorf("hosted deployments are unavailable on Windows")
}
