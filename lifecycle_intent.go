package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type lifecycleIntent struct {
	Reason    string    `json:"reason"`
	Policy    string    `json:"agent_policy,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at"`
}

func normalizeLifecyclePolicy(raw string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "default":
		return "", nil
	case "restart", "rolling", "preserve":
		return strings.ToLower(strings.TrimSpace(raw)), nil
	default:
		return "", fmt.Errorf("agents policy must be restart, rolling, or preserve")
	}
}

func writeLifecycleIntent(reason, policy string) error {
	policy, err := normalizeLifecyclePolicy(policy)
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	intent := lifecycleIntent{Reason: reason, Policy: policy, CreatedAt: now, ExpiresAt: now.Add(5 * time.Minute)}
	raw, err := json.Marshal(intent)
	if err != nil {
		return err
	}
	path := filepath.Join(aptevaDir(), "shutdown-intent.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func clearLifecycleIntent() {
	_ = os.Remove(filepath.Join(aptevaDir(), "shutdown-intent.json"))
}
