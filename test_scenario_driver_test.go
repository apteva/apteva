package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestScenarioDriverProcess(t *testing.T) {
	if os.Getenv("APTEVA_TEST_DRIVER_HELPER") != "1" {
		return
	}
	fmt.Println(os.Getenv("APTEVA_TEST_SERVER_API_KEY"))
	if os.Getenv("APTEVA_TEST_DRIVER_BLOCK") == "1" {
		time.Sleep(time.Minute)
	}
	if os.Getenv("APTEVA_TEST_DRIVER_FAIL") == "1" {
		os.Exit(3)
	}
}
func TestScenarioDriverExitAndRedaction(t *testing.T) {
	t.Setenv("APTEVA_TEST_DRIVER_HELPER", "1")
	for _, failure := range []string{"0", "1"} {
		t.Run(failure, func(t *testing.T) {
			t.Setenv("APTEVA_TEST_DRIVER_FAIL", failure)
			d, err := startScenarioDriver(context.Background(), []string{os.Args[0], "-test.run=^TestScenarioDriverProcess$"}, t.TempDir(), &testServer{addr: "localhost:1", apiKey: "secret-driver-test"}, 3, "app", nil, []int64{4})
			if err != nil {
				t.Fatal(err)
			}
			<-d.done
			done, err := d.Result()
			if !done || (failure == "1") != (err != nil) {
				t.Fatalf("done=%v err=%v", done, err)
			}
			d.Stop()
			if out := d.Output("secret-driver-test"); strings.Contains(out, "secret-driver-test") || !strings.Contains(out, "[redacted]") {
				t.Fatalf("unredacted driver output")
			}
		})
	}
}
func TestScenarioDriverCancellation(t *testing.T) {
	t.Setenv("APTEVA_TEST_DRIVER_HELPER", "1")
	t.Setenv("APTEVA_TEST_DRIVER_BLOCK", "1")
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	d, err := startScenarioDriver(ctx, []string{os.Args[0], "-test.run=^TestScenarioDriverProcess$"}, t.TempDir(), &testServer{addr: "localhost:1"}, 3, "app", nil, []int64{4})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-d.done:
	case <-time.After(5 * time.Second):
		d.Stop()
		t.Fatal("driver survived deadline")
	}
	if _, err := d.Result(); err == nil {
		t.Fatal("cancelled driver passed")
	}
	d.Stop()
}
