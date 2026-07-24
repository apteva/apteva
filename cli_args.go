package main

import (
	"fmt"
	"strings"
)

type cliInvocationMode int

const (
	cliModeRun cliInvocationMode = iota
	cliModeTest
	cliModeUpdate
	cliModeService
	cliModeAgents
	cliModeVersions
	cliModeRollback
	cliModeVersion
)

type cliInvocation struct {
	mode cliInvocationMode
	args []string
}

// parseCLIInvocation recognizes subcommands before normal dashboard/TUI
// startup is allowed to migrate data, write logs, probe port 5280, or spawn a
// server. Flag-first invocations remain on the normal run path and are parsed
// later by the standard flag package.
func parseCLIInvocation(args []string) (cliInvocation, error) {
	if len(args) == 0 {
		return cliInvocation{mode: cliModeRun}, nil
	}

	first := args[0]
	rest := args[1:]
	switch first {
	case "test":
		return cliInvocation{mode: cliModeTest, args: rest}, nil
	case "update":
		return cliInvocation{mode: cliModeUpdate, args: rest}, nil
	case "service":
		return cliInvocation{mode: cliModeService, args: rest}, nil
	case "agents":
		return cliInvocation{mode: cliModeAgents, args: rest}, nil
	case "versions":
		return cliInvocation{mode: cliModeVersions, args: rest}, nil
	case "rollback":
		return cliInvocation{mode: cliModeRollback, args: rest}, nil
	case "version", "--version", "-v":
		if len(rest) != 0 {
			return cliInvocation{}, fmt.Errorf("%s does not accept additional arguments", first)
		}
		return cliInvocation{mode: cliModeVersion}, nil
	default:
		if strings.HasPrefix(first, "-") {
			return cliInvocation{mode: cliModeRun}, nil
		}
		return cliInvocation{}, fmt.Errorf("unknown command %q", first)
	}
}
