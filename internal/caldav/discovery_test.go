package caldav

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/tbckr/lucid/internal/caldav/caldavtest"
	"github.com/tbckr/lucid/internal/domain"
)

// fakeResolver answers SRV lookups from a map keyed by "service/name".
type fakeResolver map[string][]*net.SRV

func (f fakeResolver) LookupSRV(_ context.Context, service, _, name string) (string, []*net.SRV, error) {
	if addrs, ok := f[service+"/"+name]; ok {
		return "", addrs, nil
	}
	return "", nil, errors.New("no such host")
}

// hostOverride fails requests to the given host (simulating an unreachable
// bare domain) and passes everything else to next.
type hostOverride struct {
	host string
	next http.RoundTripper
	err  error
}

func (h hostOverride) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Hostname() == h.host {
		return nil, h.err
	}
	return h.next.RoundTrip(r)
}

func srvFor(t *testing.T, rawURL string) *net.SRV {
	t.Helper()
	u, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	port, _ := strconv.Atoi(u.Port())
	return &net.SRV{Target: u.Hostname() + ".", Port: uint16(port)}
}

func TestConnect(t *testing.T) {
	t.Parallel()

	plain := httptest.NewServer(caldavtest.New(caldavtest.Options{}))
	t.Cleanup(plain.Close)
	prefixed := httptest.NewServer(caldavtest.New(caldavtest.Options{Prefix: "/dav"}))
	t.Cleanup(prefixed.Close)
	prefixed308 := httptest.NewServer(caldavtest.New(caldavtest.Options{Prefix: "/dav", WellKnownStatus: http.StatusPermanentRedirect}))
	t.Cleanup(prefixed308.Close)
	tlsSrv := httptest.NewTLSServer(caldavtest.New(caldavtest.Options{Prefix: "/remote.php/dav"}))
	t.Cleanup(tlsSrv.Close)
	notDAV := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("<html>hello</html>"))
	}))
	t.Cleanup(notDAV.Close)
	closed := httptest.NewServer(http.NotFoundHandler())
	closedURL := closed.URL
	closed.Close()

	unreachable := func(next http.RoundTripper) *http.Client {
		return &http.Client{Transport: hostOverride{host: "example.test", next: next, err: errors.New("dial example.test: no such host")}}
	}

	tests := []struct {
		name         string
		client       *http.Client
		resolver     fakeResolver
		creds        domain.Credentials
		wantErr      error
		wantEndpoint string
		wantHome     string
	}{
		{
			name:         "context root is the URL itself",
			client:       plain.Client(),
			creds:        domain.Credentials{ServerURL: plain.URL, Username: "user", Password: "pass"},
			wantEndpoint: plain.URL + "/",
			wantHome:     plain.URL + "/user/calendars/",
		},
		{
			name:         "principal URL given directly",
			client:       plain.Client(),
			creds:        domain.Credentials{ServerURL: plain.URL + "/user/", Username: "user", Password: "pass"},
			wantEndpoint: plain.URL + "/user/",
			wantHome:     plain.URL + "/user/calendars/",
		},
		{
			name:         "well-known 301 redirect",
			client:       prefixed.Client(),
			creds:        domain.Credentials{ServerURL: prefixed.URL, Username: "user", Password: "pass"},
			wantEndpoint: prefixed.URL + "/dav/",
			wantHome:     prefixed.URL + "/dav/user/calendars/",
		},
		{
			name:         "well-known 308 redirect",
			client:       prefixed308.Client(),
			creds:        domain.Credentials{ServerURL: prefixed308.URL + "/", Username: "user", Password: "pass"},
			wantEndpoint: prefixed308.URL + "/dav/",
			wantHome:     prefixed308.URL + "/dav/user/calendars/",
		},
		{
			name:         "bare host gets https",
			client:       tlsSrv.Client(),
			creds:        domain.Credentials{ServerURL: strings.TrimPrefix(tlsSrv.URL, "https://"), Username: "user", Password: "pass"},
			wantEndpoint: tlsSrv.URL + "/remote.php/dav/",
			wantHome:     tlsSrv.URL + "/remote.php/dav/user/calendars/",
		},
		{
			name:         "DNS SRV _caldavs",
			client:       unreachable(tlsSrv.Client().Transport),
			resolver:     fakeResolver{"caldavs/example.test": {srvFor(t, tlsSrv.URL)}},
			creds:        domain.Credentials{ServerURL: "example.test", Username: "user", Password: "pass"},
			wantEndpoint: tlsSrv.URL + "/remote.php/dav/",
			wantHome:     tlsSrv.URL + "/remote.php/dav/user/calendars/",
		},
		{
			name:     "DNS SRV _caldav falls back to http",
			client:   unreachable(http.DefaultTransport),
			resolver: fakeResolver{"caldav/example.test": {{Target: "."}, srvFor(t, plain.URL)}},
			creds:    domain.Credentials{ServerURL: "example.test", Username: "user", Password: "pass"},
			// The SRV target's .well-known redirects to the root.
			wantEndpoint: plain.URL + "/",
			wantHome:     plain.URL + "/user/calendars/",
		},
		{
			name:    "wrong password",
			client:  plain.Client(),
			creds:   domain.Credentials{ServerURL: plain.URL, Username: "user", Password: "nope"},
			wantErr: domain.ErrUnauthorized,
		},
		{
			name:    "not a CalDAV server",
			client:  notDAV.Client(),
			creds:   domain.Credentials{ServerURL: notDAV.URL, Username: "user", Password: "pass"},
			wantErr: domain.ErrDiscovery,
		},
		{
			name:    "unreachable",
			client:  http.DefaultClient,
			creds:   domain.Credentials{ServerURL: closedURL, Username: "user", Password: "pass"},
			wantErr: domain.ErrUpstream,
		},
		{
			name: "SSRF protection is preserved",
			client: &http.Client{Transport: hostOverride{
				host: "127.0.0.1", next: http.DefaultTransport,
				err: fmt.Errorf("dial 127.0.0.1: %w", domain.ErrForbiddenTarget),
			}},
			creds:   domain.Credentials{ServerURL: plain.URL, Username: "user", Password: "pass"},
			wantErr: domain.ErrForbiddenTarget,
		},
		{
			name:    "empty URL",
			client:  plain.Client(),
			creds:   domain.Credentials{ServerURL: " ", Username: "user"},
			wantErr: domain.ErrInvalidInput,
		},
		{
			name:    "unsupported scheme",
			client:  plain.Client(),
			creds:   domain.Credentials{ServerURL: "ftp://example.com", Username: "user"},
			wantErr: domain.ErrInvalidInput,
		},
		{
			name:    "user info in URL",
			client:  plain.Client(),
			creds:   domain.Credentials{ServerURL: "https://a:b@example.com", Username: "user"},
			wantErr: domain.ErrInvalidInput,
		},
		{
			name:    "empty username",
			client:  plain.Client(),
			creds:   domain.Credentials{ServerURL: plain.URL},
			wantErr: domain.ErrInvalidInput,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			p, err := NewProvider(Options{HTTPClient: tt.client, Resolver: tt.resolver})
			mustNoErr(t, err)
			if tt.resolver == nil {
				p.opts.Resolver = fakeResolver{}
			}
			acct, err := p.Connect(t.Context(), tt.creds)
			if tt.wantErr != nil {
				mustErr(t, err, tt.wantErr)
				return
			}
			mustNoErr(t, err)
			if acct.EndpointURL != tt.wantEndpoint {
				t.Errorf("EndpointURL = %q; want %q", acct.EndpointURL, tt.wantEndpoint)
			}
			if acct.CalendarHomeURL != tt.wantHome {
				t.Errorf("CalendarHomeURL = %q; want %q", acct.CalendarHomeURL, tt.wantHome)
			}
			if acct.Username != tt.creds.Username || acct.Password != tt.creds.Password || acct.PrincipalURL == "" {
				t.Errorf("unexpected account %+v", acct)
			}
		})
	}
}

