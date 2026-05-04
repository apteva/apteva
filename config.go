package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// AptevaConfig holds the CLI/launcher config at ~/.apteva/apteva.json.
type AptevaConfig struct {
	Capabilities    Capabilities `json:"capabilities"`
	Remote          bool         `json:"remote,omitempty"`
	ServerURL       string       `json:"server_url,omitempty"`  // remote server URL (e.g. "https://agents.example.com")
	ServerPort      int          `json:"server_port,omitempty"` // local server port
	APIKey          string       `json:"api_key,omitempty"`
	InstanceID      int64        `json:"instance_id,omitempty"`
	ProjectID       string       `json:"project_id,omitempty"`
	UserID          int64        `json:"user_id,omitempty"`
	AccountEmail    string       `json:"account_email,omitempty"`    // dashboard login email
	AccountPassword string       `json:"account_password,omitempty"` // dashboard login password
}

type Capabilities struct {
	Tools        bool `json:"tools"`
	Browser      bool `json:"browser"`
	Integrations bool `json:"integrations"`
	Telegram     bool `json:"telegram"`
	Projects     bool `json:"projects"`
}

// expandHome turns "~" or "~/foo" into an absolute path under the
// user's home dir. Bare $HOME / non-tilde paths pass through.
// Used by --data-dir so users can write `apteva --data-dir ~/.apteva-prod`
// without the shell needing to expand the tilde first.
func expandHome(p string) string {
	if p == "~" || (len(p) > 1 && p[:2] == "~/") {
		home, err := os.UserHomeDir()
		if err == nil {
			if p == "~" {
				return home
			}
			return filepath.Join(home, p[2:])
		}
	}
	return p
}

// aptevaDir returns the active data directory, creating it if needed.
//
// Resolution order:
//   1. $APTEVA_HOME — explicit override; lets you run a "prod" install
//      alongside a "dev" one with `apteva --data-dir ~/.apteva-prod`
//      (the flag exports this env before any code calls aptevaDir).
//   2. ~/.apteva — the default, matching every release before the
//      flag was introduced.
func aptevaDir() string {
	if h := os.Getenv("APTEVA_HOME"); h != "" {
		os.MkdirAll(h, 0700)
		return h
	}
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".apteva")
	os.MkdirAll(dir, 0700)
	return dir
}

func aptevaConfigPath() string {
	return filepath.Join(aptevaDir(), "apteva.json")
}

func loadAptevaConfig() AptevaConfig {
	var cfg AptevaConfig
	data, err := os.ReadFile(aptevaConfigPath())
	if err != nil {
		return cfg
	}
	json.Unmarshal(data, &cfg)
	return cfg
}

func saveAptevaConfig(cfg AptevaConfig) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(aptevaConfigPath(), data, 0600)
}
