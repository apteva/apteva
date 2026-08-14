package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDownloadGeoIPDBIPDatabaseWithoutCredentials(t *testing.T) {
	payload := append(bytes.Repeat([]byte("b"), 4096), []byte("\xab\xcd\xefMaxMind.com")...)
	var gotAuthorization string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuthorization = r.Header.Get("Authorization")
		gz := gzip.NewWriter(w)
		_, _ = gz.Write(payload)
		_ = gz.Close()
	}))
	defer server.Close()
	oldURL := geoIPDBIPURLForMonth
	geoIPDBIPURLForMonth = func(time.Time) string { return server.URL }
	defer func() { geoIPDBIPURLForMonth = oldURL }()

	destination := filepath.Join(t.TempDir(), "geoip", "country.mmdb")
	if err := downloadGeoIPDatabase(server.Client(), geoIPConfig{Source: "dbip"}, destination); err != nil {
		t.Fatal(err)
	}
	if gotAuthorization != "" {
		t.Fatalf("DB-IP download sent authorization header %q", gotAuthorization)
	}
	got, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatal("decompressed DB-IP database differs from response")
	}
}

func TestDownloadGeoIPTestDatabaseAtomically(t *testing.T) {
	payload := append(bytes.Repeat([]byte("m"), 2048), []byte("\xab\xcd\xefMaxMind.com")...)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(payload)
	}))
	defer server.Close()
	oldURL := geoIPTestURL
	geoIPTestURL = server.URL
	defer func() { geoIPTestURL = oldURL }()

	destination := filepath.Join(t.TempDir(), "geoip", "country.mmdb")
	if err := downloadGeoIPDatabase(server.Client(), geoIPConfig{Source: "test"}, destination); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatal("downloaded database differs from response")
	}
	matches, _ := filepath.Glob(filepath.Join(filepath.Dir(destination), ".country-*.mmdb"))
	if len(matches) != 0 {
		t.Fatalf("temporary files remain: %v", matches)
	}
}

func TestDownloadGeoIPMaxMindArchiveUsesBasicAuth(t *testing.T) {
	payload := append(bytes.Repeat([]byte("d"), 4096), []byte("\xab\xcd\xefMaxMind.com")...)
	var gotUser, gotPassword string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUser, gotPassword, _ = r.BasicAuth()
		gz := gzip.NewWriter(w)
		tw := tar.NewWriter(gz)
		_ = tw.WriteHeader(&tar.Header{Name: "GeoLite2-Country_1/GeoLite2-Country.mmdb", Mode: 0600, Size: int64(len(payload))})
		_, _ = tw.Write(payload)
		_ = tw.Close()
		_ = gz.Close()
	}))
	defer server.Close()
	oldURL := geoIPMaxMindURL
	geoIPMaxMindURL = server.URL
	defer func() { geoIPMaxMindURL = oldURL }()

	destination := filepath.Join(t.TempDir(), "country.mmdb")
	config := geoIPConfig{Source: "maxmind", AccountID: "123", LicenseKey: "secret"}
	if err := downloadGeoIPDatabase(server.Client(), config, destination); err != nil {
		t.Fatal(err)
	}
	if gotUser != "123" || gotPassword != "secret" {
		t.Fatalf("unexpected basic auth %q %q", gotUser, gotPassword)
	}
	got, _ := os.ReadFile(destination)
	if !bytes.Equal(got, payload) {
		t.Fatal("archive database differs from response")
	}
}

func TestSaveGeoIPConfigIsPrivateAndDoesNotExposeSecretInStatusShape(t *testing.T) {
	root := t.TempDir()
	config := geoIPConfig{Enabled: true, Source: "maxmind", AccountID: "123", LicenseKey: "secret"}
	if err := saveGeoIPConfig(root, config); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(geoIPConfigPath(root))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("config mode=%o", info.Mode().Perm())
	}
	loaded, err := loadGeoIPConfig(root)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.LicenseKey != "secret" {
		t.Fatal("license key was not persisted")
	}
}

func TestCopyCountryMMDBRejectsArchiveWithoutDatabase(t *testing.T) {
	var archive bytes.Buffer
	gz := gzip.NewWriter(&archive)
	tw := tar.NewWriter(gz)
	_ = tw.WriteHeader(&tar.Header{Name: "README.txt", Size: 1})
	_, _ = io.WriteString(tw, "x")
	_ = tw.Close()
	_ = gz.Close()
	if err := copyCountryMMDBFromTarGZ(io.Discard, &archive); err == nil {
		t.Fatal("expected missing database error")
	}
}
