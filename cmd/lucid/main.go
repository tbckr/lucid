// Command lucid is the Lucid CalDAV web client server.
//
// All configuration comes from LUCID_* environment variables (see
// docs/API.md). "lucid healthcheck" probes a running instance's /healthz and
// exits 0/1, for distroless containers without curl.
package main

import (
	"bufio"
	"cmp"
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"runtime/debug"
	"strings"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/tbckr/lucid/internal/caldav"
	"github.com/tbckr/lucid/internal/config"
	"github.com/tbckr/lucid/internal/httpapi"
	"github.com/tbckr/lucid/internal/middleware"
	"github.com/tbckr/lucid/internal/safehttp"
	"github.com/tbckr/lucid/internal/session"
	"github.com/tbckr/lucid/internal/undo"
	"github.com/tbckr/lucid/web"
)

// Set via -ldflags "-X main.version=... -X main.commit=... -X main.date=...".
// Builds without them fall back to what Go records in the binary (see
// resolveBuildMeta).
var version, commit, date string

// buildMeta describes the running binary for --version, the startup log,
// lucid_build_info and the version the SPA shows (GET /api/v1/session).
type buildMeta struct{ version, commit, date string }

// resolveBuildMeta fills the fields that ldflags left empty from bi, which Go
// stamps into every binary: the main module version (the release tag, a
// pseudo-version for later commits, "+dirty" for local changes; NFR-14),
// the revision and the commit time. `go run` and builds outside a Git
// checkout record no VCS data, so those fields end up "dev", "none" and
// "unknown".
func resolveBuildMeta(ld buildMeta, bi *debug.BuildInfo) buildMeta {
	m := ld
	if bi != nil {
		if m.version == "" && bi.Main.Version != "(devel)" {
			m.version = strings.TrimPrefix(bi.Main.Version, "v")
		}
		for _, s := range bi.Settings {
			switch {
			case s.Key == "vcs.revision" && m.commit == "":
				m.commit = s.Value
			case s.Key == "vcs.time" && m.date == "":
				m.date = s.Value
			}
		}
	}
	m.version = cmp.Or(m.version, "dev")
	m.commit = cmp.Or(m.commit, "none")
	m.date = cmp.Or(m.date, "unknown")
	return m
}

const (
	shutdownTimeout = 20 * time.Second
	janitorInterval = time.Minute
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), shutdownSignals(signal.Ignored)...)
	err := run(ctx, os.Args[1:], os.Getenv, os.Stdout, openBrowser)
	stop()
	if err != nil {
		fmt.Fprintln(os.Stderr, "lucid:", err)
		if keepWindowOpen(runtime.GOOS, os.Getenv) {
			fmt.Fprintln(os.Stderr, "Press Enter to close this window.")
			_, _ = bufio.NewReader(os.Stdin).ReadString('\n')
		}
		os.Exit(1)
	}
}

// shutdownSignals returns the signals that stop Lucid. SIGHUP is among them
// because closing the macOS Terminal window sends it, and in local mode that
// window is how the user stops Lucid (FR-35). It is left out if the process
// started with it ignored: Notify would install a handler and so undo
// `nohup lucid &`, which then would stop when the terminal closes.
func shutdownSignals(ignored func(os.Signal) bool) []os.Signal {
	sigs := []os.Signal{os.Interrupt, syscall.SIGTERM}
	if !ignored(syscall.SIGHUP) {
		sigs = append(sigs, syscall.SIGHUP)
	}
	return sigs
}

// run is the testable entry point. Logs go to stdout: JSON in server mode, text
// in local mode, where a person reads them (NFR-23). In local mode run also
// prints the banner there and opens the browser with openURL, which server
// mode never calls.
func run(ctx context.Context, args []string, getenv func(string) string, stdout io.Writer, openURL func(context.Context, string) error) error {
	if len(args) > 0 && args[0] == "healthcheck" {
		return healthcheck(ctx, getenv)
	}

	fs := flag.NewFlagSet("lucid", flag.ContinueOnError)
	fs.SetOutput(stdout)
	showVersion := fs.Bool("version", false, "print version information and exit")
	fs.Usage = func() {
		fmt.Fprintln(fs.Output(), "Usage: lucid [--version] | lucid healthcheck")
		fmt.Fprintln(fs.Output(), "Configuration is read from LUCID_* environment variables (see docs/API.md).")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected argument %q", fs.Arg(0))
	}
	bi, _ := debug.ReadBuildInfo()
	build := resolveBuildMeta(buildMeta{version, commit, date}, bi)
	if *showVersion {
		_, err := fmt.Fprintf(stdout, "lucid %s (commit %s, committed %s, %s)\n", build.version, build.commit, build.date, runtime.Version())
		return err
	}

	cfg, err := config.Load(getenv)
	if err != nil {
		return fmt.Errorf("invalid configuration: %w", err)
	}
	logger := newLogger(&cfg, stdout)
	slog.SetDefault(logger)
	return serve(ctx, &cfg, logger, build, stdout, openURL)
}

