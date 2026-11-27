package cli

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fakeResetServer writes a stand-in apteva-server that records its
// arguments, environment and stdin, then exits with the given status.
func fakeResetServer(t *testing.T, exitCode int, stderr string) (bin, record string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell stand-in for apteva-server")
	}
	dir := t.TempDir()
	record = filepath.Join(dir, "record")
	bin = filepath.Join(dir, "apteva-server")
	script := "#!/bin/sh\n" +
		"{ echo \"args=$*\"; echo \"home=$APTEVA_HOME\"; echo \"db=$DB_PATH\"; printf 'stdin='; cat; } > '" + record + "'\n" +
		"printf '%s' '" + stderr + "' >&2\n" +
		"exit " + string(rune('0'+exitCode)) + "\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin, record
}

func resetHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "apteva.db"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	return home
}

func resetIO(bin string, stdin string, terminal bool, typed ...string) (resetPasswordIO, *bytes.Buffer, *bytes.Buffer) {
	var stdout, stderr bytes.Buffer
	prompts := 0
	return resetPasswordIO{
		stdin:      strings.NewReader(stdin),
		stdout:     &stdout,
		stderr:     &stderr,
		isTerminal: func() bool { return terminal },
		readPassword: func(string) (string, error) {
			if prompts >= len(typed) {
				return "", errors.New("no more input")
			}
			prompts++
			return typed[prompts-1], nil
		},
		serverBinary: func(string) string { return bin },
	}, &stdout, &stderr
}

func TestResetPasswordPassesThePasswordOnStdinAndTheDataFolderInTheEnvironment(t *testing.T) {
	bin, record := fakeResetServer(t, 0, "")
	home := resetHome(t)
	rio, _, stderr := resetIO(bin, "", true, "a new password", "a new password")
	if code := runResetPasswordCommand([]string{"--email", "admin@example.test", "--data-dir", home}, rio); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	raw, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	got := string(raw)
	for _, want := range []string{
		"args=--reset-password --email=admin@example.test\n",
		"home=" + home + "\n",
		"db=" + filepath.Join(home, "apteva.db") + "\n",
		"stdin=a new password\n",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("server saw:\n%s\nmissing %q", got, want)
		}
	}
}

func TestResetPasswordReadsStdinOnlyWhenAsked(t *testing.T) {
	bin, record := fakeResetServer(t, 0, "")
	home := resetHome(t)

	rio, _, stderr := resetIO(bin, "piped password\n", false)
	if code := runResetPasswordCommand([]string{"--email", "a@example.test", "--data-dir", home}, rio); code != 1 || !strings.Contains(stderr.String(), "--password-stdin") {
		t.Fatalf("non-terminal stdin without --password-stdin: exit %d, %s", code, stderr.String())
	}
	if _, err := os.Stat(record); err == nil {
		t.Fatal("server ran without a confirmed password")
	}

	rio, _, stderr = resetIO(bin, "piped password\n", false)
	if code := runResetPasswordCommand([]string{"--email", "a@example.test", "--data-dir", home, "--password-stdin"}, rio); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	if raw, _ := os.ReadFile(record); !strings.Contains(string(raw), "stdin=piped password\n") {
		t.Fatalf("server saw %q", raw)
	}
}

func TestResetPasswordRefusesBadInputBeforeTouchingTheServer(t *testing.T) {
	bin, record := fakeResetServer(t, 0, "")
	home := resetHome(t)
	cases := []struct {
		name  string
		args  []string
		typed []string
		code  int
		want  string
	}{
		{"no email", []string{"--data-dir", home}, nil, 2, "Usage:"},
		{"mismatch", []string{"--email", "a@example.test", "--data-dir", home}, []string{"first password", "other password"}, 1, "do not match"},
		{"too short", []string{"--email", "a@example.test", "--data-dir", home}, []string{"short", "short"}, 1, "at least 8"},
		{"no database", []string{"--email", "a@example.test", "--data-dir", t.TempDir()}, []string{"long enough", "long enough"}, 1, "no Apteva database"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rio, _, stderr := resetIO(bin, "", true, tc.typed...)
			if code := runResetPasswordCommand(tc.args, rio); code != tc.code || !strings.Contains(stderr.String(), tc.want) {
				t.Fatalf("exit %d, stderr %q; want %d and %q", code, stderr.String(), tc.code, tc.want)
			}
		})
	}
	if _, err := os.Stat(record); err == nil {
		t.Fatal("server ran for invalid input")
	}
}

func TestResetPasswordExplainsAnOldServer(t *testing.T) {
	bin, _ := fakeResetServer(t, 2, `apteva-server: unsupported argument "--reset-password"`)
	rio, _, stderr := resetIO(bin, "", true, "long enough", "long enough")
	if code := runResetPasswordCommand([]string{"--email", "a@example.test", "--data-dir", resetHome(t)}, rio); code != 1 || !strings.Contains(stderr.String(), "apteva update") {
		t.Fatalf("exit %d, stderr %q", code, stderr.String())
	}
}

func TestResetPasswordPrefersTheServerInstalledInTheDataFolder(t *testing.T) {
	home := t.TempDir()
	installed := filepath.Join(home, "bin", "apteva-server")
	if err := os.MkdirAll(filepath.Dir(installed), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(installed, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := resetPasswordServerBinary(home); got != installed {
		t.Fatalf("server binary %q, want %q", got, installed)
	}
}
