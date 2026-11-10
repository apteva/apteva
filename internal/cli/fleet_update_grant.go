package cli

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

func cmdFleetUpdateGrant(args []string) int {
	if len(args) == 2 && args[0] == "reconcile" {
		if runtime.GOOS != "linux" {
			fmt.Fprintln(os.Stderr, "Reconcile Fleet updates on the Linux host")
			return 1
		}
		if err := reconcileFleetUpdate(args[1]); err != nil {
			fmt.Fprintf(os.Stderr, "Fleet update: %v\n", err)
			return 1
		}
		fmt.Println("Reconciliation recorded. Fleet can now close the request.")
		return 0
	}
	if len(args) != 1 || (args[0] != "issue" && args[0] != "revoke") {
		fmt.Fprintln(os.Stderr, "Usage: apteva update fleet-grant issue|revoke|reconcile <request-id>")
		return 2
	}
	issue := args[0] == "issue"
	if runtime.GOOS != "linux" || (issue && detectInstallMethod() != installVersioned) {
		fmt.Fprintln(os.Stderr, "Fleet update grants require a versioned Apteva installation on Linux")
		return 1
	}
	token, err := writeFleetUpdateGrant(aptevaDir(), issue)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Fleet update grant: %v\n", err)
		return 1
	}
	if token != "" {
		fmt.Println(token)
	} else {
		fmt.Println("Fleet update access revoked.")
	}
	return 0
}

func writeFleetUpdateGrant(home string, issue bool) (string, error) {
	var token, digest string
	if issue {
		var random [32]byte
		if _, err := rand.Read(random[:]); err != nil {
			return "", err
		}
		token = "fup_" + hex.EncodeToString(random[:])
		hash := sha256.Sum256([]byte(token))
		digest = hex.EncodeToString(hash[:])
	}
	// Retain the policy file on revocation. Removing it would restore the
	// ordinary dashboard/API-key path for starting an update.
	file, err := os.CreateTemp(home, ".fleet-update-grant-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(file.Name())
	_, err = file.WriteString(digest)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	return token, os.Rename(file.Name(), filepath.Join(home, "fleet-update-grant"))
}
