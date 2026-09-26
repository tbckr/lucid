package safehttp

import (
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"

	"github.com/tbckr/lucid/internal/domain"
)

func TestBlockedReason(t *testing.T) {
	t.Parallel()
	tests := []struct {
		ip      string
		blocked bool
	}{
		// public
		{"1.1.1.1", false},
		{"8.8.8.8", false},
		{"2606:4700:4700::1111", false},
		{"::ffff:8.8.8.8", false},
		{"64:ff9b::808:808", false}, // NAT64 of 8.8.8.8
		{"2002:808:808::1", false},  // 6to4 of 8.8.8.8
		{"100.63.255.255", false},   // just below CGNAT
		{"172.32.0.1", false},       // just above 172.16/12
		// IPv4 special purpose
		{"0.0.0.0", true},
		{"0.1.2.3", true},
		{"10.1.2.3", true},
		{"100.64.0.1", true},
		{"127.0.0.1", true},
		{"127.255.255.254", true},
		{"169.254.169.254", true}, // cloud metadata
		{"172.16.0.1", true},
		{"172.31.255.255", true},
		{"192.0.0.8", true},
		{"192.0.2.1", true},
		{"192.88.99.1", true},
		{"192.168.1.1", true},
		{"198.18.0.1", true},
		{"198.51.100.7", true},
		{"203.0.113.9", true},
		{"224.0.0.1", true},
		{"239.255.255.250", true},
		{"240.0.0.1", true},
		{"255.255.255.255", true},
		// IPv4-mapped IPv6 variants
		{"::ffff:127.0.0.1", true},
		{"::ffff:10.0.0.1", true},
		{"::ffff:169.254.169.254", true},
		{"::ffff:0.0.0.0", true},
		// NAT64 / 6to4 embedding internal IPv4
		{"64:ff9b::7f00:1", true},
		{"64:ff9b::a9fe:a9fe", true},
		{"64:ff9b::a00:1", true},
		{"2002:7f00:1::1", true},
		{"2002:c0a8:101::1", true},
		// IPv6 special purpose
		{"::", true},
		{"::1", true},
		{"::127.0.0.1", true}, // IPv4-compatible (deprecated)
		{"64:ff9b:1::1", true},
		{"100::1", true},
		{"2001::1", true}, // Teredo
		{"2001:db8::1", true},
		{"3fff::1", true},
		{"fc00::1", true},
		{"fd12:3456::1", true},
		{"fe80::1", true},
		{"fec0::1", true},
		{"ff02::1", true},
	}
	for _, tt := range tests {
		t.Run(tt.ip, func(t *testing.T) {
			t.Parallel()
			reason := blockedReason(netip.MustParseAddr(tt.ip))
			if (reason != "") != tt.blocked {
				t.Fatalf("blockedReason(%s) = %q, want blocked=%v", tt.ip, reason, tt.blocked)
			}
		})
	}
	if blockedReason(netip.Addr{}) == "" {
		t.Error("zero Addr must be blocked")
	}
}

func TestCheckIP(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		opts    Options
		ip      string
		wantErr bool
	}{
		{"loopback blocked", Options{}, "127.0.0.1", true},
		{"public ok", Options{}, "8.8.8.8", false},
		{"allow private", Options{AllowPrivate: true}, "10.0.0.1", false},
		{"allow cidr", Options{AllowCIDRs: []netip.Prefix{netip.MustParsePrefix("192.168.1.10/32")}}, "192.168.1.10", false},
		{"allow cidr mapped", Options{AllowCIDRs: []netip.Prefix{netip.MustParsePrefix("192.168.1.10/32")}}, "::ffff:192.168.1.10", false},
		{"cidr miss", Options{AllowCIDRs: []netip.Prefix{netip.MustParsePrefix("192.168.1.10/32")}}, "192.168.1.11", true},
		{"zone stripped", Options{}, "fe80::1%eth0", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			err := tt.opts.CheckIP(netip.MustParseAddr(tt.ip))
			if (err != nil) != tt.wantErr {
				t.Fatalf("CheckIP() error = %v, wantErr %v", err, tt.wantErr)
			}
			if err != nil && !errors.Is(err, domain.ErrForbiddenTarget) {
				t.Errorf("error %v does not wrap ErrForbiddenTarget", err)
			}
		})
	}
}

func TestControl(t *testing.T) {
	t.Parallel()
	o := Options{}
	tests := []struct {
		name, network, address string
		wantErr                bool
	}{
		{"public v4", "tcp4", "8.8.8.8:443", false},
		{"public v6", "tcp6", "[2606:4700::1]:8443", false},
		{"loopback", "tcp4", "127.0.0.1:80", true},
		{"udp", "udp4", "8.8.8.8:53", true},
		{"no port", "tcp4", "8.8.8.8", true},
		{"hostname", "tcp4", "example.com:80", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			err := o.control(tt.network, tt.address, nil)
			if (err != nil) != tt.wantErr {
				t.Fatalf("control() error = %v, wantErr %v", err, tt.wantErr)
			}
			if err != nil && !errors.Is(err, domain.ErrForbiddenTarget) {
				t.Errorf("error %v does not wrap ErrForbiddenTarget", err)
			}
		})
	}
}

func okServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "ok")
	}))
	t.Cleanup(srv.Close)
	return srv
}

func get(t *testing.T, c *http.Client, u string) error {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, u, http.NoBody)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	return nil
}

