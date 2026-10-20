package config

import (
	"log/slog"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadDefaults(t *testing.T) { // local mode
	t.Parallel()
	cfg, err := Load(env(nil))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if !cfg.Local || cfg.Addr != "127.0.0.1:3456" || cfg.LocalPort != DefaultLocalPort || !cfg.OpenBrowser {
		t.Errorf("local = %v addr = %q port = %d browser = %v", cfg.Local, cfg.Addr, cfg.LocalPort, cfg.OpenBrowser)
	}
	if !cfg.AllowPrivateNetworks || cfg.AllowedCIDRs != nil {
		t.Errorf("private networks = %v %v, want all", cfg.AllowPrivateNetworks, cfg.AllowedCIDRs)
	}
	if cfg.MetricsAddr != "" || cfg.TLSEnabled() || cfg.TrustProxyHeaders {
		t.Errorf("server-only settings set in local mode: %+v", cfg)
	}
	if cfg.SessionTTL != 12*time.Hour || cfg.SessionIdleTimeout != 2*time.Hour {
		t.Errorf("session ttl = %v idle = %v", cfg.SessionTTL, cfg.SessionIdleTimeout)
	}
	if cfg.RateLimitRPS != 20 || cfg.RateLimitBurst != 60 || cfg.LoginRateLimitPerMin != 10 {
		t.Errorf("rate limits = %v %v %v", cfg.RateLimitRPS, cfg.RateLimitBurst, cfg.LoginRateLimitPerMin)
	}
	if cfg.CacheSize != 256 || cfg.CacheFreshness != 10*time.Second || cfg.UpstreamTimeout != 20*time.Second {
		t.Errorf("cache/upstream = %v %v %v", cfg.CacheSize, cfg.CacheFreshness, cfg.UpstreamTimeout)
	}
	if cfg.LogLevel != slog.LevelInfo {
		t.Errorf("log level = %v", cfg.LogLevel)
	}
}

func TestLoadServerDefaults(t *testing.T) {
	t.Parallel()
	cfg, err := Load(env(map[string]string{"LUCID_ADDR": ":8080"}))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Local || cfg.Addr != ":8080" || cfg.OpenBrowser || cfg.AllowPrivateNetworks || cfg.TLSEnabled() || cfg.TrustProxyHeaders {
		t.Errorf("server defaults: %+v", cfg)
	}
	if cfg.MetricsAddr != "" || cfg.AllowedCIDRs != nil {
		t.Errorf("metrics = %q cidrs = %v", cfg.MetricsAddr, cfg.AllowedCIDRs)
	}
}

func TestLoadAll(t *testing.T) { // server mode
	t.Parallel()
	cfg, err := Load(env(map[string]string{
		"LUCID_ADDR":                     "127.0.0.1:9000",
		"LUCID_METRICS_ADDR":             ":9100",
		"LUCID_TLS_CERT":                 "/c.pem",
		"LUCID_TLS_KEY":                  "/k.pem",
		"LUCID_SESSION_TTL":              "1h",
		"LUCID_SESSION_IDLE_TIMEOUT":     "30m",
		"LUCID_PRIVATE_NETWORKS":         "192.168.1.10/32, 10.0.0.0/8,,fd00::1",
		"LUCID_RATE_LIMIT_RPS":           "2.5",
		"LUCID_RATE_LIMIT_BURST":         "5",
		"LUCID_LOGIN_RATE_LIMIT_PER_MIN": "3",
		"LUCID_TRUST_PROXY_HEADERS":      "true",
		"LUCID_CACHE_SIZE":               "10",
		"LUCID_CACHE_FRESHNESS":          "1s",
		"LUCID_UPSTREAM_TIMEOUT":         "5s",
		"LUCID_LOG_LEVEL":                "debug",
	}))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Local || cfg.Addr != "127.0.0.1:9000" || cfg.MetricsAddr != ":9100" || cfg.OpenBrowser {
		t.Errorf("local = %v addr = %q metrics = %q browser = %v", cfg.Local, cfg.Addr, cfg.MetricsAddr, cfg.OpenBrowser)
	}
	want := []netip.Prefix{
		netip.MustParsePrefix("192.168.1.10/32"),
		netip.MustParsePrefix("10.0.0.0/8"),
		netip.MustParsePrefix("fd00::1/128"),
	}
	if len(cfg.AllowedCIDRs) != len(want) {
		t.Fatalf("cidrs = %v", cfg.AllowedCIDRs)
	}
	for i := range want {
		if cfg.AllowedCIDRs[i] != want[i] {
			t.Errorf("cidr[%d] = %v, want %v", i, cfg.AllowedCIDRs[i], want[i])
		}
	}
	if cfg.AllowPrivateNetworks {
		t.Error("a CIDR list must not allow all private networks")
	}
	if !cfg.TLSEnabled() || !cfg.TrustProxyHeaders {
		t.Error("booleans not parsed")
	}
	if cfg.SessionTTL != time.Hour || cfg.SessionIdleTimeout != 30*time.Minute {
		t.Errorf("session ttl = %v idle = %v", cfg.SessionTTL, cfg.SessionIdleTimeout)
	}
	if cfg.RateLimitRPS != 2.5 || cfg.RateLimitBurst != 5 || cfg.LoginRateLimitPerMin != 3 {
		t.Error("rate limits not parsed")
	}
	if cfg.LogLevel != slog.LevelDebug || cfg.CacheSize != 10 || cfg.UpstreamTimeout != 5*time.Second {
		t.Error("misc not parsed")
	}
}

func TestLoadModes(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		env  map[string]string
		want string // "" = no error
	}{
		{"local port", map[string]string{"LUCID_LOCAL_PORT": "9000", "LUCID_OPEN_BROWSER": "false"}, ""},
		{"port min", map[string]string{"LUCID_LOCAL_PORT": "1"}, ""},
		{"port max", map[string]string{"LUCID_LOCAL_PORT": "65535"}, ""},
		{"port zero", map[string]string{"LUCID_LOCAL_PORT": "0"}, "LUCID_LOCAL_PORT"},
		{"port too big", map[string]string{"LUCID_LOCAL_PORT": "65536"}, "LUCID_LOCAL_PORT"},
		{"tls in local", map[string]string{"LUCID_TLS_CERT": "/c", "LUCID_TLS_KEY": "/k"}, "LUCID_TLS_CERT: only valid in server mode (set LUCID_ADDR)"},
		{"proxy false in local", map[string]string{"LUCID_TRUST_PROXY_HEADERS": "false"}, "LUCID_TRUST_PROXY_HEADERS: only valid in server mode"},
		{"metrics in local", map[string]string{"LUCID_METRICS_ADDR": ":9100"}, "LUCID_METRICS_ADDR: only valid in server mode"},
		{"port in server", map[string]string{"LUCID_ADDR": ":8080", "LUCID_LOCAL_PORT": "9000"}, "LUCID_LOCAL_PORT: only valid in local mode (leave LUCID_ADDR unset)"},
		{"browser in server", map[string]string{"LUCID_ADDR": ":8080", "LUCID_OPEN_BROWSER": "true"}, "LUCID_OPEN_BROWSER: only valid in local mode"},
		{"shared in local", map[string]string{"LUCID_SESSION_TTL": "1h", "LUCID_SESSION_IDLE_TIMEOUT": "30m", "LUCID_LOG_LEVEL": "debug"}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			cfg, err := Load(env(tt.env))
			if tt.want != "" {
				if err == nil || !strings.Contains(err.Error(), tt.want) {
					t.Fatalf("Load() error = %v, want mention of %q", err, tt.want)
				}
				return
			}
			if err != nil {
				t.Fatalf("Load() error = %v", err)
			}
			if tt.name == "local port" && (cfg.Addr != "127.0.0.1:9000" || cfg.LocalPort != 9000 || cfg.OpenBrowser) {
				t.Errorf("addr = %q port = %d browser = %v", cfg.Addr, cfg.LocalPort, cfg.OpenBrowser)
			}
		})
	}
}

