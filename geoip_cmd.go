package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var (
	geoIPTestURL         = "https://raw.githubusercontent.com/maxmind/MaxMind-DB/main/test-data/GeoIP2-Country-Test.mmdb"
	geoIPMaxMindURL      = "https://download.maxmind.com/geoip/databases/GeoLite2-Country/download?suffix=tar.gz"
	geoIPDBIPURLForMonth = dbIPCountryLiteURL
)

func dbIPCountryLiteURL(now time.Time) string {
	return fmt.Sprintf("https://download.db-ip.com/free/dbip-country-lite-%s.mmdb.gz", now.UTC().Format("2006-01"))
}

type geoIPConfig struct {
	Enabled    bool   `json:"enabled"`
	Source     string `json:"source"`
	AccountID  string `json:"account_id,omitempty"`
	LicenseKey string `json:"license_key,omitempty"`
}

func cmdGeoIP(args []string) int {
	if len(args) == 0 {
		printGeoIPUsage(os.Stderr)
		return 2
	}
	switch args[0] {
	case "setup":
		return cmdGeoIPSetup(args[1:])
	case "update":
		return cmdGeoIPUpdate(args[1:])
	case "status":
		return cmdGeoIPStatus(args[1:])
	case "disable":
		return cmdGeoIPDisable(args[1:])
	case "help", "--help", "-h":
		printGeoIPUsage(os.Stdout)
		return 0
	default:
		fmt.Fprintf(os.Stderr, "apteva geoip: unknown command %q\n", args[0])
		printGeoIPUsage(os.Stderr)
		return 2
	}
}

func printGeoIPUsage(w io.Writer) {
	fmt.Fprintln(w, `Usage:
	  apteva geoip setup [--data-dir PATH]
  apteva geoip setup --test [--data-dir PATH]
  apteva geoip setup --account-id ID [--license-key KEY] [--data-dir PATH]
  apteva geoip update [--data-dir PATH]
  apteva geoip status [--data-dir PATH]
  apteva geoip disable [--data-dir PATH]

The default setup uses the free DB-IP Country Lite database without an account.
If MaxMind credentials are supplied, setup uses GeoLite2 Country instead.
MAXMIND_LICENSE_KEY may be used instead of --license-key so the secret does not
enter shell history. GeoIP is fail-open when the database cannot be refreshed.`)
}

func geoIPDir(root string) string        { return filepath.Join(root, "geoip") }
func geoIPConfigPath(root string) string { return filepath.Join(geoIPDir(root), "config.json") }
func geoIPDatabasePath(root string) string {
	return filepath.Join(geoIPDir(root), "GeoIP2-Country.mmdb")
}

func geoIPCommandRoot(dataDir string) (string, error) {
	if strings.TrimSpace(dataDir) == "" {
		return aptevaDir(), nil
	}
	abs, err := filepath.Abs(expandHome(dataDir))
	if err != nil {
		return "", err
	}
	return abs, nil
}

func cmdGeoIPSetup(args []string) int {
	fs := flag.NewFlagSet("geoip setup", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	testMode := fs.Bool("test", false, "install MaxMind's public test database")
	accountID := fs.String("account-id", strings.TrimSpace(os.Getenv("MAXMIND_ACCOUNT_ID")), "MaxMind account ID")
	licenseKey := fs.String("license-key", strings.TrimSpace(os.Getenv("MAXMIND_LICENSE_KEY")), "MaxMind license key (prefer MAXMIND_LICENSE_KEY)")
	dataDir := fs.String("data-dir", "", "Apteva data directory")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 {
		return 2
	}
	if *testMode && (*accountID != "" || *licenseKey != "") {
		fmt.Fprintln(os.Stderr, "--test cannot be combined with MaxMind credentials")
		return 2
	}
	config := geoIPConfig{Enabled: true, Source: "dbip"}
	if *testMode {
		config.Source = "test"
	} else if strings.TrimSpace(*accountID) != "" || strings.TrimSpace(*licenseKey) != "" {
		if strings.TrimSpace(*accountID) == "" || strings.TrimSpace(*licenseKey) == "" {
			fmt.Fprintln(os.Stderr, "MaxMind setup requires both --account-id and MAXMIND_LICENSE_KEY (or --license-key)")
			return 2
		}
		config.Source = "maxmind"
		config.AccountID = strings.TrimSpace(*accountID)
		config.LicenseKey = strings.TrimSpace(*licenseKey)
	}
	root, err := geoIPCommandRoot(*dataDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "invalid data directory: %v\n", err)
		return 1
	}
	if err := downloadGeoIPDatabase(http.DefaultClient, config, geoIPDatabasePath(root)); err != nil {
		fmt.Fprintf(os.Stderr, "GeoIP setup failed: %v\n", err)
		return 1
	}
	if err := saveGeoIPConfig(root, config); err != nil {
		fmt.Fprintf(os.Stderr, "save GeoIP configuration: %v\n", err)
		return 1
	}
	fmt.Printf("GeoIP country database installed at %s\n", geoIPDatabasePath(root))
	fmt.Println("Restart Apteva to enable it; future updates are automatic.")
	return 0
}

