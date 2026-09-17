package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// scenarioDriver is a client workflow, not another server/agent harness. It
// receives only the resources allocated by this scenario. No shell is used.
type scenarioDriver struct {
	cmd    *exec.Cmd
	output bytes.Buffer
	done   chan struct{}
	err    error
	stop   sync.Once
}

func startScenarioDriver(ctx context.Context, argv []string, dir string, server *testServer, installID int64, app string, deps []depBundle, agents []int64) (*scenarioDriver, error) {
	if len(argv) == 0 || strings.TrimSpace(argv[0]) == "" {
		return nil, fmt.Errorf("empty driver command")
	}
	ids := map[string]int64{app: installID}
	for _, dep := range deps {
		ids[dep.name] = dep.installID
	}
	installsJSON, _ := json.Marshal(ids)
	agentsJSON, _ := json.Marshal(agents)
	d := &scenarioDriver{done: make(chan struct{})}
	d.cmd = exec.CommandContext(ctx, argv[0], argv[1:]...)
	d.cmd.Dir = dir
	d.cmd.Env = append(os.Environ(),
		"APTEVA_TEST_SERVER_URL=http://"+server.addr,
		"APTEVA_TEST_SERVER_API_KEY="+server.apiKey,
		"APTEVA_TEST_PROJECT_ID="+server.projectID,
		"APTEVA_TEST_INSTALL_ID="+strconv.FormatInt(installID, 10),
		"APTEVA_TEST_INSTALLS="+string(installsJSON),
		"APTEVA_TEST_AGENT_IDS="+string(agentsJSON))
	d.cmd.Stdout = &d.output
	d.cmd.Stderr = &d.output
	setProcGroup(d.cmd)
	d.cmd.Cancel = func() error { killProcGroup(d.cmd, true); return nil }
	if err := d.cmd.Start(); err != nil {
		return nil, err
	}
	go func() { d.err = d.cmd.Wait(); close(d.done) }()
	return d, nil
}
func (d *scenarioDriver) Result() (bool, error) {
	select {
	case <-d.done:
		return true, d.err
	default:
		return false, nil
	}
}
func (d *scenarioDriver) Stop() {
	d.stop.Do(func() {
		if done, _ := d.Result(); !done {
			killProcGroup(d.cmd, true)
		}
		<-d.done
	})
}
func (d *scenarioDriver) Output(key string) string {
	<-d.done
	text := d.output.String()
	if key != "" {
		text = strings.ReplaceAll(text, key, "[redacted]")
	}
	return text
}
func scenarioInstallIDs(primary int64, deps []depBundle) []int64 {
	ids := []int64{primary}
	for _, d := range deps {
		ids = append(ids, d.installID)
	}
	return ids
}
func fetchScenarioTelemetry(server *testServer, agents []int64, since time.Time) ([]telemetryEvent, error) {
	var all []telemetryEvent
	for _, id := range agents {
		rows, err := fetchStoredTelemetry(server, id, since)
		if err != nil {
			return nil, err
		}
		all = append(all, rows...)
	}
	return all, nil
}
