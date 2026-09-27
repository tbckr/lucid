package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
	"testing"
	"time"
)

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func envFunc(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestRunVersionAndFlags(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		args    []string
		env     map[string]string
		want    string
		wantErr string
	}{
		{"version", []string{"--version"}, nil, "lucid dev (commit none, committed unknown, go", ""},
		{"help", []string{"-h"}, nil, "Usage: lucid", ""},
		{"unknown flag", []string{"--nope"}, nil, "", "flag provided but not defined"},
		{"extra arg", []string{"serve"}, nil, "", "unexpected argument"},
		{"bad config", nil, map[string]string{"LUCID_SESSION_TTL": "soon"}, "", "invalid configuration"},
		{"bad healthcheck config", []string{"healthcheck"}, map[string]string{"LUCID_SESSION_TTL": "soon"}, "", "invalid configuration"},
		{"bad healthcheck addr", []string{"healthcheck"}, map[string]string{"LUCID_ADDR": "nonsense"}, "", "LUCID_ADDR"},
		{"listen fails", nil, map[string]string{"LUCID_ADDR": "256.0.0.1:0"}, "", "listening on"},
		{"metrics listen fails", nil, map[string]string{"LUCID_ADDR": "127.0.0.1:0", "LUCID_METRICS_ADDR": "256.0.0.1:0"}, "", "listening on 256.0.0.1:0"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var out syncBuffer
			err := run(t.Context(), tt.args, envFunc(tt.env), &out)
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("run() error = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("run() error = %v", err)
			}
			if !strings.Contains(out.String(), tt.want) {
				t.Errorf("output %q does not contain %q", out.String(), tt.want)
			}
		})
	}
}

func TestResolveBuildMeta(t *testing.T) {
	t.Parallel()
	vcs := func(version string, settings ...string) *debug.BuildInfo {
		bi := &debug.BuildInfo{Main: debug.Module{Path: "github.com/tbckr/lucid", Version: version}}
		for i := 0; i+1 < len(settings); i += 2 {
			bi.Settings = append(bi.Settings, debug.BuildSetting{Key: settings[i], Value: settings[i+1]})
		}
		return bi
	}
	const (
		rev  = "5427e01091e8d39d449e8ad23bc4bb717c277280"
		when = "2026-09-27T12:00:00Z"
	)
	tests := []struct {
		name string
		ld   buildMeta
		bi   *debug.BuildInfo
		want buildMeta
	}{
		{
			name: "ldflags win",
			ld:   buildMeta{"1.2.0", "abc", "2026-01-01T00:00:00Z"},
			bi:   vcs("v9.9.9", "vcs.revision", rev, "vcs.time", when),
			want: buildMeta{"1.2.0", "abc", "2026-01-01T00:00:00Z"},
		},
		{
			name: "go build on a release tag",
			bi:   vcs("v1.2.0", "vcs.revision", rev, "vcs.time", when, "vcs.modified", "false"),
			want: buildMeta{"1.2.0", rev, when},
		},
		{
			name: "go build after a tag with local changes",
			bi:   vcs("v1.2.1-0.20260927120000-5427e01091e8+dirty", "vcs.revision", rev, "vcs.time", when, "vcs.modified", "true"),
			want: buildMeta{"1.2.1-0.20260927120000-5427e01091e8+dirty", rev, when},
		},
		{
			name: "go install from the module proxy",
			bi:   vcs("v1.2.0"),
			want: buildMeta{"1.2.0", "none", "unknown"},
		},
		{
			name: "go run",
			bi:   vcs("(devel)"),
			want: buildMeta{"dev", "none", "unknown"},
		},
		{
			name: "only version from ldflags",
			ld:   buildMeta{version: "0.0.0-ci"},
			bi:   vcs("(devel)", "vcs.revision", rev, "vcs.time", when),
			want: buildMeta{"0.0.0-ci", rev, when},
		},
		{
			name: "no build info",
			want: buildMeta{"dev", "none", "unknown"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := resolveBuildMeta(tt.ld, tt.bi); got != tt.want {
				t.Errorf("resolveBuildMeta() = %+v, want %+v", got, tt.want)
			}
		})
	}
}

// startServer runs the server in the background and returns the listen
// addresses from the "listening" log lines.
func startServer(t *testing.T, env map[string]string, wantListeners int) (addrs []string, logs *syncBuffer, stop func() error) {
	t.Helper()
	logs = &syncBuffer{}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- run(ctx, nil, envFunc(env), logs) }()

	deadline := time.Now().Add(10 * time.Second)
	for len(addrs) < wantListeners {
		if time.Now().After(deadline) {
			cancel()
			t.Fatalf("server did not start; logs:\n%s", logs)
		}
		select {
		case err := <-done:
			cancel()
			t.Fatalf("run() returned early: %v\n%s", err, logs)
		case <-time.After(10 * time.Millisecond):
		}
		addrs = addrs[:0]
		for line := range strings.SplitSeq(logs.String(), "\n") {
			var entry struct {
				Msg  string `json:"msg"`
				Addr string `json:"addr"`
			}
			if json.Unmarshal([]byte(line), &entry) == nil && entry.Msg == "listening" {
				addrs = append(addrs, entry.Addr)
			}
		}
	}
	return addrs, logs, func() error {
		cancel()
		select {
		case err := <-done:
			return err
		case <-time.After(30 * time.Second):
			return context.DeadlineExceeded
		}
	}
}

func get(t *testing.T, client *http.Client, url string) (int, string) {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, url, http.NoBody)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