func cmdGeoIPUpdate(args []string) int {
	fs := flag.NewFlagSet("geoip update", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	dataDir := fs.String("data-dir", "", "Apteva data directory")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 {
		return 2
	}
	root, err := geoIPCommandRoot(*dataDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	config, err := loadGeoIPConfig(root)
	if err != nil || !config.Enabled {
		fmt.Fprintln(os.Stderr, "GeoIP is not configured; run 'apteva geoip setup' first")
		return 1
	}
	if err := downloadGeoIPDatabase(http.DefaultClient, config, geoIPDatabasePath(root)); err != nil {
		fmt.Fprintf(os.Stderr, "GeoIP update failed: %v\n", err)
		return 1
	}
	fmt.Printf("GeoIP country database updated: %s\n", geoIPDatabasePath(root))
	return 0
}

func cmdGeoIPStatus(args []string) int {
	fs := flag.NewFlagSet("geoip status", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	dataDir := fs.String("data-dir", "", "Apteva data directory")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 {
		return 2
	}
	root, err := geoIPCommandRoot(*dataDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	config, configErr := loadGeoIPConfig(root)
	if configErr != nil || !config.Enabled {
		fmt.Println("GeoIP: disabled")
		return 0
	}
	fmt.Printf("GeoIP: enabled (%s)\n", config.Source)
	if config.Source == "maxmind" {
		fmt.Printf("MaxMind account: %s\n", config.AccountID)
	}
	path := geoIPDatabasePath(root)
	info, err := os.Stat(path)
	if err != nil {
		fmt.Printf("Database: missing (%s)\n", path)
		return 1
	}
	fmt.Printf("Database: %s\nUpdated: %s\nSize: %d bytes\n", path, info.ModTime().UTC().Format(time.RFC3339), info.Size())
	return 0
}

func cmdGeoIPDisable(args []string) int {
	fs := flag.NewFlagSet("geoip disable", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	dataDir := fs.String("data-dir", "", "Apteva data directory")
	if err := fs.Parse(args); err != nil || fs.NArg() != 0 {
		return 2
	}
	root, err := geoIPCommandRoot(*dataDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	config, _ := loadGeoIPConfig(root)
	config.Enabled = false
	if config.Source == "" {
		config.Source = "disabled"
	}
	if err := saveGeoIPConfig(root, config); err != nil {
		fmt.Fprintf(os.Stderr, "disable GeoIP: %v\n", err)
		return 1
	}
	fmt.Println("GeoIP disabled. The existing database was retained; restart Apteva to apply.")
	return 0
}

func loadGeoIPConfig(root string) (geoIPConfig, error) {
	var config geoIPConfig
	raw, err := os.ReadFile(geoIPConfigPath(root))
	if err != nil {
		return config, err
	}
	if err := json.Unmarshal(raw, &config); err != nil {
		return config, err
	}
	return config, nil
}

func saveGeoIPConfig(root string, config geoIPConfig) error {
	dir := geoIPDir(root)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".config-*.json")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, geoIPConfigPath(root))
}

func downloadGeoIPDatabase(client *http.Client, config geoIPConfig, destination string) error {
	if client == nil {
		client = http.DefaultClient
	}
	var url string
	switch config.Source {
	case "dbip":
		url = geoIPDBIPURLForMonth(time.Now())
	case "maxmind":
		url = geoIPMaxMindURL
	case "test":
		url = geoIPTestURL
	default:
		return fmt.Errorf("unsupported GeoIP source %q", config.Source)
	}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	if config.Source == "maxmind" {
		req.SetBasicAuth(config.AccountID, config.LicenseKey)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("download returned HTTP %d", resp.StatusCode)
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(destination), ".country-*.mmdb")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	var copyErr error
	switch config.Source {
	case "maxmind":
		copyErr = copyCountryMMDBFromTarGZ(tmp, resp.Body)
	case "dbip":
		copyErr = copyCountryMMDBFromGZIP(tmp, resp.Body)
	default:
		_, copyErr = io.Copy(tmp, io.LimitReader(resp.Body, 128<<20))
	}
	if copyErr == nil {
		copyErr = tmp.Sync()
	}
	if closeErr := tmp.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		return copyErr
	}
	info, err := os.Stat(tmpName)
	if err != nil {
		return err
	}
	if info.Size() < 1024 {
		return errors.New("downloaded country database is unexpectedly small")
	}
	if err := validateGeoIPDatabaseFile(tmpName); err != nil {
		return err
	}
	return os.Rename(tmpName, destination)
}

func copyCountryMMDBFromGZIP(dst io.Writer, src io.Reader) error {
	gz, err := gzip.NewReader(src)
	if err != nil {
		return fmt.Errorf("open DB-IP archive: %w", err)
	}
	defer gz.Close()
	limited := &io.LimitedReader{R: gz, N: (128 << 20) + 1}
	written, err := io.Copy(dst, limited)
	if err != nil {
		return fmt.Errorf("read DB-IP archive: %w", err)
	}
	if written > 128<<20 {
		return errors.New("DB-IP country database exceeds the size limit")
	}
	return nil
}

func validateGeoIPDatabaseFile(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	const tailLimit = int64(128 << 10)
	start := info.Size() - tailLimit
	if start < 0 {
		start = 0
	}
	if _, err := file.Seek(start, io.SeekStart); err != nil {
		return err
	}
	tail, err := io.ReadAll(io.LimitReader(file, tailLimit))
	if err != nil {
		return err
	}
	if !bytes.Contains(tail, []byte("\xab\xcd\xefMaxMind.com")) {
		return errors.New("downloaded file is not a MaxMind database")
	}
	return nil
}

func copyCountryMMDBFromTarGZ(dst io.Writer, src io.Reader) error {
	gz, err := gzip.NewReader(src)
	if err != nil {
		return fmt.Errorf("open MaxMind archive: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		header, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("read MaxMind archive: %w", err)
		}
		if header.Typeflag == tar.TypeReg && strings.HasSuffix(header.Name, ".mmdb") {
			if header.Size <= 0 || header.Size > 128<<20 {
				return errors.New("invalid country database size")
			}
			_, err = io.CopyN(dst, tr, header.Size)
			return err
		}
	}
	return errors.New("MaxMind archive did not contain a country database")
}
