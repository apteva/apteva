package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWriteLifecycleIntent(t *testing.T) {
	t.Setenv("APTEVA_HOME", t.TempDir())
	if err := writeLifecycleIntent("update", "rolling"); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(aptevaDir(), "shutdown-intent.json"))
	if err != nil {
		t.Fatal(err)
	}
	var intent lifecycleIntent
	if err := json.Unmarshal(raw, &intent); err != nil {
		t.Fatal(err)
	}
	if intent.Reason != "update" || intent.Policy != "rolling" {
		t.Fatalf("unexpected intent: %#v", intent)
	}
	if time.Until(intent.ExpiresAt) < 4*time.Minute {
		t.Fatalf("intent expiry is too short: %s", intent.ExpiresAt)
	}
}

func TestWriteLifecycleIntentRejectsUnknownPolicy(t *testing.T) {
	t.Setenv("APTEVA_HOME", t.TempDir())
	if err := writeLifecycleIntent("update", "parallel"); err == nil {
		t.Fatal("expected invalid policy error")
	}
}

func TestAgentsUpdateCoreAcceptsFlagsAfterPositionalID(t *testing.T) {
	// Parsing reaches the HTTP request instead of failing with the local
	// "provide an agent id" usage error. A closed local port makes the test
	// deterministic without requiring a server.
	t.Setenv("APTEVA_HOME", t.TempDir())
	saveAptevaConfig(AptevaConfig{ServerPort: 1})
	if code := cmdAgentsUpdateCore([]string{"42", "--delay", "0"}); code != 1 {
		t.Fatalf("exit code = %d, want request failure after successful parsing", code)
	}
}
