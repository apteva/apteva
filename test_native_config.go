package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Optional app-owned commands extend the standard Go tiers (for example Bun
// unit tests or browser integration tests). Commands are argv, never shell text.
func nativeExtraCommands(appDir string, tier int) ([][]string, error) {
	raw, err := os.ReadFile(filepath.Join(appDir, "apteva.test.yaml"))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var config struct {
		Native map[string][][]string `yaml:"native"`
	}
	dec := yaml.NewDecoder(strings.NewReader(string(raw)))
	dec.KnownFields(true)
	if err := dec.Decode(&config); err != nil {
		return nil, err
	}
	for key, commands := range config.Native {
		if key != "1" && key != "2" {
			return nil, fmt.Errorf("unsupported native tier %q", key)
		}
		for _, argv := range commands {
			if len(argv) == 0 || strings.TrimSpace(argv[0]) == "" {
				return nil, fmt.Errorf("empty native command in tier %s", key)
			}
		}
	}
	return config.Native[strconv.Itoa(tier)], nil
}
