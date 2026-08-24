package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// NativeTestResult is the machine-readable result emitted by `apteva test
// --tier 1|2`. Output is retained for CI artifacts and --json consumers.
type NativeTestResult struct {
	Tier      int      `json:"tier"`
	OK        bool     `json:"ok"`
	ElapsedMS int64    `json:"elapsed_ms"`
	Command   []string `json:"command"`
	Output    string   `json:"output,omitempty"`
}

func parseTestTiers(raw string) (map[int]bool, error) {
	raw = strings.TrimSpace(strings.ToLower(raw))
	if raw == "all" {
		return map[int]bool{1: true, 2: true, 3: true}, nil
	}
	if raw == "" {
		return nil, errors.New("--tier cannot be empty")
	}
	out := map[int]bool{}
	for _, token := range strings.Split(raw, ",") {
		switch strings.TrimSpace(token) {
		case "1":
			out[1] = true
		case "2":
			out[2] = true
		case "3":
			out[3] = true
		default:
			return nil, fmt.Errorf("unsupported tier %q (use 1, 2, 3, all, or a comma-separated list)", strings.TrimSpace(token))
		}
	}
	return out, nil
}

func resolveNativeAppDir(target, fallback string) (string, error) {
	candidates := []string{target}
	if strings.TrimSpace(fallback) != "" && fallback != target {
		candidates = append(candidates, fallback)
	}
	for _, candidate := range candidates {
		abs, err := filepath.Abs(candidate)
		if err != nil {
			continue
		}
		info, err := os.Stat(abs)
		if err != nil || !info.IsDir() {
			continue
		}
		if _, err := os.Stat(filepath.Join(abs, "apteva.yaml")); err == nil {
			return abs, nil
		}
	}
	return "", fmt.Errorf("%q is not an app directory containing apteva.yaml", target)
}

func nativeTierCommand(appDir string, tier int, profile string) ([]string, error) {
	if _, err := os.Stat(filepath.Join(appDir, "go.mod")); err != nil {
		return nil, fmt.Errorf("native tiers currently require a Go app (missing %s)", filepath.Join(appDir, "go.mod"))
	}
	profile = strings.TrimSpace(strings.ToLower(profile))
	switch tier {
	case 1:
		return []string{"go", "test", "-short", "./..."}, nil
	case 2:
		switch profile {
		case "", "default":
			return []string{"go", "test", "-tags=integration", "./..."}, nil
		case "live-carrier":
			return []string{"go", "test", "-tags=integration,livecarrier", "-count=1", "./..."}, nil
		default:
			return nil, fmt.Errorf("unknown Tier 2 profile %q", profile)
		}
	default:
		return nil, fmt.Errorf("tier %d is not a native tier", tier)
	}
}

func runNativeTests(ctx context.Context, appDir, profile string, tiers map[int]bool, jsonOutput bool, progress io.Writer) ([]NativeTestResult, bool) {
	requested := []int{}
	for _, tier := range []int{1, 2} {
		if tiers[tier] {
			requested = append(requested, tier)
		}
	}
	sort.Ints(requested)
	results := make([]NativeTestResult, 0, len(requested))
	allOK := true
	for _, tier := range requested {
		command, err := nativeTierCommand(appDir, tier, profile)
		if err != nil {
			fmt.Fprintf(progress, "Tier %d: %v\n", tier, err)
			results = append(results, NativeTestResult{Tier: tier, OK: false, Output: err.Error()})
			allOK = false
			break
		}
		fmt.Fprintf(progress, "▶ Tier %d · %s\n", tier, strings.Join(command, " "))
		started := time.Now()
		cmd := exec.CommandContext(ctx, command[0], command[1:]...)
		cmd.Dir = appDir
		cmd.Env = os.Environ()
		var output bytes.Buffer
		if jsonOutput {
			cmd.Stdout = &output
			cmd.Stderr = &output
		} else {
			cmd.Stdout = io.MultiWriter(progress, &output)
			cmd.Stderr = io.MultiWriter(progress, &output)
		}
		err = cmd.Run()
		result := NativeTestResult{
			Tier: tier, OK: err == nil, ElapsedMS: time.Since(started).Milliseconds(),
			Command: command, Output: output.String(),
		}
		results = append(results, result)
		if err != nil {
			allOK = false
			if !jsonOutput {
				fmt.Fprintf(progress, "✗ Tier %d failed: %v\n", tier, err)
			}
			break
		}
		if !jsonOutput {
			fmt.Fprintf(progress, "✓ Tier %d passed in %s\n", tier, time.Since(started).Round(time.Millisecond))
		}
	}
	return results, allOK
}

func printNativeTestOutcome(results []NativeTestResult, ok, jsonOutput bool, stdout, stderr io.Writer) {
	if jsonOutput {
		_ = json.NewEncoder(stdout).Encode(map[string]any{"native_results": results, "ok": ok})
		return
	}
	passed := 0
	for _, result := range results {
		if result.OK {
			passed++
		}
	}
	fmt.Fprintf(stderr, "\n=== summary ===\n%d/%d native tiers passed\n", passed, len(results))
}
