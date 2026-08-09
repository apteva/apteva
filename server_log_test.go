package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestServerLogWriterBoundsActiveAndRotatedFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "server.log")
	w, err := newServerLogWriter(path, 32)
	if err != nil {
		t.Fatalf("newServerLogWriter: %v", err)
	}
	for i := 0; i < 12; i++ {
		if _, err := w.Write([]byte("0123456789")); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	assertServerLogAtMost(t, path, 32)
	assertServerLogAtMost(t, path+".1", 32)
}

func TestServerLogWriterPreservesTailOfExistingOversizedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "server.log")
	seed := "0123456789abcdefghijklmnopqrstuvwxyz"
	if err := os.WriteFile(path, []byte(seed), 0o644); err != nil {
		t.Fatalf("seed server log: %v", err)
	}
	w, err := newServerLogWriter(path, 12)
	if err != nil {
		t.Fatalf("newServerLogWriter: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	active, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read active log: %v", err)
	}
	if len(active) != 0 {
		t.Fatalf("active log has %d bytes after startup rotation, want 0", len(active))
	}
	rotated, err := os.ReadFile(path + ".1")
	if err != nil {
		t.Fatalf("read rotated log: %v", err)
	}
	if got, want := string(rotated), seed[len(seed)-12:]; got != want {
		t.Fatalf("rotated tail = %q, want %q", got, want)
	}
}

func TestServerLogWriterSerializesConcurrentStdoutAndStderr(t *testing.T) {
	path := filepath.Join(t.TempDir(), "server.log")
	w, err := newServerLogWriter(path, 4096)
	if err != nil {
		t.Fatalf("newServerLogWriter: %v", err)
	}

	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(marker byte) {
			defer wg.Done()
			line := []byte(strings.Repeat(string(marker), 15) + "\n")
			for j := 0; j < 200; j++ {
				if _, err := w.Write(line); err != nil {
					errs <- err
					return
				}
			}
		}(byte('a' + i))
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent write: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	assertServerLogAtMost(t, path, 4096)
	assertServerLogAtMost(t, path+".1", 4096)
}

func TestServerLogWriterRecoversAfterRotationFailure(t *testing.T) {
	path := filepath.Join(t.TempDir(), "server.log")
	w, err := newServerLogWriter(path, 8)
	if err != nil {
		t.Fatalf("newServerLogWriter: %v", err)
	}
	if _, err := w.Write([]byte("12345678")); err != nil {
		t.Fatalf("initial write: %v", err)
	}
	wantErr := errors.New("injected rotation failure")
	w.rotatePath = func(string) error { return wantErr }
	if _, err := w.Write([]byte("x")); !errors.Is(err, wantErr) {
		t.Fatalf("rotation error = %v, want %v", err, wantErr)
	}

	// The failed rotation reopened the original active file. A later retry can
	// rotate normally instead of leaving stdout/stderr permanently broken.
	w.rotatePath = rotateServerLogPath
	if _, err := w.Write([]byte("z")); err != nil {
		t.Fatalf("write after rotation recovery: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	assertServerLogAtMost(t, path, 8)
	assertServerLogAtMost(t, path+".1", 8)
}

func TestServerLogWriterCloseIsIdempotentAndStopsWrites(t *testing.T) {
	w, err := newServerLogWriter(filepath.Join(t.TempDir(), "server.log"), 32)
	if err != nil {
		t.Fatalf("newServerLogWriter: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("first close: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}
	if _, err := w.Write([]byte("after shutdown")); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("write after close = %v, want os.ErrClosed", err)
	}
}

func TestServerLogCaptureDrainsAndCloses(t *testing.T) {
	path := filepath.Join(t.TempDir(), "server.log")
	capture, err := newServerLogCapture(path, 64)
	if err != nil {
		t.Fatalf("newServerLogCapture: %v", err)
	}
	if _, err := capture.childWriter.Write([]byte("stdout\nstderr\n")); err != nil {
		t.Fatalf("write captured output: %v", err)
	}
	capture.ReleaseParentWriter()
	if err := capture.Close(); err != nil {
		t.Fatalf("close capture: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read captured log: %v", err)
	}
	if string(got) != "stdout\nstderr\n" {
		t.Fatalf("captured log = %q", got)
	}
	if err := capture.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}
}

func TestServerLogCaptureCombinesProcessStdoutAndStderr(t *testing.T) {
	path := filepath.Join(t.TempDir(), "server.log")
	capture, err := newServerLogCapture(path, 4096)
	if err != nil {
		t.Fatalf("newServerLogCapture: %v", err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=TestServerLogCaptureHelperProcess")
	cmd.Env = append(os.Environ(), "APTEVA_TEST_SERVER_LOG_HELPER=1")
	capture.Attach(cmd)
	if err := cmd.Start(); err != nil {
		_ = capture.Close()
		t.Fatalf("start helper: %v", err)
	}
	capture.ReleaseParentWriter()
	if err := cmd.Wait(); err != nil {
		_ = capture.Close()
		t.Fatalf("wait helper: %v", err)
	}
	if err := capture.Close(); err != nil {
		t.Fatalf("close capture: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read captured log: %v", err)
	}
	text := string(got)
	for _, want := range []string{"stdout-0", "stdout-99", "stderr-0", "stderr-99"} {
		if !strings.Contains(text, want) {
			t.Fatalf("captured log missing %q", want)
		}
	}
}

func TestServerLogCaptureHelperProcess(t *testing.T) {
	if os.Getenv("APTEVA_TEST_SERVER_LOG_HELPER") != "1" {
		return
	}
	var wg sync.WaitGroup
	for i, output := range []*os.File{os.Stdout, os.Stderr} {
		wg.Add(1)
		go func(index int, destination *os.File) {
			defer wg.Done()
			name := "stdout"
			if index == 1 {
				name = "stderr"
			}
			for line := 0; line < 100; line++ {
				_, _ = fmt.Fprintf(destination, "%s-%d\n", name, line)
			}
		}(i, output)
	}
	wg.Wait()
}

func assertServerLogAtMost(t *testing.T, path string, max int64) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	if info.Size() > max {
		t.Fatalf("%s is %d bytes, want <= %d", path, info.Size(), max)
	}
}