// newLogger builds the logger of the process: JSON in server mode, text in
// local mode (NFR-23, FR-35), at cfg.LogLevel, writing to w. Every line logged
// with a request's context carries that request's ID (NFR-23); that includes
// the lines of the loggers derived with With.
func newLogger(cfg *config.Config, w io.Writer) *slog.Logger {
	opts := &slog.HandlerOptions{Level: cfg.LogLevel}
	var handler slog.Handler = slog.NewJSONHandler(w, opts)
	if cfg.Local {
		handler = slog.NewTextHandler(w, opts)
	}
	return slog.New(middleware.NewContextHandler(handler))
}

// serve wires all components and runs the servers until ctx is canceled.
func serve(ctx context.Context, cfg *config.Config, logger *slog.Logger, build buildMeta, stdout io.Writer, openURL func(context.Context, string) error) error {
	logger.InfoContext(ctx, "starting lucid", "version", build.version, "commit", build.commit, "date", build.date)
	warnInsecure(cfg, logger)

	reg := prometheus.NewRegistry()
	buildInfo := prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "lucid_build_info", Help: "Build information of the running binary.",
	}, []string{"version", "commit"})
	buildInfo.WithLabelValues(build.version, build.commit).Set(1)
	reg.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		buildInfo,
	)

	provider, err := caldav.NewProvider(caldav.Options{
		HTTPClient: safehttp.NewClient(safehttp.Options{
			AllowPrivate: cfg.AllowPrivateNetworks,
			AllowCIDRs:   cfg.AllowedCIDRs,
			Timeout:      cfg.UpstreamTimeout,
		}),
		CacheSize:      cfg.CacheSize,
		CacheFreshness: cfg.CacheFreshness,
		UserAgent:      "lucid/" + build.version,
		Registerer:     reg,
		Logger:         logger.With("component", "caldav"),
	})
	if err != nil {
		return err
	}
	store, err := session.New(session.Options{
		TTL:         cfg.SessionTTL,
		IdleTimeout: cfg.SessionIdleTimeout,
	})
	if err != nil {
		return err
	}
	undoStore := undo.New(undo.Options{})
	sec, err := middleware.NewSecurity(logger, reg)
	if err != nil {
		return err
	}
	metrics, err := middleware.NewMetrics(reg)
	if err != nil {
		return err
	}
	apiLimiter := middleware.NewLimiter(middleware.LimiterOptions{
		Name: "api", Rate: cfg.RateLimitRPS, Burst: cfg.RateLimitBurst,
	})
	loginLimiter := middleware.NewLimiter(middleware.LimiterOptions{
		Name: "login", Rate: float64(cfg.LoginRateLimitPerMin) / 60, Burst: cfg.LoginRateLimitPerMin,
	})

	opts := httpapi.Options{
		Provider:          provider,
		Sessions:          store,
		Undo:              undoStore,
		Logger:            logger,
		Security:          sec,
		Metrics:           metrics,
		Assets:            web.Dist(),
		APILimiter:        apiLimiter,
		LoginLimiter:      loginLimiter,
		Local:             cfg.Local,
		TrustProxyHeaders: cfg.TrustProxyHeaders,
		Version:           build.version,
	}
	api, err := httpapi.New(opts)
	if err != nil {
		return err
	}

	// Background janitors stop with the process context.
	bg, cancelBg := context.WithCancel(ctx)
	defer cancelBg()
	go store.Run(bg, janitorInterval)
	go undoStore.Run(bg, janitorInterval)
	go apiLimiter.Run(bg, janitorInterval)
	go loginLimiter.Run(bg, janitorInterval)

	servers := []*http.Server{newServer(cfg, api, logger)}
	listeners := []string{cfg.Addr}
	// NFR-08: /metrics is never part of the main listener, which is exposed
	// to users (and, in server mode, to the internet). It is served only on
	// the separate LUCID_METRICS_ADDR listener, so without it there are no
	// metrics.
	if cfg.MetricsAddr != "" {
		mux := http.NewServeMux()
		mux.Handle("GET /metrics", promhttp.HandlerFor(reg, promhttp.HandlerOpts{Registry: reg}))
		servers = append(servers, newServer(cfg, mux, logger))
		listeners = append(listeners, cfg.MetricsAddr)
	}

	errCh := make(chan error, len(servers))
	for i, srv := range servers {
		ln, err := (&net.ListenConfig{}).Listen(ctx, "tcp", listeners[i])
		if err != nil {
			if cfg.Local { // the only listener; the message is for a person who double-clicked
				//nolint:staticcheck // ST1005: sentences for a person at a double-clicked window, not an error chain
				err = fmt.Errorf("cannot listen on %s: %w\nIf Lucid is already running, use its window. "+
					"Otherwise close the program that uses port %d, or choose another port with LUCID_LOCAL_PORT.",
					cfg.Addr, err, cfg.LocalPort)
			} else {
				err = fmt.Errorf("listening on %s: %w", listeners[i], err)
			}
			return errors.Join(err, shutdown(servers[:i], logger))
		}
		useTLS := cfg.TLSEnabled() && i == 0
		logger.InfoContext(ctx, "listening", "addr", ln.Addr().String(), "tls", useTLS, "metrics_only", i > 0)
		go func() {
			var err error
			if useTLS {
				err = srv.ServeTLS(ln, cfg.TLSCert, cfg.TLSKey)
			} else {
				err = srv.Serve(ln)
			}
			if errors.Is(err, http.ErrServerClosed) {
				err = nil
			}
			errCh <- err
		}()
	}

	if cfg.Local {
		announceLocal(ctx, cfg, logger, stdout, openURL)
	}

	select {
	case err = <-errCh:
		// A server stopped on its own (e.g. unreadable TLS certificate).
	case <-ctx.Done():
		logger.InfoContext(ctx, "shutting down")
	}
	// Report not-ready first so load balancers drain, then stop.
	api.SetReady(false)
	return errors.Join(err, shutdown(servers, logger))
}

