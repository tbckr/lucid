package config

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"log/slog"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadDefaults(t *testing.T) {
	t.Parallel()
	cfg, err := Load(env(nil))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Addr != ":8080" || cfg.MetricsAddr != "" {
		t.Errorf("addr = %q metrics = %q", cfg.Addr, cfg.MetricsAddr)
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
	if !cfg.SessionKeyGenerated || len(cfg.SessionKey) != SessionKeySize {
		t.Errorf("generated key: %v len %d", cfg.SessionKeyGenerated, len(cfg.SessionKey))
	}
	if bytes.Equal(cfg.SessionKey, make([]byte, SessionKeySize)) {
		t.Error("generated key is all zeros")
	}
	if cfg.CookieInsecure || cfg.AllowPrivateNetworks || cfg.TrustProxyHeaders || cfg.TLSEnabled() {
		t.Error("boolean defaults must be false")
	}
}

func TestLoadAll(t *testing.T) {
	t.Parallel()
	key := bytes.Repeat([]byte{7}, 32)
	cfg, err := Load(env(map[string]string{
		"LUCID_ADDR":                     "127.0.0.1:9000",
		"LUCID_METRICS_ADDR":             ":9100",
		"LUCID_TLS_CERT":                 "/c.pem",
		"LUCID_TLS_KEY":                  "/k.pem",
		"LUCID_SESSION_KEY":              hex.EncodeToString(key),
		"LUCID_SESSION_TTL":              "1h",
		"LUCID_SESSION_IDLE_TIMEOUT":     "30m",
		"LUCID_COOKIE_INSECURE":          "true",
		"LUCID_ALLOW_PRIVATE_NETWORKS":   "1",
		"LUCID_ALLOWED_CIDRS":            "192.168.1.10/32, 10.0.0.0/8,,fd00::1",
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
	if cfg.SessionKeyGenerated || !bytes.Equal(cfg.SessionKey, key) {
		t.Error("session key not taken from env")
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
	if !cfg.TLSEnabled() || !cfg.CookieInsecure || !cfg.AllowPrivateNetworks || !cfg.TrustProxyHeaders {
		t.Error("booleans not parsed")
	}
	if cfg.RateLimitRPS != 2.5 || cfg.RateLimitBurst != 5 || cfg.LoginRateLimitPerMin != 3 {
		t.Error("rate limits not parsed")
	}
	if cfg.LogLevel != slog.LevelDebug || cfg.CacheSize != 10 || cfg.UpstreamTimeout != 5*time.Second {
		t.Error("misc not parsed")
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
		{"bad bool", map[string]string{"LUCID_COOKIE_INSECURE": "yes please"}, "LUCID_COOKIE_INSECURE"},
		{"bad int", map[string]string{"LUCID_CACHE_SIZE": "many"}, "LUCID_CACHE_SIZE"},
		{"zero int", map[string]string{"LUCID_RATE_LIMIT_BURST": "0"}, "LUCID_RATE_LIMIT_BURST"},
		{"bad float", map[string]string{"LUCID_RATE_LIMIT_RPS": "fast"}, "LUCID_RATE_LIMIT_RPS"},
		{"nan float", map[string]string{"LUCID_RATE_LIMIT_RPS": "NaN"}, "LUCID_RATE_LIMIT_RPS"},
		{"bad level", map[string]string{"LUCID_LOG_LEVEL": "loud"}, "LUCID_LOG_LEVEL"},
		{"bad cidr", map[string]string{"LUCID_ALLOWED_CIDRS": "10.0.0.0/33"}, "LUCID_ALLOWED_CIDRS"},
		{"bad key", map[string]string{"LUCID_SESSION_KEY": "!!!"}, "LUCID_SESSION_KEY"},
		{"short key", map[string]string{"LUCID_SESSION_KEY": base64.StdEncoding.EncodeToString([]byte("short"))}, "32 bytes"},
		{"cert without key", map[string]string{"LUCID_TLS_CERT": "/c.pem"}, "LUCID_TLS_CERT"},
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

func TestDecodeKey(t *testing.T) {
	t.Parallel()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(0xf0 + i%16) // produces '+' / '/' style characters in base64
	}
	tests := []struct {
		name    string
		in      string
		wantErr bool
	}{
		{"hex", hex.EncodeToString(key), false},
		{"hex upper", strings.ToUpper(hex.EncodeToString(key)), false},
		{"std", base64.StdEncoding.EncodeToString(key), false},
		{"raw std", base64.RawStdEncoding.EncodeToString(key), false},
		{"url", base64.URLEncoding.EncodeToString(key), false},
		{"raw url", base64.RawURLEncoding.EncodeToString(key), false},
		{"whitespace", " " + hex.EncodeToString(key) + "\n", false},
		{"too long", base64.StdEncoding.EncodeToString(append(key, 1)), true},
		{"garbage", "not a key", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, err := DecodeKey(tt.in)
			if (err != nil) != tt.wantErr {
				t.Fatalf("DecodeKey() error = %v, wantErr %v", err, tt.wantErr)
			}
			if !tt.wantErr && !bytes.Equal(got, key) {
				t.Errorf("DecodeKey() = %x, want %x", got, key)
			}
		})
	}
}
