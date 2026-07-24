package main

import (
	"strings"
	"testing"
)

func TestParseCLIInvocationRecognizesCommandsAndRunFlags(t *testing.T) {
	tests := []struct {
		name string
		args []string
		mode cliInvocationMode
		rest []string
	}{
		{name: "no args", mode: cliModeRun},
		{name: "normal flag", args: []string{"--port", "5281"}, mode: cliModeRun},
		{name: "help flag", args: []string{"--help"}, mode: cliModeRun},
		{name: "test", args: []string{"test", "--provider", "codex"}, mode: cliModeTest, rest: []string{"--provider", "codex"}},
		{name: "update", args: []string{"update"}, mode: cliModeUpdate},
		{name: "service", args: []string{"service", "status"}, mode: cliModeService, rest: []string{"status"}},
		{name: "agents", args: []string{"agents", "rollout-status"}, mode: cliModeAgents, rest: []string{"rollout-status"}},
		{name: "versions", args: []string{"versions"}, mode: cliModeVersions},
		{name: "rollback", args: []string{"rollback", "0.26.0"}, mode: cliModeRollback, rest: []string{"0.26.0"}},
		{name: "version word", args: []string{"version"}, mode: cliModeVersion},
		{name: "version flag", args: []string{"--version"}, mode: cliModeVersion},
		{name: "version short", args: []string{"-v"}, mode: cliModeVersion},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseCLIInvocation(tt.args)
			if err != nil {
				t.Fatalf("parseCLIInvocation(%q): %v", tt.args, err)
			}
			if got.mode != tt.mode {
				t.Fatalf("mode=%v, want %v", got.mode, tt.mode)
			}
			if strings.Join(got.args, "\x00") != strings.Join(tt.rest, "\x00") {
				t.Fatalf("args=%q, want %q", got.args, tt.rest)
			}
		})
	}
}

func TestParseCLIInvocationRejectsUnknownCommandsBeforeStartup(t *testing.T) {
	tests := [][]string{
		{"ingress"},
		{"ingress", "--help"},
		{"serve"},
		{"udpate"},
		{"version", "extra"},
		{"--version", "extra"},
	}
	for _, args := range tests {
		t.Run(strings.Join(args, "_"), func(t *testing.T) {
			if got, err := parseCLIInvocation(args); err == nil {
				t.Fatalf("parseCLIInvocation(%q) unexpectedly succeeded: %+v", args, got)
			}
		})
	}
}