// announceLocal tells the user where Lucid runs and how to stop it, then opens
// the browser (FR-35). The listeners are up, so the page loads on the first try.
// The banner is for the person at the window and does not go through the logger.
func announceLocal(ctx context.Context, cfg *config.Config, logger *slog.Logger, stdout io.Writer, openURL func(context.Context, string) error) {
	url := "http://" + cfg.Addr + "/"
	fmt.Fprintf(stdout, "Lucid is running at %s\nClose this window to stop Lucid. Closing the browser tab does not stop it.\n", url)
	if !cfg.OpenBrowser {
		return
	}
	if err := openURL(ctx, url); err != nil {
		logger.WarnContext(ctx, "could not open the browser", "error", err)
	}
}

func shutdown(servers []*http.Server, logger *slog.Logger) error {
	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	var errs []error
	for _, srv := range servers {
		if err := srv.Shutdown(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	logger.Info("stopped")
	return errors.Join(errs...)
}

func newServer(cfg *config.Config, h http.Handler, logger *slog.Logger) *http.Server {
	return &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 10 * time.Second, // slow-loris protection
		ReadTimeout:       30 * time.Second,
		// Handlers may make several sequential upstream requests (discovery).
		WriteTimeout:   4*cfg.UpstreamTimeout + 10*time.Second,
		IdleTimeout:    120 * time.Second,
		MaxHeaderBytes: 64 << 10,
		TLSConfig:      &tls.Config{MinVersion: tls.VersionTLS12},
		ErrorLog:       slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}
}

// warnInsecure logs server-mode configuration choices that weaken security.
// Local mode has none: it serves loopback only and warns about nothing.
func warnInsecure(cfg *config.Config, logger *slog.Logger) {
	if cfg.Local {
		return
	}
	if !cfg.TLSEnabled() && !cfg.TrustProxyHeaders {
		logger.Warn("no TLS configured: Lucid must run behind a TLS-terminating reverse proxy, " +
			"browsers will not send the Secure session cookie over plain HTTP")
	}
	if cfg.AllowPrivateNetworks {
		logger.Warn("LUCID_PRIVATE_NETWORKS=all: SSRF protection for internal addresses is disabled")
	}
}

// healthcheck probes /healthz of the local instance.
func healthcheck(ctx context.Context, getenv func(string) string) error {
	cfg, err := config.Load(getenv)
	if err != nil {
		return fmt.Errorf("invalid configuration: %w", err)
	}
	host, port, err := net.SplitHostPort(cfg.Addr)
	if err != nil {
		return fmt.Errorf("parsing LUCID_ADDR: %w", err)
	}
	if ip := net.ParseIP(host); host == "" || (ip != nil && ip.IsUnspecified()) {
		host = "127.0.0.1"
	}
	scheme := "http"
	if cfg.TLSEnabled() {
		scheme = "https"
	}
	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			Proxy: nil, // always probe the local instance directly
			// The certificate is issued for the public hostname, not for
			// the loopback address probed here; the probe carries no secrets.
			TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true}, //nolint:gosec // local liveness probe, see comment
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, scheme+"://"+net.JoinHostPort(host, port)+"/healthz", http.NoBody)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("healthcheck: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("healthcheck: status %d", resp.StatusCode)
	}
	return nil
}