func TestConnectPrincipalWithoutHomeSet(t *testing.T) {
	t.Parallel()
	mock := caldavtest.New(caldavtest.Options{})
	mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
		if r.Method == "PROPFIND" && r.URL.Path == mock.PrincipalPath() {
			w.WriteHeader(http.StatusMultiStatus)
			_, _ = w.Write([]byte(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>/user/</d:href>` +
				`<d:propstat><d:prop/><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`))
			return true
		}
		return false
	})
	ts := httptest.NewServer(mock)
	t.Cleanup(ts.Close)
	p := newProvider(t, ts.Client())
	_, err := p.Connect(t.Context(), domain.Credentials{ServerURL: ts.URL, Username: "user", Password: "pass"})
	mustErr(t, err, domain.ErrDiscovery)
}

func TestConnectPrincipalErrors(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		status  int
		wantErr error
	}{
		{"principal missing", http.StatusNotFound, domain.ErrDiscovery},
		{"principal forbidden", http.StatusForbidden, domain.ErrUnauthorized},
		{"server error", http.StatusInternalServerError, domain.ErrUpstream},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			mock := caldavtest.New(caldavtest.Options{})
			mock.SetHook(func(w http.ResponseWriter, r *http.Request) bool {
				if r.URL.Path == mock.PrincipalPath() {
					w.WriteHeader(tt.status)
					return true
				}
				return false
			})
			ts := httptest.NewServer(mock)
			t.Cleanup(ts.Close)
			p := newProvider(t, ts.Client())
			_, err := p.Connect(t.Context(), domain.Credentials{ServerURL: ts.URL, Username: "user", Password: "pass"})
			mustErr(t, err, tt.wantErr)
		})
	}
}

func TestRedirectPolicy(t *testing.T) {
	t.Parallel()
	var otherHits atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		otherHits.Add(1)
		w.WriteHeader(http.StatusMultiStatus)
	}))
	t.Cleanup(other.Close)
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/loop":
			http.Redirect(w, r, "/loop", http.StatusFound)
		case "/noloc":
			w.WriteHeader(http.StatusFound)
		case "/scheme":
			w.Header().Set("Location", "ftp://example.com/")
			w.WriteHeader(http.StatusFound)
		case "/same":
			http.Redirect(w, r, "/target", http.StatusTemporaryRedirect)
		case "/target":
			if r.Method != "PROPFIND" || r.Header.Get("Authorization") == "" {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			w.WriteHeader(http.StatusMultiStatus)
			_, _ = w.Write([]byte(`<multistatus xmlns="DAV:"/>`))
		default:
			http.Redirect(w, r, other.URL+"/", http.StatusMovedPermanently)
		}
	}))
	t.Cleanup(redirector.Close)

	tr := newTransport(http.DefaultClient, "user", "pass")
	tests := []struct {
		name      string
		path      string
		discovery bool
		wantErr   bool
	}{
		{"same host keeps method and credentials", "/same", false, false},
		{"other host refused during discovery", "/x", true, true},
		{"other host refused otherwise", "/x", false, true},
		{"redirect loop", "/loop", false, true},
		{"missing location", "/noloc", false, true},
		{"unsupported scheme", "/scheme", true, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			u, _ := url.Parse(redirector.URL + tt.path)
			_, _, err := tr.propfind(t.Context(), u, "0", nil, tt.discovery)
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v; wantErr %v", err, tt.wantErr)
			}
		})
	}
	t.Run("credentials never reach the other host", func(t *testing.T) {
		t.Parallel()
		u, _ := url.Parse(redirector.URL + "/leak")
		_, _, _ = tr.propfind(t.Context(), u, "0", nil, true)
		if n := otherHits.Load(); n != 0 {
			t.Fatalf("other host received %d requests", n)
		}
	})
}

func TestCheckRedirect(t *testing.T) {
	t.Parallel()
	parse := func(s string) *url.URL {
		u, err := url.Parse(s)
		if err != nil {
			t.Fatal(err)
		}
		return u
	}
	orig := parse("https://example.com/.well-known/caldav")
	tests := []struct {
		next      string
		discovery bool
		ok        bool
	}{
		{"https://example.com/dav/", false, true},
		{"https://dav.example.com/dav/", true, true},
		{"https://dav.example.com/dav/", false, false},
		{"https://example.com.evil.net/", true, false},
		{"https://notexample.com/", true, false},
		{"http://example.com/dav/", true, false},
		{"https://example.com:8443/dav/", true, false},
		{"file:///etc/passwd", true, false},
	}
	for _, tt := range tests {
		err := checkRedirect(orig, orig, parse(tt.next), tt.discovery)
		if (err == nil) != tt.ok {
			t.Errorf("checkRedirect(%s, discovery=%v) = %v; want ok=%v", tt.next, tt.discovery, err, tt.ok)
		}
	}
	ip := parse("https://127.0.0.1/")
	if checkRedirect(ip, ip, parse("https://x.127.0.0.1/"), true) == nil {
		t.Error("IP addresses have no subdomains")
	}
}

// TestForbiddenTargetPreserved checks that SSRF rejections by the injected
// client stay recognizable through *url.Error and the service layer.
func TestForbiddenTargetPreserved(t *testing.T) {
	t.Parallel()
	client := &http.Client{Transport: hostOverride{
		host: "dav.example", next: http.DefaultTransport,
		err: fmt.Errorf("safehttp: dial 10.0.0.1:443: %w", domain.ErrForbiddenTarget),
	}}
	p := newProvider(t, client)
	svc := p.Service(domain.Account{Username: "u", CalendarHomeURL: "https://dav.example/home/"})
	_, err := svc.ListCalendars(t.Context())
	mustErr(t, err, domain.ErrForbiddenTarget)
	_, err = svc.ListEvents(t.Context(), encodeID("/home/cal/"), date(2025, 1, 1, 0, 0), date(2025, 2, 1, 0, 0))
	mustErr(t, err, domain.ErrForbiddenTarget)
	var ue *url.Error
	if !errors.As(err, &ue) {
		t.Fatalf("expected *url.Error in chain: %v", err)
	}
}

func TestNormalizeServerURL(t *testing.T) {
	t.Parallel()
	tests := []struct {
		in, want string
	}{
		{"example.com", "https://example.com/"},
		{" https://dav.example.com/remote.php/dav?x=1#f ", "https://dav.example.com/remote.php/dav"},
		{"HTTP://example.com:8080", "http://example.com:8080/"},
	}
	for _, tt := range tests {
		t.Run(tt.in, func(t *testing.T) {
			t.Parallel()
			u, err := normalizeServerURL(tt.in)
			mustNoErr(t, err)
			if u.String() != tt.want {
				t.Fatalf("got %q; want %q", u, tt.want)
			}
		})
	}
}
