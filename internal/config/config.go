// Package config loads the Lucid runtime configuration from LUCID_*
// environment variables (NFR-20: no secrets in the configuration).
//
// Without LUCID_ADDR Lucid runs in local mode (FR-35), with it in server
// mode. Variables that only make sense in the other mode, and variables that
// no longer exist, are startup errors rather than silently ignored.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"
)

// DefaultLocalPort is the port of local mode unless LUCID_LOCAL_PORT is set.
const DefaultLocalPort = 3456

// serverOnly and localOnly name the variables that are an error in the other
// mode, so that a setting never goes unnoticed because it has no effect.
var (
	serverOnly = []string{
		"LUCID_METRICS_ADDR", "LUCID_TLS_CERT", "LUCID_TLS_KEY", "LUCID_TRUST_PROXY_HEADERS",
	}
	localOnly = []string{"LUCID_LOCAL_PORT", "LUCID_OPEN_BROWSER"}
)

// removed lists the variables of earlier versions, in the order their errors
// are reported, each with a hint on what to do instead.
var removed = []struct{ name, hint string }{
	{"LUCID_SESSION_KEY", "the session key is random per start"},
	{"LUCID_COOKIE_INSECURE", "for plain HTTP use local mode (leave LUCID_ADDR unset)"},
	{"LUCID_ALLOW_PRIVATE_NETWORKS", "use LUCID_PRIVATE_NETWORKS"},
	{"LUCID_ALLOWED_CIDRS", "use LUCID_PRIVATE_NETWORKS"},
}

// Config is the complete runtime configuration.
type Config struct {
	// Local is local mode (FR-35): LUCID_ADDR is unset, Lucid listens on
	// 127.0.0.1:LocalPort over plain HTTP and opens the browser.
	Local       bool
	Addr        string // LUCID_ADDR, or "127.0.0.1:<LocalPort>" in local mode
	LocalPort   int    // local mode only
	OpenBrowser bool   // local mode only; false in server mode
	MetricsAddr string
	TLSCert     string
	TLSKey      string

	SessionTTL         time.Duration
	SessionIdleTimeout time.Duration

	// From LUCID_PRIVATE_NETWORKS (NFR-22): "all" sets AllowPrivateNetworks,
	// a list fills AllowedCIDRs, "none" neither.
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
	// LUCID_ADDR decides the mode, which in turn decides the defaults.
	addr := p.str("LUCID_ADDR", "")
	local := addr == ""
	cfg := Config{
		Local:                local,
		Addr:                 addr,
		LocalPort:            p.port("LUCID_LOCAL_PORT", DefaultLocalPort),
		OpenBrowser:          p.boolean("LUCID_OPEN_BROWSER", true) && local, // pointless in server mode
		MetricsAddr:          p.str("LUCID_METRICS_ADDR", ""),
		TLSCert:              p.str("LUCID_TLS_CERT", ""),
		TLSKey:               p.str("LUCID_TLS_KEY", ""),
		SessionTTL:           p.duration("LUCID_SESSION_TTL", 12*time.Hour),
		SessionIdleTimeout:   p.duration("LUCID_SESSION_IDLE_TIMEOUT", 2*time.Hour),
		RateLimitRPS:         p.float("LUCID_RATE_LIMIT_RPS", 20),
		RateLimitBurst:       p.integer("LUCID_RATE_LIMIT_BURST", 60),
		LoginRateLimitPerMin: p.integer("LUCID_LOGIN_RATE_LIMIT_PER_MIN", 10),
		TrustProxyHeaders:    p.boolean("LUCID_TRUST_PROXY_HEADERS", false),
		CacheSize:            p.integer("LUCID_CACHE_SIZE", 256),
		CacheFreshness:       p.duration("LUCID_CACHE_FRESHNESS", 10*time.Second),
		UpstreamTimeout:      p.duration("LUCID_UPSTREAM_TIMEOUT", 20*time.Second),
		LogLevel:             p.level("LUCID_LOG_LEVEL", slog.LevelInfo),
	}
	// Local mode runs on the user's own machine, where reaching a CalDAV
	// server on it or in the LAN is the point; a server defaults to none.
	privateDefault := "none"
	if local {
		privateDefault = "all"
		cfg.Addr = net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.LocalPort))
	}
	cfg.AllowPrivateNetworks, cfg.AllowedCIDRs = p.privateNetworks("LUCID_PRIVATE_NETWORKS", privateDefault)

	p.validate(&cfg)
	return cfg, errors.Join(p.errs...)
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

// port parses a TCP port (1-65535).
func (p *parser) port(name string, def int) int {
	v := p.str(name, "")
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		p.fail(name, err)
		return def
	}
	if n < 1 || n > math.MaxUint16 {
		p.fail(name, errors.New("must be between 1 and 65535"))
		return def
	}
	return n
}

// privateNetworks parses the value of name, which is "all", "none" (both
// case-insensitive) or a comma-separated list of CIDRs and addresses. def is
// the value used when name is unset.
func (p *parser) privateNetworks(name, def string) (all bool, cidrs []netip.Prefix) {
	v := p.str(name, def)
	switch strings.ToLower(v) {
	case "all":
		return true, nil
	case "none":
		return false, nil
	}
	return false, p.cidrList(name, v)
}

func (p *parser) cidrList(name, v string) []netip.Prefix {
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

// isSet reports whether the user set name at all, whatever its value.
func (p *parser) isSet(name string) bool { return p.str(name, "") != "" }

func (p *parser) validate(cfg *Config) {
	for _, r := range removed {
		if p.isSet(r.name) {
			p.fail(r.name, errors.New("no longer supported: "+r.hint))
		}
	}
	if cfg.Local {
		for _, name := range serverOnly {
			if p.isSet(name) {
				p.fail(name, errors.New("only valid in server mode (set LUCID_ADDR)"))
			}
		}
	} else {
		for _, name := range localOnly {
			if p.isSet(name) {
				p.fail(name, errors.New("only valid in local mode (leave LUCID_ADDR unset)"))
			}
		}
		if (cfg.TLSCert == "") != (cfg.TLSKey == "") {
			p.fail("LUCID_TLS_CERT/LUCID_TLS_KEY", errors.New("both or neither must be set"))
		}
		// Port 0 (ephemeral) may legitimately appear twice.
		if cfg.MetricsAddr != "" && cfg.MetricsAddr == cfg.Addr && !strings.HasSuffix(cfg.Addr, ":0") {
			p.fail("LUCID_METRICS_ADDR", errors.New("must differ from LUCID_ADDR"))
		}
	}
	if cfg.SessionIdleTimeout > cfg.SessionTTL {
		p.fail("LUCID_SESSION_IDLE_TIMEOUT", errors.New("must not exceed LUCID_SESSION_TTL"))
	}
}
