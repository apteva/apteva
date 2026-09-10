package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestScenarioInstallTokenUsesServerCredentialFormat(t *testing.T) {
	if _, err := exec.LookPath("sqlite3"); err != nil {
		t.Skip("sqlite3 required for disposable-server fixture")
	}
	dir := t.TempDir()
	key := strings.Repeat("12", 32)
	if err := os.WriteFile(filepath.Join(dir, ".secret"), []byte(key), 0600); err != nil {
		t.Fatal(err)
	}
	db := filepath.Join(dir, "apteva.db")
	query := func(sql string) string {
		t.Helper()
		cmd := exec.Command("sqlite3", db)
		cmd.Stdin = strings.NewReader(sql)
		output, err := cmd.Output()
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(string(output))
	}
	query("CREATE TABLE app_installs (id INTEGER PRIMARY KEY, app_token_hash TEXT DEFAULT '', app_token_encrypted TEXT DEFAULT ''); INSERT INTO app_installs(id) VALUES(7),(8);")
	token, err := provisionScenarioInstallToken(dir, 7)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(token, "app_") || len(token) != 68 {
		t.Fatal("invalid token shape")
	}
	hash := sha256.Sum256([]byte(token))
	if query("SELECT app_token_hash FROM app_installs WHERE id=7") != hex.EncodeToString(hash[:]) {
		t.Fatal("authentication hash mismatch")
	}
	encrypted, err := hex.DecodeString(query("SELECT app_token_encrypted FROM app_installs WHERE id=7"))
	if err != nil {
		t.Fatal(err)
	}
	decodedKey, _ := hex.DecodeString(key)
	block, _ := aes.NewCipher(decodedKey)
	gcm, _ := cipher.NewGCM(block)
	plain, err := gcm.Open(nil, encrypted[:gcm.NonceSize()], encrypted[gcm.NonceSize():], nil)
	if err != nil || string(plain) != token {
		t.Fatal("server cannot decrypt install token")
	}
	if _, err := provisionScenarioInstallToken(dir, 7); err == nil {
		t.Fatal("overwrote existing credential")
	}
	if query("SELECT length(app_token_hash) FROM app_installs WHERE id=8") != "0" {
		t.Fatal("changed another install")
	}
	if _, err := provisionScenarioInstallToken("", 7); err == nil {
		t.Fatal("accepted non-disposable server")
	}
}