func TestLoadModesCollectErrors(t *testing.T) {
	t.Parallel()
	_, err := Load(env(map[string]string{
		"LUCID_METRICS_ADDR":    ":9100",
		"LUCID_LOCAL_PORT":      "0",
		"LUCID_SESSION_KEY":     "x",
		"LUCID_COOKIE_INSECURE": "true",
	}))
	if err == nil {
		t.Fatal("Load() succeeded")
	}
	for _, want := range []string{"LUCID_METRICS_ADDR", "LUCID_LOCAL_PORT", "LUCID_SESSION_KEY", "LUCID_COOKIE_INSECURE"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %s", err, want)
		}
	}
}

func TestLoadRemoved(t *testing.T) {
	t.Parallel()
	for name, hint := range map[string]string{
		"LUCID_SESSION_KEY":            "random per start",
		"LUCID_COOKIE_INSECURE":        "local mode",
		"LUCID_ALLOW_PRIVATE_NETWORKS": "LUCID_PRIVATE_NETWORKS",
		"LUCID_ALLOWED_CIDRS":          "LUCID_PRIVATE_NETWORKS",
	} {
		for _, addr := range []string{"", ":8080"} { // removed in both modes
			t.Run(name+"/"+addr, func(t *testing.T) {
				t.Parallel()
				_, err := Load(env(map[string]string{name: "x", "LUCID_ADDR": addr}))
				if err == nil {
					t.Fatal("Load() succeeded")
				}
				for _, want := range []string{name + ": no longer supported", hint} {
					if !strings.Contains(err.Error(), want) {
						t.Errorf("error %q does not contain %q", err, want)
					}
				}
			})
		}
	}
}

