// Package safehttp provides an SSRF-safe HTTP client for talking to
// user-supplied CalDAV servers (NFR-22).
//
// The destination check runs at dial time on the already resolved IP address
// (net.Dialer.Control). That covers every way a hostname can end up pointing
// somewhere internal: plain DNS answers, DNS rebinding between a "check" and
// the actual request, SRV targets and every redirect hop. Checking the URL
// up front would not.
package safehttp

import (
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"syscall"
	"time"

	"github.com/tbckr/lucid/internal/domain"
)

// Defaults for Options.
const (
	DefaultTimeout      = 20 * time.Second
	DefaultMaxRedirects = 5
)

// Options configures the client.
type Options struct {
	// AllowPrivate disables address filtering entirely (self-hosting on a LAN).
	AllowPrivate bool
	// AllowCIDRs exempts specific networks from filtering.
	AllowCIDRs []netip.Prefix
	// Timeout bounds a whole request including redirects. Default 20s.
	Timeout time.Duration
	// MaxRedirects is the maximum number of redirects followed. Default 5.
	// A negative value disables redirects.
	MaxRedirects int
}

// NewClient returns an HTTP client that refuses to connect to internal
// addresses. Errors caused by the policy wrap domain.ErrForbiddenTarget,
// also through *url.Error.
//
// The transport never uses an HTTP proxy (Proxy: nil): with a proxy the
// dialer would only ever see - and validate - the proxy's address while the
// proxy connects to the real (possibly internal) target on our behalf.
func NewClient(opts Options) *http.Client {
	if opts.Timeout <= 0 {
		opts.Timeout = DefaultTimeout
	}
	if opts.MaxRedirects == 0 {
		opts.MaxRedirects = DefaultMaxRedirects
	}
	dialer := &net.Dialer{
		Timeout:   10 * time.Second,
		KeepAlive: 30 * time.Second,
		Control:   opts.control,
	}
	transport := &http.Transport{
		Proxy:                  nil, // see doc comment: required for dial-time validation
		DialContext:            dialer.DialContext,
		ForceAttemptHTTP2:      true,
		MaxIdleConns:           100,
		MaxIdleConnsPerHost:    10,
		IdleConnTimeout:        90 * time.Second,
		TLSHandshakeTimeout:    10 * time.Second,
		ResponseHeaderTimeout:  opts.Timeout,
		ExpectContinueTimeout:  1 * time.Second,
		MaxResponseHeaderBytes: 1 << 20,
		TLSClientConfig:        &tls.Config{MinVersion: tls.VersionTLS12},
	}
	return &http.Client{
		Transport:     schemeGuard{next: transport},
		Timeout:       opts.Timeout,
		CheckRedirect: opts.checkRedirect,
	}
}

// CheckIP reports whether a connection to ip is allowed by the options.
// The returned error wraps domain.ErrForbiddenTarget.
func (o Options) CheckIP(ip netip.Addr) error {
	ip = ip.WithZone("")
	if o.AllowPrivate || o.allowed(ip) {
		return nil
	}
	if reason := blockedReason(ip); reason != "" {
		return fmt.Errorf("%w: %s is %s", domain.ErrForbiddenTarget, ip, reason)
	}
	return nil
}

func (o Options) allowed(ip netip.Addr) bool {
	unmapped := ip.Unmap()
	for _, p := range o.AllowCIDRs {
		if p.Contains(ip) || p.Contains(unmapped) {
			return true
		}
	}
	return false
}

// control runs after DNS resolution, right before connect(2).
func (o Options) control(network, address string, _ syscall.RawConn) error {
	switch network {
	case "tcp4", "tcp6":
	default:
		return fmt.Errorf("%w: network %q not allowed", domain.ErrForbiddenTarget, network)
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("%w: %w", domain.ErrForbiddenTarget, err)
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return fmt.Errorf("%w: %w", domain.ErrForbiddenTarget, err)
	}
	return o.CheckIP(ip)
}

func (o Options) checkRedirect(req *http.Request, via []*http.Request) error {
	if o.MaxRedirects < 0 || len(via) > o.MaxRedirects {
		return fmt.Errorf("stopped after %d redirects", len(via)-1)
	}
	if err := checkScheme(req.URL); err != nil {
		return err
	}
	// Never downgrade from HTTPS to HTTP: the next hop could otherwise
	// receive credentials in clear text.
	if prev := via[len(via)-1]; prev.URL.Scheme == "https" && req.URL.Scheme == "http" {
		return fmt.Errorf("%w: redirect from https to http", domain.ErrForbiddenTarget)
	}
	return nil
}

func checkScheme(u *url.URL) error {
	switch u.Scheme {
	case "http", "https":
		return nil
	default:
		return fmt.Errorf("%w: scheme %q not allowed", domain.ErrForbiddenTarget, u.Scheme)
	}
}

// schemeGuard rejects non-HTTP(S) URLs before they reach the transport.
type schemeGuard struct{ next http.RoundTripper }

func (g schemeGuard) RoundTrip(req *http.Request) (*http.Response, error) {
	if err := checkScheme(req.URL); err != nil {
		if req.Body != nil {
			_ = req.Body.Close() // RoundTrip must always close the body
		}
		return nil, err
	}
	return g.next.RoundTrip(req)
}

// ErrResponseTooLarge is returned by ReadLimited.
var ErrResponseTooLarge = errors.New("response body too large")

// ReadLimited reads at most limit bytes from r. It returns
// ErrResponseTooLarge (wrapping domain.ErrUpstream) if r holds more, so a
// malicious server cannot exhaust memory.
func ReadLimited(r io.Reader, limit int64) ([]byte, error) {
	b, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("%w: %w", domain.ErrUpstream, ErrResponseTooLarge)
	}
	return b, nil
}
