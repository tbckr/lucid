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
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/tbckr/lucid/internal/config"
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
			err := run(t.Context(), tt.args, envFunc(tt.env), &out, nil)
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
	go func() { done <- run(ctx, nil, envFunc(env), logs, nil) }()

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
		"LUCID_ADDR":      "127.0.0.1:0",
		"LUCID_LOG_LEVEL": "debug",
	}
	addrs, logs, stop := startServer(t, env, 1)
	base := "http://" + addrs[0]
	client := &http.Client{Timeout: 5 * time.Second}

	if code, body := get(t, client, base+"/healthz"); code != http.StatusOK || !strings.Contains(body, "ok") {
		t.Errorf("healthz: %d %q", code, body)
	}
	code, body := get(t, client, base+"/api/v1/session")
	if code != http.StatusOK || !strings.Contains(body, "csrfToken") {
		t.Errorf("session: %d %q", code, body)
	}
	// The SPA shows the same version as the startup log.
	var sess, started struct {
		Msg     string `json:"msg"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal([]byte(body), &sess); err != nil {
		t.Fatal(err)
	}
	for line := range strings.SplitSeq(logs.String(), "\n") {
		if json.Unmarshal([]byte(line), &started) == nil && started.Msg == "starting lucid" {
			break
		}
	}
	if sess.Version == "" || sess.Version != started.Version {
		t.Errorf("session version = %q, startup log version = %q", sess.Version, started.Version)
	}
	// Without LUCID_METRICS_ADDR there are no metrics: /metrics falls through
	// to the SPA (NFR-08).
	if _, body := get(t, client, base+"/metrics"); strings.Contains(body, "go_goroutines") {
		t.Error("metrics exposed on main listener")
	}
	if code, _ := get(t, client, base+"/"); code != http.StatusOK {
		t.Errorf("spa: %d", code)
	}
	// Server mode has no Host check: a public hostname behind a proxy works.
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, base+"/healthz", http.NoBody)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "calendar.example.com"
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("GET /healthz with foreign Host: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("healthz with Host calendar.example.com: %d", resp.StatusCode)
	}

	// The healthcheck subcommand probes the running server.
	if err := run(t.Context(), []string{"healthcheck"}, envFunc(map[string]string{"LUCID_ADDR": addrs[0]}), io.Discard, nil); err != nil {
		t.Errorf("healthcheck: %v", err)
	}

	if err := stop(); err != nil {
		t.Fatalf("run() = %v", err)
	}
	for _, want := range []string{"shutting down", "stopped"} {
		if !strings.Contains(logs.String(), want) {
			t.Errorf("logs missing %q", want)
		}
	}
	for _, unwanted := range []string{"LUCID_SESSION_KEY is not set", "INSECURE"} {
		if strings.Contains(logs.String(), unwanted) {
			t.Errorf("logs contain %q", unwanted)
		}
	}
	// After shutdown the healthcheck fails.
	if err := run(t.Context(), []string{"healthcheck"}, envFunc(map[string]string{"LUCID_ADDR": addrs[0]}), io.Discard, nil); err == nil {
		t.Error("healthcheck succeeded against a stopped server")
	}
}

func TestRunSeparateMetricsAndTLS(t *testing.T) {
	t.Parallel()
	certFile, keyFile := writeCert(t)
	env := map[string]string{
		"LUCID_ADDR":             "127.0.0.1:0",
		"LUCID_METRICS_ADDR":     "127.0.0.1:0",
		"LUCID_TLS_CERT":         certFile,
		"LUCID_TLS_KEY":          keyFile,
		"LUCID_PRIVATE_NETWORKS": "all",
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
	if code, body := get(t, client, "http://"+addrs[1]+"/metrics"); code != http.StatusOK ||
		!strings.Contains(body, "lucid_http_requests_total") || !strings.Contains(body, "go_goroutines") ||
		!strings.Contains(body, "lucid_build_info") {
		t.Errorf("metrics listener: %d", code)
	}
	healthEnv := envFunc(map[string]string{
		"LUCID_ADDR": ":" + portOf(t, addrs[0]), "LUCID_TLS_CERT": certFile, "LUCID_TLS_KEY": keyFile,
	})
	if err := run(t.Context(), []string{"healthcheck"}, healthEnv, io.Discard, nil); err != nil {
		t.Errorf("TLS healthcheck: %v", err)
	}
	// Plain HTTP against the metrics port's /healthz is a 404: exit 1.
	if err := run(t.Context(), []string{"healthcheck"}, envFunc(map[string]string{"LUCID_ADDR": addrs[1]}), io.Discard, nil); err == nil ||
		!strings.Contains(err.Error(), "status 404") {
		t.Errorf("healthcheck error = %v, want status 404", err)
	}
	if err := stop(); err != nil {
		t.Fatalf("run() = %v", err)
	}
	if !strings.Contains(logs.String(), "LUCID_PRIVATE_NETWORKS=all: SSRF protection") {
		t.Error("missing SSRF protection warning")
	}
}

func TestRunTLSFailure(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	missing := filepath.Join(dir, "missing.pem")
	var out syncBuffer
	err := run(t.Context(), nil, envFunc(map[string]string{
		"LUCID_ADDR": "127.0.0.1:0", "LUCID_TLS_CERT": missing, "LUCID_TLS_KEY": missing,
	}), &out, nil)
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

func TestWarnInsecure(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		cfg  config.Config
		want []string // substrings that must appear; none = no log output at all
	}{
		{"local mode warns about nothing", config.Config{Local: true, AllowPrivateNetworks: true}, nil},
		{"server without TLS or proxy", config.Config{}, []string{"reverse proxy"}},
		{"server with TLS", config.Config{TLSCert: "/c.pem", TLSKey: "/k.pem"}, nil},
		{"server behind a proxy", config.Config{TrustProxyHeaders: true}, nil},
		{"server with all private networks", config.Config{TrustProxyHeaders: true, AllowPrivateNetworks: true}, []string{"LUCID_PRIVATE_NETWORKS=all: SSRF protection"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var out syncBuffer
			warnInsecure(&tt.cfg, slog.New(slog.NewJSONHandler(&out, nil)))
			if len(tt.want) == 0 && out.String() != "" {
				t.Errorf("unexpected log output: %s", out.String())
			}
			for _, want := range tt.want {
				if !strings.Contains(out.String(), want) {
					t.Errorf("logs %q do not contain %q", out.String(), want)
				}
			}
		})
	}
}

// freePort returns a loopback port that nothing listens on right now.
func freePort(t *testing.T) int {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

// startLocal runs Lucid in local mode on a free port and waits until the
// banner is printed. stop cancels it and returns what run returned.
func startLocal(t *testing.T, env map[string]string, open func(context.Context, string) error) (port int, out *syncBuffer, stop func() error) {
	t.Helper()
	// A port that freePort found free can be taken before run listens on it,
	// for example by an outgoing connection of a parallel test; try again.
	for range 5 {
		if port, out, stop, ok := tryStartLocal(t, env, open); ok {
			return port, out, stop
		}
	}
	t.Fatal("no free port for local mode")
	return 0, nil, nil
}

// tryStartLocal is one attempt of startLocal; ok is false if the port was taken.
func tryStartLocal(t *testing.T, env map[string]string, open func(context.Context, string) error) (port int, out *syncBuffer, stop func() error, ok bool) {
	t.Helper()
	port = freePort(t)
	e := map[string]string{"LUCID_LOCAL_PORT": strconv.Itoa(port)}
	for k, v := range env {
		e[k] = v
	}
	out = &syncBuffer{}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- run(ctx, nil, envFunc(e), out, open) }()
	stop = func() error {
		cancel()
		select {
		case err := <-done:
			return err
		case <-time.After(30 * time.Second):
			return context.DeadlineExceeded
		}
	}
	deadline := time.After(10 * time.Second)
	for !strings.Contains(out.String(), "Lucid is running at") {
		select {
		case err := <-done:
			cancel()
			if err != nil && strings.Contains(err.Error(), "address already in use") {
				return 0, nil, nil, false
			}
			t.Fatalf("run() returned early: %v\n%s", err, out)
		case <-deadline:
			cancel()
			t.Fatalf("local mode did not start; output:\n%s", out)
		case <-time.After(10 * time.Millisecond):
		}
	}
	return port, out, stop, true
}

func TestRunLocalMode(t *testing.T) {
	t.Parallel()
	opened := make(chan string, 1)
	healthy := make(chan int, 1)
	open := func(ctx context.Context, url string) error {
		// The server must already accept connections when the browser opens.
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url+"healthz", http.NoBody)
		if err != nil {
			return err
		}
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			resp.Body.Close()
			healthy <- resp.StatusCode
		}
		opened <- url
		return nil
	}
	port, out, stop := startLocal(t, nil, open)
	want := fmt.Sprintf("http://127.0.0.1:%d/", port)

	select {
	case got := <-opened:
		if got != want {
			t.Errorf("browser opened %q, want %q", got, want)
		}
	case <-time.After(10 * time.Second):
		_ = stop()
		t.Fatalf("browser was not opened; output:\n%s", out)
	}
	select {
	case code := <-healthy:
		if code != http.StatusOK {
			t.Errorf("healthz while opening the browser: %d", code)
		}
	default:
		t.Error("the server did not answer while the browser was opened")
	}
	for _, s := range []string{"Lucid is running at " + want, "Close this window to stop Lucid"} {
		if !strings.Contains(out.String(), s) {
			t.Errorf("output does not contain %q:\n%s", s, out)
		}
	}
	// NFR-23: structured logs, as text for a person reading the window.
	if !strings.Contains(out.String(), "msg=listening") {
		t.Errorf("logs are not text:\n%s", out)
	}
	if strings.Contains(out.String(), `"msg"`) {
		t.Errorf("logs are JSON in local mode:\n%s", out)
	}

	client := &http.Client{Timeout: 5 * time.Second}
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, want+"api/v1/session", http.NoBody)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("GET /api/v1/session: %v", err)
	}
	resp.Body.Close()
	cookies := resp.Header.Values("Set-Cookie")
	if len(cookies) == 0 {
		t.Error("no session cookie")
	}
	for _, c := range cookies {
		if strings.Contains(strings.ToLower(c), "secure") {
			t.Errorf("cookie %q is Secure, which a browser drops on plain HTTP", c)
		}
	}
	// A foreign Host (DNS rebinding) is rejected.
	req, err = http.NewRequestWithContext(t.Context(), http.MethodGet, want+"healthz", http.NoBody)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "evil.example"
	resp, err = client.Do(req)
	if err != nil {
		t.Fatalf("GET /healthz with foreign Host: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("healthz with Host evil.example: %d, want 403", resp.StatusCode)
	}

	if err := stop(); err != nil {
		t.Errorf("run() = %v", err)
	}
}

func TestRunLocalNoBrowser(t *testing.T) {
	t.Parallel()
	_, _, stop := startLocal(t, map[string]string{"LUCID_OPEN_BROWSER": "false"},
		func(context.Context, string) error {
			t.Error("browser opened although LUCID_OPEN_BROWSER=false")
			return nil
		})
	if err := stop(); err != nil {
		t.Errorf("run() = %v", err)
	}
}

func TestRunLocalBrowserFails(t *testing.T) {
	t.Parallel()
	port, out, stop := startLocal(t, nil, func(context.Context, string) error { return errors.New("no display") })
	// The failed launch does not stop the server.
	client := &http.Client{Timeout: 5 * time.Second}
	if code, _ := get(t, client, fmt.Sprintf("http://127.0.0.1:%d/healthz", port)); code != http.StatusOK {
		t.Errorf("healthz: %d", code)
	}
	if err := stop(); err != nil {
		t.Errorf("run() = %v", err)
	}
	for _, want := range []string{"could not open the browser", "no display"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("logs do not contain %q:\n%s", want, out)
		}
	}
}

func TestRunLocalPortInUse(t *testing.T) {
	t.Parallel()
	ln, err := (&net.ListenConfig{}).Listen(t.Context(), "tcp", "127.0.0.1:0") // kept open: the port is taken
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	err = run(t.Context(), nil, envFunc(map[string]string{"LUCID_LOCAL_PORT": strconv.Itoa(port)}), io.Discard,
		func(context.Context, string) error {
			t.Error("browser opened for a taken port")
			return nil
		})
	if err == nil {
		t.Fatal("run() succeeded on a taken port")
	}
	for _, want := range []string{
		fmt.Sprintf("cannot listen on 127.0.0.1:%d", port),
		"already running",
		fmt.Sprintf("port %d", port),
		"LUCID_LOCAL_PORT",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not contain %q", err, want)
		}
	}
}

func TestShutdownSignals(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		ignored func(os.Signal) bool
		want    []os.Signal
	}{
		{"SIGHUP is handled", func(os.Signal) bool { return false }, []os.Signal{os.Interrupt, syscall.SIGTERM, syscall.SIGHUP}},
		// nohup starts Lucid with SIGHUP ignored; Notify would undo that.
		{"SIGHUP stays ignored under nohup", func(sig os.Signal) bool { return sig == syscall.SIGHUP }, []os.Signal{os.Interrupt, syscall.SIGTERM}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := shutdownSignals(tt.ignored); !slices.Equal(got, tt.want) {
				t.Errorf("shutdownSignals() = %v, want %v", got, tt.want)
			}
		})
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
