package cli

import (
	"bufio"
	"bytes"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"golang.org/x/term"
)

// resetPasswordIO is what cmdResetPassword touches outside its arguments, so
// tests can drive it without a terminal or an installed server.
type resetPasswordIO struct {
	stdin        io.Reader
	stdout       io.Writer
	stderr       io.Writer
	isTerminal   func() bool
	readPassword func(prompt string) (string, error)
	serverBinary func(home string) string
}

func cmdResetPassword(args []string) int {
	return runResetPasswordCommand(args, resetPasswordIO{
		stdin:      os.Stdin,
		stdout:     os.Stdout,
		stderr:     os.Stderr,
		isTerminal: func() bool { return term.IsTerminal(int(os.Stdin.Fd())) },
		readPassword: func(prompt string) (string, error) {
			fmt.Fprint(os.Stderr, prompt)
			raw, err := term.ReadPassword(int(os.Stdin.Fd()))
			fmt.Fprintln(os.Stderr)
			return string(raw), err
		},
		serverBinary: resetPasswordServerBinary,
	})
}

const resetPasswordUsage = `Usage:
  apteva reset-password --email EMAIL [--data-dir PATH] [--password-stdin]

Sets a new password for an account on this machine's Apteva, for when it was
forgotten. It needs access to the data folder (default: $APTEVA_HOME or
~/.apteva), not the old password. Every session of that account is signed
out. It works whether or not Apteva is running.

Without --password-stdin it asks for the new password twice.`

// runResetPasswordCommand resolves the data folder and the server binary,
// reads the new password, and hands it to the server's internal
// --reset-password mode on stdin, which owns the database update.
func runResetPasswordCommand(args []string, rio resetPasswordIO) int {
	fs := flag.NewFlagSet("reset-password", flag.ContinueOnError)
	fs.SetOutput(rio.stderr)
	fs.Usage = func() { fmt.Fprintln(rio.stderr, resetPasswordUsage) }
	email := fs.String("email", "", "email of the account to reset")
	dataDir := fs.String("data-dir", "", "Apteva data folder (default: $APTEVA_HOME or ~/.apteva)")
	passwordStdin := fs.Bool("password-stdin", false, "read the new password from standard input")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if fs.NArg() != 0 || strings.TrimSpace(*email) == "" {
		fs.Usage()
		return 2
	}

	home, err := resetPasswordHome(*dataDir)
	if err != nil {
		fmt.Fprintf(rio.stderr, "apteva reset-password: %v\n", err)
		return 2
	}
	dbPath := filepath.Join(home, "apteva.db")
	if _, err := os.Stat(dbPath); err != nil {
		fmt.Fprintf(rio.stderr, "apteva reset-password: no Apteva database at %s (use --data-dir for another install)\n", dbPath)
		return 1
	}
	bin := rio.serverBinary(home)
	if bin == "" {
		fmt.Fprintln(rio.stderr, "apteva reset-password: cannot find the apteva-server binary")
		return 1
	}

	password, err := readNewPassword(*passwordStdin, rio)
	if err != nil {
		fmt.Fprintf(rio.stderr, "apteva reset-password: %v\n", err)
		return 1
	}

	var serverErr bytes.Buffer
	cmd := exec.Command(bin, "--reset-password", "--email="+strings.TrimSpace(*email))
	cmd.Env = append(os.Environ(), "APTEVA_HOME="+home, "DB_PATH="+dbPath)
	cmd.Stdin = strings.NewReader(password + "\n")
	cmd.Stdout = rio.stdout
	cmd.Stderr = io.MultiWriter(rio.stderr, &serverErr)
	if err := cmd.Run(); err != nil {
		if strings.Contains(serverErr.String(), `unsupported argument "--reset-password"`) {
			fmt.Fprintln(rio.stderr, "apteva reset-password: this Apteva version cannot reset passwords yet; run `apteva update` first")
		}
		return 1
	}
	return 0
}

// resetPasswordHome is the data folder to reset in. Unlike aptevaDir it
// never creates the folder: a missing folder means a wrong path.
func resetPasswordHome(flagValue string) (string, error) {
	dir := strings.TrimSpace(flagValue)
	if dir == "" {
		dir = os.Getenv("APTEVA_HOME")
	}
	if dir == "" {
		userHome, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(userHome, ".apteva")
	}
	return filepath.Abs(expandHome(dir))
}

// resetPasswordServerBinary prefers the server installed in that data
// folder, which matches its database, over the one next to this CLI.
func resetPasswordServerBinary(home string) string {
	installed := filepath.Join(home, "bin", "apteva-server")
	if info, err := os.Stat(installed); err == nil && !info.IsDir() {
		return installed
	}
	return findServerBinary("")
}

func readNewPassword(fromStdin bool, rio resetPasswordIO) (string, error) {
	var password string
	switch {
	case fromStdin:
		line, err := bufio.NewReader(rio.stdin).ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return "", fmt.Errorf("read new password: %w", err)
		}
		password = strings.TrimRight(line, "\r\n")
	case rio.isTerminal():
		first, err := rio.readPassword("New password: ")
		if err != nil {
			return "", err
		}
		second, err := rio.readPassword("Repeat new password: ")
		if err != nil {
			return "", err
		}
		if first != second {
			return "", errors.New("the two passwords do not match")
		}
		password = first
	default:
		return "", errors.New("standard input is not a terminal; pass --password-stdin to read the password from it")
	}
	if len(password) < 8 {
		return "", errors.New("password must be at least 8 characters")
	}
	return password, nil
}
