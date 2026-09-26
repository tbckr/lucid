// Package config loads the Lucid runtime configuration from LUCID_*
// environment variables (NFR-20: secrets via environment only).
package config

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/netip"
	"strconv"
	"strings"
	"time"
)

// SessionKeySize is the required length of LUCID_SESSION_KEY (AES-256).
const SessionKeySize = 32

// Config is the complete runtime configuration.
type Config struct {
	Addr        string
	MetricsAddr string
	TLSCert     string
	TLSKey      string

	// SessionKey encrypts credentials stored in sessions (AES-256-GCM).
	SessionKey []byte
	// SessionKeyGenerated is true when LUCID_SESSION_KEY was unset and a
	// random key was generated. The caller should log a warning.
	SessionKeyGenerated bool
	SessionTTL          time.Duration
	SessionIdleTimeout  time.Duration
	CookieInsecure      bool

	AllowPrivateNetworks bool
	AllowedCIDRs         []netip.Prefix

	RateLimitRPS         float64
	RateLimitBurst       int
	LoginRateLimitPerMin int
	TrustProxyHeaders    bool

	CacheSize       int
	CacheFreshness  time.Duration
	UpstreamTimeout time.Duration

	LogLevel slog.Level
}

// TLSEnabled reports whether the server terminates TLS itself.
func (c *Config) TLSEnabled() bool { return c.TLSCert != "" }

// Load reads the configuration via getenv (usually os.Getenv). All
// validation errors are returned together.
func Load(getenv func(string) string) (Config, error) {
	p := parser{getenv: getenv}
	cfg := Config{
		Addr:                 p.str("LUCID_ADDR", ":8080"),
		MetricsAddr:          p.str("LUCID_METRICS_ADDR", ""),
		TLSCert:              p.str("LUCID_TLS_CERT", ""),
		TLSKey:               p.str("LUCID_TLS_KEY", ""),
		SessionTTL:           p.duration("LUCID_SESSION_TTL", 12*time.Hour),
		SessionIdleTimeout:   p.duration("LUCID_SESSION_IDLE_TIMEOUT", 2*time.Hour),
		CookieInsecure:       p.boolean("LUCID_COOKIE_INSECURE", false),
		AllowPrivateNetworks: p.boolean("LUCID_ALLOW_PRIVATE_NETWORKS", false),
		AllowedCIDRs:         p.cidrs("LUCID_ALLOWED_CIDRS"),
		RateLimitRPS:         p.float("LUCID_RATE_LIMIT_RPS", 20),
		RateLimitBurst:       p.integer("LUCID_RATE_LIMIT_BURST", 60),
		LoginRateLimitPerMin: p.integer("LUCID_LOGIN_RATE_LIMIT_PER_MIN", 10),
		TrustProxyHeaders:    p.boolean("LUCID_TRUST_PROXY_HEADERS", false),
		CacheSize:            p.integer("LUCID_CACHE_SIZE", 256),
		CacheFreshness:       p.duration("LUCID_CACHE_FRESHNESS", 10*time.Second),
		UpstreamTimeout:      p.duration("LUCID_UPSTREAM_TIMEOUT", 20*time.Second),
		LogLevel:             p.level("LUCID_LOG_LEVEL", slog.LevelInfo),
	}

	if raw := getenv("LUCID_SESSION_KEY"); raw != "" {
		key, err := DecodeKey(raw)
		if err != nil {
			p.fail("LUCID_SESSION_KEY", err)
		}
		cfg.SessionKey = key
	} else {
		key := make([]byte, SessionKeySize)
		if _, err := rand.Read(key); err != nil {
			p.fail("LUCID_SESSION_KEY", fmt.Errorf("generating random key: %w", err))
		}
		cfg.SessionKey = key
		cfg.SessionKeyGenerated = true
	}

	p.validate(&cfg)
	return cfg, errors.Join(p.errs...)
}

// DecodeKey decodes a 32-byte key given as hex or base64 (standard or
// URL alphabet, padded or unpadded).
func DecodeKey(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if len(s) == hex.EncodedLen(SessionKeySize) {
		if b, err := hex.DecodeString(s); err == nil {
			return b, nil
		}
	}
	for _, enc := range []*base64.Encoding{
		base64.StdEncoding, base64.RawStdEncoding,
		base64.URLEncoding, base64.RawURLEncoding,
	} {
		b, err := enc.DecodeString(s)
		if err != nil {
			continue
		}
		if len(b) != SessionKeySize {
			return nil, fmt.Errorf("key must be %d bytes, got %d", SessionKeySize, len(b))
		}
		return b, nil
	}
	return nil, fmt.Errorf("key must be %d bytes encoded as hex or base64", SessionKeySize)
}

type parser struct {
	getenv func(string) string
	errs   []error
}

func (p *parser) fail(name string, err error) {
	p.errs = append(p.errs, fmt.Errorf("%s: %w", name, err))
}

func (p *parser) str(name, def string) string {
	if v := strings.TrimSpace(p.getenv(name)); v != "" {
		return v
	}
	return def
}

func (p *parser) duration(name string, def time.Duration) time.Duration {
	v := p.str(name, "")
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		p.fail(name, err)
		return def
	}
	if d <= 0 {
		p.fail(name, errors.New("must be positive"))
		return def
	}
	return d
}

func (p *parser) boolean(name string, def bool) bool {
	v := p.str(name, "")
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		p.fail(name, err)
		return def
	}
	return b
}

func (p *parser) integer(name string, def int) int {
	v := p.str(name, "")
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		p.fail(name, err)
		return def
	}
	if n <= 0 {
		p.fail(name, errors.New("must be positive"))
		return def
	}
	return n
}

func (p *parser) float(name string, def float64) float64 {
	v := p.str(name, "")
	if v == "" {
		return def
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		p.fail(name, err)
		return def
	}
	if f <= 0 || math.IsNaN(f) || math.IsInf(f, 0) {
		p.fail(name, errors.New("must be positive"))
		return def
	}
	return f
}

func (p *parser) level(name string, def slog.Level) slog.Level {
	v := p.str(name, "")
	if v == "" {
		return def
	}
	var l slog.Level
	if err := l.UnmarshalText([]byte(v)); err != nil {
		p.fail(name, err)
		return def
	}
	return l
}

func (p *parser) cidrs(name string) []netip.Prefix {
	v := p.str(name, "")
	if v == "" {
		return nil
	}
	var out []netip.Prefix
	for part := range strings.SplitSeq(v, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		pfx, err := netip.ParsePrefix(part)
		if err != nil {
			// Accept bare addresses as single-host prefixes.
			addr, aerr := netip.ParseAddr(part)
			if aerr != nil {
				p.fail(name, err)
				continue
			}
			pfx = netip.PrefixFrom(addr, addr.BitLen())
		}
		out = append(out, pfx.Masked())
	}
	return out
}

func (p *parser) validate(cfg *Config) {
	if (cfg.TLSCert == "") != (cfg.TLSKey == "") {
		p.fail("LUCID_TLS_CERT/LUCID_TLS_KEY", errors.New("both or neither must be set"))
	}
	if cfg.SessionIdleTimeout > cfg.SessionTTL {
		p.fail("LUCID_SESSION_IDLE_TIMEOUT", errors.New("must not exceed LUCID_SESSION_TTL"))
	}
	// Port 0 (ephemeral) may legitimately appear twice.
	if cfg.MetricsAddr != "" && cfg.MetricsAddr == cfg.Addr && !strings.HasSuffix(cfg.Addr, ":0") {
		p.fail("LUCID_METRICS_ADDR", errors.New("must differ from LUCID_ADDR"))
	}
}