func TestClientBlocksLoopback(t *testing.T) {
	t.Parallel()
	srv := okServer(t)
	_, port, _ := net.SplitHostPort(srv.Listener.Addr().String())

	for _, u := range []string{
		srv.URL,
		"http://localhost:" + port, // name resolving to an internal address
	} {
		err := get(t, NewClient(Options{}), u)
		if !errors.Is(err, domain.ErrForbiddenTarget) {
			t.Errorf("GET %s: error = %v, want ErrForbiddenTarget", u, err)
		}
		var uerr *url.Error
		if !errors.As(err, &uerr) {
			t.Errorf("GET %s: error %T is not *url.Error", u, err)
		}
	}
}

func TestClientAllowed(t *testing.T) {
	t.Parallel()
	srv := okServer(t)
	for _, opts := range []Options{
		{AllowPrivate: true},
		{AllowCIDRs: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}},
	} {
		if err := get(t, NewClient(opts), srv.URL); err != nil {
			t.Errorf("opts %+v: %v", opts, err)
		}
	}
}

func TestClientRejectsSchemes(t *testing.T) {
	t.Parallel()
	c := NewClient(Options{AllowPrivate: true})
	for _, u := range []string{"file:///etc/passwd", "ftp://example.com/", "gopher://x/"} {
		err := get(t, c, u)
		if !errors.Is(err, domain.ErrForbiddenTarget) {
			t.Errorf("GET %s: error = %v, want ErrForbiddenTarget", u, err)
		}
	}
	// A request body must be closed even when rejected.
	body := &closeTracker{Reader: strings.NewReader("x")}
	req, _ := http.NewRequestWithContext(t.Context(), http.MethodPost, "ftp://x/", body)
	if _, err := c.Transport.RoundTrip(req); err == nil {
		t.Fatal("expected error")
	}
	if !body.closed {
		t.Error("request body not closed")
	}
}

type closeTracker struct {
	io.Reader
	closed bool
}

func (c *closeTracker) Close() error { c.closed = true; return nil }

func TestClientRedirects(t *testing.T) {
	t.Parallel()
	loop := okServer(t) // placeholder for its port
	_, port, _ := net.SplitHostPort(loop.Listener.Addr().String())

	mux := http.NewServeMux()
	mux.HandleFunc("/hop/{n}", func(w http.ResponseWriter, r *http.Request) {
		var n int
		_, _ = fmt.Sscan(r.PathValue("n"), &n)
		if n == 0 {
			_, _ = io.WriteString(w, "done")
			return
		}
		http.Redirect(w, r, fmt.Sprintf("/hop/%d", n-1), http.StatusFound)
	})
	mux.HandleFunc("/internal", func(w http.ResponseWriter, r *http.Request) {
		// 127.0.0.2 is loopback but outside the allowed /32.
		http.Redirect(w, r, "http://127.0.0.2:"+port+"/", http.StatusFound)
	})
	mux.HandleFunc("/file", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "file:///etc/passwd", http.StatusFound)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	allow := []netip.Prefix{netip.MustParsePrefix("127.0.0.1/32")}
	tests := []struct {
		name      string
		opts      Options
		path      string
		wantErr   bool
		forbidden bool
	}{
		{"within limit", Options{AllowCIDRs: allow}, "/hop/5", false, false},
		{"over default limit", Options{AllowCIDRs: allow}, "/hop/6", true, false},
		{"custom limit", Options{AllowCIDRs: allow, MaxRedirects: 1}, "/hop/2", true, false},
		{"redirects disabled", Options{AllowCIDRs: allow, MaxRedirects: -1}, "/hop/1", true, false},
		{"redirect to internal", Options{AllowCIDRs: allow}, "/internal", true, true},
		{"redirect to file", Options{AllowCIDRs: allow}, "/file", true, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			err := get(t, NewClient(tt.opts), srv.URL+tt.path)
			if (err != nil) != tt.wantErr {
				t.Fatalf("error = %v, wantErr %v", err, tt.wantErr)
			}
			if errors.Is(err, domain.ErrForbiddenTarget) != tt.forbidden {
				t.Errorf("error = %v, forbidden = %v", err, tt.forbidden)
			}
		})
	}
}

func TestClientNoHTTPSDowngrade(t *testing.T) {
	t.Parallel()
	plain := okServer(t)
	tlsSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, plain.URL, http.StatusFound)
	}))
	t.Cleanup(tlsSrv.Close)

	c := NewClient(Options{AllowPrivate: true})
	pool := x509.NewCertPool()
	pool.AddCert(tlsSrv.Certificate())
	guard, ok := c.Transport.(schemeGuard)
	if !ok {
		t.Fatalf("unexpected transport %T", c.Transport)
	}
	tr, ok := guard.next.(*http.Transport)
	if !ok {
		t.Fatalf("unexpected transport %T", guard.next)
	}
	tr.TLSClientConfig.RootCAs = pool
	if tr.Proxy != nil {
		t.Error("transport must not use a proxy")
	}

	err := get(t, c, tlsSrv.URL)
	if !errors.Is(err, domain.ErrForbiddenTarget) {
		t.Fatalf("error = %v, want ErrForbiddenTarget", err)
	}
}

func TestReadLimited(t *testing.T) {
	t.Parallel()
	b, err := ReadLimited(strings.NewReader("12345"), 5)
	if err != nil || string(b) != "12345" {
		t.Fatalf("ReadLimited() = %q, %v", b, err)
	}
	_, err = ReadLimited(strings.NewReader("123456"), 5)
	if !errors.Is(err, ErrResponseTooLarge) || !errors.Is(err, domain.ErrUpstream) {
		t.Fatalf("ReadLimited() error = %v", err)
	}
	_, err = ReadLimited(errReader{}, 5)
	if err == nil {
		t.Fatal("expected read error")
	}
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("boom") }
