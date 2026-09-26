package caldav

import (
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"

	"github.com/tbckr/lucid/internal/domain"
)

// maxSRVTargets bounds the number of SRV targets tried per service.
const maxSRVTargets = 3

var (
	propCurrentUserPrincipal = xml.Name{Space: nsDAV, Local: "current-user-principal"}
	propResourceType         = xml.Name{Space: nsDAV, Local: "resourcetype"}
	propCalendarHomeSet      = xml.Name{Space: nsCalDAV, Local: "calendar-home-set"}
)

// Connect implements domain.Provider. It normalizes the server URL, discovers
// the CalDAV context path (URL itself, /.well-known/caldav, DNS SRV), and
// resolves the current user principal and calendar home set.
func (p *Provider) Connect(ctx context.Context, creds domain.Credentials) (domain.Account, error) {
	base, err := normalizeServerURL(creds.ServerURL)
	if err != nil {
		return domain.Account{}, err
	}
	if creds.Username == "" {
		return domain.Account{}, &domain.ValidationError{Msg: "username is required"}
	}
	t := newTransport(p.opts.HTTPClient, creds.Username, creds.Password)

	d := discovery{p: p, t: t}
	for _, cand := range staticCandidates(base) {
		if acct, ok := d.try(ctx, cand); ok {
			return d.finish(ctx, creds, acct)
		}
		if err := ctx.Err(); err != nil {
			return domain.Account{}, fmt.Errorf("%w: %w", domain.ErrUpstream, err)
		}
	}
	if net.ParseIP(base.Hostname()) == nil {
		for _, cand := range d.srvCandidates(ctx, base.Hostname()) {
			if acct, ok := d.try(ctx, cand); ok {
				return d.finish(ctx, creds, acct)
			}
		}
	}
	return domain.Account{}, d.failure()
}

// normalizeServerURL turns user input into an absolute http(s) URL. Bare
// domains get https://.
func normalizeServerURL(raw string) (*url.URL, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil, &domain.ValidationError{Msg: "server URL is required"}
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
		return nil, &domain.ValidationError{Msg: "invalid server URL"}
	}
	u.Scheme = strings.ToLower(u.Scheme)
	u.RawQuery, u.Fragment = "", ""
	if u.Path == "" {
		u.Path = "/"
	}
	return u, nil
}

// staticCandidates returns the URL itself and its /.well-known/caldav.
func staticCandidates(base *url.URL) []*url.URL {
	wk := *base
	wk.Path, wk.RawPath = "/.well-known/caldav", ""
	if base.Path == wk.Path {
		return []*url.URL{base}
	}
	return []*url.URL{base, &wk}
}

// discovery accumulates the outcome of discovery attempts so that the most
// meaningful error can be reported if all candidates fail.
type discovery struct {
	p *Provider
	t *transport

	unauthorized bool
	reached      bool // some candidate answered with HTTP
	forbidden    error
	transport    error
}

type found struct {
	endpoint  *url.URL
	principal *url.URL
}

// try asks cand for the current user principal.
func (d *discovery) try(ctx context.Context, cand *url.URL) (found, bool) {
	ms, resp, err := d.t.propfind(ctx, cand, "0",
		[]xml.Name{propCurrentUserPrincipal, propResourceType}, true)
	if err != nil {
		d.record(err, resp != nil)
		d.p.log.DebugContext(ctx, "caldav discovery candidate failed", "url", redactURL(cand), "error", err)
		return found{}, false
	}
	d.reached = true
	for _, r := range ms.Responses {
		pr := r.ok()
		if pr.CurrentUserPrincipal == nil || strings.TrimSpace(pr.CurrentUserPrincipal.Href) == "" {
			continue
		}
		principal, err := resolveHref(resp.url, pr.CurrentUserPrincipal.Href, false)
		if err != nil {
			continue
		}
		return found{endpoint: resp.url, principal: principal}, true
	}
	return found{}, false
}

func (d *discovery) record(err error, reached bool) {
	switch code := statusCode(err); {
	case code == 401 || code == 403:
		d.unauthorized = true
	case errors.Is(err, domain.ErrForbiddenTarget):
		d.forbidden = err
	case reached:
		d.reached = true
	default:
		d.transport = err
	}
}

func (d *discovery) failure() error {
	switch {
	case d.unauthorized:
		return fmt.Errorf("%w: server rejected the credentials", domain.ErrUnauthorized)
	case d.forbidden != nil:
		return fmt.Errorf("caldav discovery: %w", d.forbidden)
	case d.reached:
		return domain.ErrDiscovery
	case d.transport != nil:
		return mapError(d.transport)
	}
	return domain.ErrDiscovery
}

// finish resolves the calendar home set of the principal.
func (d *discovery) finish(ctx context.Context, creds domain.Credentials, f found) (domain.Account, error) {
	ms, resp, err := d.t.propfind(ctx, f.principal, "0", []xml.Name{propCalendarHomeSet}, false)
	if err != nil {
		if c := statusCode(err); c == 404 || (c >= 400 && c < 500 && c != 401 && c != 403) {
			return domain.Account{}, fmt.Errorf("%w: principal lookup: %w", domain.ErrDiscovery, err)
		}
		return domain.Account{}, mapError(err)
	}
	for _, r := range ms.Responses {
		pr := r.ok()
		if pr.CalendarHomeSet == nil {
			continue
		}
		home, err := resolveHref(resp.url, pr.CalendarHomeSet.Href, true)
		if err != nil {
			continue
		}
		if !strings.HasSuffix(home.Path, "/") {
			home.Path += "/"
			home.RawPath = ""
		}
		return domain.Account{
			Username:        creds.Username,
			Password:        creds.Password,
			ServerURL:       strings.TrimSpace(creds.ServerURL),
			EndpointURL:     f.endpoint.String(),
			PrincipalURL:    f.principal.String(),
			CalendarHomeURL: home.String(),
		}, nil
	}
	return domain.Account{}, fmt.Errorf("%w: no calendar-home-set", domain.ErrDiscovery)
}

// srvCandidates resolves _caldavs._tcp (https) and _caldav._tcp (http) for
// host (RFC 6764) and returns the URLs to try.
func (d *discovery) srvCandidates(ctx context.Context, host string) []*url.URL {
	var out []*url.URL
	for _, svc := range []struct{ service, scheme string }{{"caldavs", "https"}, {"caldav", "http"}} {
		_, addrs, err := d.p.opts.Resolver.LookupSRV(ctx, svc.service, "tcp", host)
		if err != nil {
			d.p.log.DebugContext(ctx, "caldav SRV lookup failed", "service", svc.service, "host", host, "error", err)
			continue
		}
		n := 0
		for _, a := range addrs {
			target := strings.TrimSuffix(a.Target, ".")
			if target == "" || n >= maxSRVTargets {
				continue
			}
			n++
			hostport := net.JoinHostPort(target, strconv.Itoa(int(a.Port)))
			out = append(out,
				&url.URL{Scheme: svc.scheme, Host: hostport, Path: "/.well-known/caldav"},
				&url.URL{Scheme: svc.scheme, Host: hostport, Path: "/"},
			)
		}
	}
	return out
}