func TestRunServes(t *testing.T) {
	t.Parallel()
	env := map[string]string{
		"LUCID_ADDR":            "127.0.0.1:0",
		"LUCID_COOKIE_INSECURE": "true",
		"LUCID_LOG_LEVEL":       "debug",
	}
	addrs, logs, stop := startServer(t, env, 1)
	base := "http://" + addrs[0]
	client := &http.Client{Timeout: 5 * time.Second}

	if code, body := get(t, client, base+"/healthz"); code != http.StatusOK || !strings.Contains(body, "ok") {
		t.Errorf("healthz: %d %q", code, body)
	}
	if code, body := get(t, client, base+"/api/v1/session"); code != http.StatusOK || !strings.Contains(body, "csrfToken") {
		t.Errorf("session: %d %q", code, body)
	}
	if code, body := get(t, client, base+"/metrics"); code != http.StatusOK ||
		!strings.Contains(body, "lucid_http_requests_total") || !strings.Contains(body, "go_goroutines") ||
		!strings.Contains(body, "lucid_build_info") {
		t.Errorf("metrics: %d", code)
	}
	if code, _ := get(t, client, base+"/"); code != http.StatusOK {
		t.Errorf("spa: %d", code)
	}

	// The healthcheck subcommand probes the running server.
	if err := run(t.Context(), []string{"healthcheck"}, envFunc(map[string]string{"LUCID_ADDR": addrs[0]}), io.Discard); err != nil {
		t.Errorf("healthcheck: %v", err)
	}

	if err := stop(); err != nil {
		t.Fatalf("run() = %v", err)
	}
	for _, want := range []string{"LUCID_SESSION_KEY is not set", "INSECURE", "shutting down", "stopped"} {
		if !strings.Contains(logs.String(), want) {
			t.Errorf("logs missing %q", want)
		}
	}
	// After shutdown the healthcheck fails.
	if err := run(t.Context(), []string{"healthcheck"}, envFunc(map[string]string{"LUCID_ADDR": addrs[0]}), io.Discard); err == nil {
		t.Error("healthcheck succeeded against a stopped server")
	}
}

func TestRunSeparateMetricsAndTLS(t *testing.T) {
	t.Parallel()
	certFile, keyFile := writeCert(t)
	env := map[string]string{
		"LUCID_ADDR":                   "127.0.0.1:0",
		"LUCID_METRICS_ADDR":           "127.0.0.1:0",
		"LUCID_TLS_CERT":               certFile,
		"LUCID_TLS_KEY":                keyFile,
		"LUCID_SESSION_KEY":            strings.Repeat("ab", 32),
		"LUCID_ALLOW_PRIVATE_NETWORKS": "true",
	}
	addrs, logs, stop := startServer(t, env, 2)
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, // self-signed test cert
	}}

	if code, _ := get(t, client, "https://"+addrs[0]+"/healthz"); code != http.StatusOK {
		t.Errorf("https healthz: %d", code)
	}
	// /metrics is only on the metrics listener.
	if code, body := get(t, client, "https://"+addrs[0]+"/metrics"); code == http.StatusOK && strings.Contains(body, "go_goroutines") {
		t.Error("metrics exposed on main listener")
	}
	if code, body := get(t, client, "http://"+addrs[1]+"/metrics"); code != http.StatusOK || !strings.Contains(body, "go_goroutines") {
		t.Errorf("metrics listener: %d", code)
	}
	healthEnv := envFunc(map[string]string{
		"LUCID_ADDR": ":" + portOf(t, addrs[0]), "LUCID_TLS_CERT": certFile, "LUCID_TLS_KEY": keyFile,
	})
	if err := run(t.Context(), []string{"healthcheck"}, healthEnv, io.Discard); err != nil {
		t.Errorf("TLS healthcheck: %v", err)
	}
	// Plain HTTP against the metrics port's /healthz is a 404: exit 1.
	if err := run(t.Context(), []string{"healthcheck"}, envFunc(map[string]string{"LUCID_ADDR": addrs[1]}), io.Discard); err == nil ||
		!strings.Contains(err.Error(), "status 404") {
		t.Errorf("healthcheck error = %v, want status 404", err)
	}
	if err := stop(); err != nil {
		t.Fatalf("run() = %v", err)
	}
	if strings.Contains(logs.String(), "LUCID_SESSION_KEY is not set") || !strings.Contains(logs.String(), "SSRF protection") {
		t.Error("unexpected warnings")
	}
}

func TestRunTLSFailure(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	missing := filepath.Join(dir, "missing.pem")
	var out syncBuffer
	err := run(t.Context(), nil, envFunc(map[string]string{
		"LUCID_ADDR": "127.0.0.1:0", "LUCID_TLS_CERT": missing, "LUCID_TLS_KEY": missing,
	}), &out)
	if err == nil || !strings.Contains(err.Error(), "missing.pem") {
		t.Fatalf("run() error = %v", err)
	}
}

func TestWarnBehindProxy(t *testing.T) {
	t.Parallel()
	addrs, logs, stop := startServer(t, map[string]string{"LUCID_ADDR": "127.0.0.1:0"}, 1)
	_ = addrs
	if err := stop(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(logs.String(), "reverse proxy") {
		t.Error("missing TLS/proxy warning")
	}
}

func portOf(t *testing.T, addr string) string {
	t.Helper()
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatal(err)
	}
	return port
}

func writeCert(t *testing.T) (certFile, keyFile string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "lucid.test"},
		DNSNames:     []string{"lucid.test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	certFile, keyFile = filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	if err := os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	return certFile, keyFile
}
