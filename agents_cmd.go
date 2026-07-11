package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
)

func cmdAgents(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: apteva agents update-core <id>|--project <id>|--all [--delay 15]")
		return 2
	}
	switch args[0] {
	case "update-core":
		return cmdAgentsUpdateCore(args[1:])
	case "rollout-status":
		return cmdAgentsRolloutRequest(http.MethodGet, nil)
	case "rollout-cancel":
		return cmdAgentsRolloutRequest(http.MethodDelete, nil)
	default:
		fmt.Fprintf(os.Stderr, "unknown agents command %q\n", args[0])
		return 2
	}
}

func cmdAgentsUpdateCore(args []string) int {
	fs := flag.NewFlagSet("agents update-core", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	projectID := fs.String("project", "", "update outdated agents in this project")
	all := fs.Bool("all", false, "update all outdated agents (admin only)")
	delay := fs.Int("delay", -1, "seconds between agents (default: server setting)")
	agentIDArg := ""
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		agentIDArg = args[0]
		args = args[1:]
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if agentIDArg == "" && fs.NArg() == 1 {
		agentIDArg = fs.Arg(0)
	}
	body := map[string]any{}
	if *delay >= 0 {
		body["delay_seconds"] = *delay
	}
	if *all {
		body["all"] = true
	} else if *projectID != "" {
		body["project_id"] = *projectID
	} else if agentIDArg != "" {
		id, err := strconv.ParseInt(agentIDArg, 10, 64)
		if err != nil || id <= 0 {
			fmt.Fprintln(os.Stderr, "agent id must be a positive integer")
			return 2
		}
		body["agent_ids"] = []int64{id}
	} else {
		fmt.Fprintln(os.Stderr, "provide an agent id, --project, or --all")
		return 2
	}
	raw, _ := json.Marshal(body)
	return cmdAgentsRolloutRequest(http.MethodPost, raw)
}

func cmdAgentsRolloutRequest(method string, body []byte) int {
	cfg := loadAptevaConfig()
	base := strings.TrimRight(cfg.ServerURL, "/")
	if base == "" || !cfg.Remote {
		port := cfg.ServerPort
		if port == 0 {
			port = defaultServerPort
		}
		base = fmt.Sprintf("http://127.0.0.1:%d", port)
	}
	req, _ := http.NewRequest(method, base+"/api/agents/core-rollout", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	}
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "request failed: %v\n", err)
		return 1
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		fmt.Fprintf(os.Stderr, "HTTP %d: %s\n", resp.StatusCode, strings.TrimSpace(string(raw)))
		return 1
	}
	var pretty bytes.Buffer
	if json.Indent(&pretty, raw, "", "  ") == nil {
		fmt.Println(pretty.String())
	} else {
		fmt.Println(string(raw))
	}
	return 0
}
