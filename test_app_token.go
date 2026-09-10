package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// provisionScenarioInstallToken seeds only an install in the runner's disposable
// server database. Current servers reject the former predictable dev-ID tokens.
// sqlite3 keeps the test-only database access out of the CLI's runtime Go deps.
func provisionScenarioInstallToken(dataDir string, installID int64) (string, error) {
	if dataDir == "" || installID <= 0 {
		return "", fmt.Errorf("temporary server and install ID required")
	}
	keyHex, err := os.ReadFile(filepath.Join(dataDir, ".secret"))
	if err != nil {
		return "", err
	}
	key, err := hex.DecodeString(strings.TrimSpace(string(keyHex)))
	if err != nil {
		return "", fmt.Errorf("invalid test server encryption key")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	token := "app_" + hex.EncodeToString(random)
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	encrypted := hex.EncodeToString(gcm.Seal(nonce, nonce, []byte(token), nil))
	hash := sha256.Sum256([]byte(token))
	// Values are generated hex and a numeric ID. Send SQL on stdin rather than
	// exposing credential material in process arguments. Never overwrite a token.
	query := fmt.Sprintf("UPDATE app_installs SET app_token_hash='%x', app_token_encrypted='%s' WHERE id=%d AND COALESCE(app_token_hash,'')=''; SELECT changes();", hash, encrypted, installID)
	cmd := exec.Command("sqlite3", "-batch", "-cmd", ".timeout 5000", filepath.Join(dataDir, "apteva.db"))
	cmd.Stdin = strings.NewReader(query)
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("provision disposable app token requires sqlite3: %w", err)
	}
	if n, _ := strconv.Atoi(strings.TrimSpace(string(output))); n != 1 {
		return "", fmt.Errorf("test install is missing or already has credentials")
	}
	return token, nil
}
