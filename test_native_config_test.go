package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNativeExtraCommands(t *testing.T) {
	dir := t.TempDir()
	if commands, err := nativeExtraCommands(dir, 1); err != nil || len(commands) != 0 {
		t.Fatal(commands, err)
	}
	write := func(raw string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, "apteva.test.yaml"), []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("native:\n  '1':\n    - [bun, test, ./ui]\n  '2':\n    - [bun, x, playwright, test]\n")
	if commands, err := nativeExtraCommands(dir, 1); err != nil || len(commands) != 1 || commands[0][2] != "./ui" {
		t.Fatal(commands, err)
	}
	for _, raw := range []string{"native:\n  '3': []\n", "native:\n  '1': [[]]\n", "nativ: {}\n"} {
		write(raw)
		if _, err := nativeExtraCommands(dir, 1); err == nil {
			t.Fatalf("invalid config accepted: %s", raw)
		}
	}
}