func TestLoadPrivateNetworks(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, addr, value string
		wantAll           bool
		wantCIDRs         []string
		wantErr           bool
	}{
		{"local default", "", "", true, nil, false},
		{"server default", ":8080", "", false, nil, false},
		{"local none", "", "none", false, nil, false},
		{"server all, any case", ":8080", "All", true, nil, false},
		{"none upper", ":8080", "NONE", false, nil, false},
		{"list", ":8080", "192.168.1.10/32, 10.0.0.0/8,,fd00::1", false, []string{"192.168.1.10/32", "10.0.0.0/8", "fd00::1/128"}, false},
		{"keyword in list", ":8080", "all,10.0.0.0/8", false, nil, true},
		{"bad cidr", ":8080", "10.0.0.0/33", false, nil, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			cfg, err := Load(env(map[string]string{"LUCID_ADDR": tt.addr, "LUCID_PRIVATE_NETWORKS": tt.value}))
			if tt.wantErr {
				if err == nil || !strings.Contains(err.Error(), "LUCID_PRIVATE_NETWORKS") {
					t.Fatalf("Load() error = %v, want mention of LUCID_PRIVATE_NETWORKS", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("Load() error = %v", err)
			}
			if cfg.AllowPrivateNetworks != tt.wantAll {
				t.Errorf("AllowPrivateNetworks = %v, want %v", cfg.AllowPrivateNetworks, tt.wantAll)
			}
			if len(cfg.AllowedCIDRs) != len(tt.wantCIDRs) {
				t.Fatalf("AllowedCIDRs = %v, want %v", cfg.AllowedCIDRs, tt.wantCIDRs)
			}
			for i, s := range tt.wantCIDRs {
				if want := netip.MustParsePrefix(s); cfg.AllowedCIDRs[i] != want {
					t.Errorf("cidr[%d] = %v, want %v", i, cfg.AllowedCIDRs[i], want)
				}
			}
		})
	}
}

func TestLoadErrors(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"bad duration", map[string]string{"LUCID_SESSION_TTL": "forever"}, "LUCID_SESSION_TTL"},
		{"negative duration", map[string]string{"LUCID_CACHE_FRESHNESS": "-1s"}, "LUCID_CACHE_FRESHNESS"},
		{"bad bool", map[string]string{"LUCID_OPEN_BROWSER": "yes please"}, "LUCID_OPEN_BROWSER"},
		{"bad int", map[string]string{"LUCID_CACHE_SIZE": "many"}, "LUCID_CACHE_SIZE"},
		{"zero int", map[string]string{"LUCID_RATE_LIMIT_BURST": "0"}, "LUCID_RATE_LIMIT_BURST"},
		{"bad port", map[string]string{"LUCID_LOCAL_PORT": "http"}, "LUCID_LOCAL_PORT"},
		{"bad float", map[string]string{"LUCID_RATE_LIMIT_RPS": "fast"}, "LUCID_RATE_LIMIT_RPS"},
		{"nan float", map[string]string{"LUCID_RATE_LIMIT_RPS": "NaN"}, "LUCID_RATE_LIMIT_RPS"},
		{"bad level", map[string]string{"LUCID_LOG_LEVEL": "loud"}, "LUCID_LOG_LEVEL"},
		{"bad cidr", map[string]string{"LUCID_PRIVATE_NETWORKS": "10.0.0.0/33"}, "LUCID_PRIVATE_NETWORKS"},
		{"cert without key", map[string]string{"LUCID_ADDR": ":8080", "LUCID_TLS_CERT": "/c.pem"}, "LUCID_TLS_CERT"},
		{"key without cert", map[string]string{"LUCID_ADDR": ":8080", "LUCID_TLS_KEY": "/k.pem"}, "LUCID_TLS_CERT"},
		{"idle > ttl", map[string]string{"LUCID_SESSION_TTL": "1h", "LUCID_SESSION_IDLE_TIMEOUT": "2h"}, "LUCID_SESSION_IDLE_TIMEOUT"},
		{"metrics same addr", map[string]string{"LUCID_ADDR": ":1", "LUCID_METRICS_ADDR": ":1"}, "LUCID_METRICS_ADDR"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			_, err := Load(env(tt.env))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("Load() error = %v, want mention of %q", err, tt.want)
			}
		})
	}
}
