package diag

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"strings"
)

// hashBytes is how many bytes of the HMAC a placeholder shows: 4 bytes are the
// 8 hex characters that tell two names apart in a log without identifying them.
const hashBytes = 4

// Names are the account-bound names whose position in a path the
// Pseudonymizer knows. Principal and Home are URL paths (Home ends in "/").
// They stay empty while unknown, for example before discovery has run.
type Names struct {
	Username  string
	Principal string
	Home      string
}

// Pseudonymizer turns CalDAV paths into placeholders that carry no
// user-chosen name (NFR-36). It holds only its key, so it is safe for
// concurrent use.
type Pseudonymizer struct {
	key []byte
}

// NewPseudonymizer returns a Pseudonymizer whose placeholders depend on key. A
// caller wanting placeholders that cannot be correlated across runs or
// sessions passes random bytes.
func NewPseudonymizer(key []byte) *Pseudonymizer {
	return &Pseudonymizer{key: bytes.Clone(key)}
}

// Path replaces the user-chosen names in a URL path, first matching rule wins:
//
//  1. Below Names.Home: "{home}/", then the first segment as "cal-<h>", the
//     second as "obj-<h>" (an ".ics" suffix stays) and deeper ones as "seg-<h>".
//  2. Below Names.Principal: "{principal}/", then every segment as "seg-<h>".
//  3. Otherwise only the username is replaced, see RedactUser.
//
// <h> is the first 8 hex characters of HMAC-SHA256(key, percent-decoded
// segment). A trailing slash is preserved.
func (p *Pseudonymizer) Path(n Names, path string) string {
	segs := strings.Split(path, "/")
	if rest, ok := below(segs, n.Home); ok {
		return "{home}/" + p.placeholders(rest, "cal", "obj", "seg")
	}
	if rest, ok := below(segs, n.Principal); ok {
		return "{principal}/" + p.placeholders(rest, "seg")
	}
	return RedactUser(n.Username, path)
}

// URL is the scheme and host of u followed by Path of its path. Userinfo,
// query and fragment are dropped: they carry credentials and tokens.
func (p *Pseudonymizer) URL(n Names, u *url.URL) string {
	if u == nil {
		return ""
	}
	path := p.Path(n, u.EscapedPath())
	if path != "" && !strings.HasPrefix(path, "/") {
		path = "/" + path // "{home}/..." has no leading slash of its own
	}
	return u.Scheme + "://" + u.Host + path
}

// RedactUser replaces every path segment that is the username with "{user}".
// A segment is compared percent-decoded and case-insensitively, and for a
// username with an "@" its local part counts as well. Whole segments only, so
// the username "cal" leaves "/caldav/" alone. Other segments stay as sent.
func RedactUser(username, path string) string {
	if username == "" {
		return path
	}
	local, _, hasAt := strings.Cut(username, "@")
	segs := strings.Split(path, "/")
	for i, seg := range segs {
		dec := decode(seg)
		if strings.EqualFold(dec, username) || (hasAt && local != "" && strings.EqualFold(dec, local)) {
			segs[i] = "{user}"
		}
	}
	return strings.Join(segs, "/")
}

// below reports whether the segments of a path lie below dir, a URL path, and
// returns the segments after it. Whole segments are compared, percent-decoded,
// so a dir without its trailing slash does not match a longer name and a
// differently escaped dir still matches. The path must reach past dir: the
// segment after dir's slash may be empty (a trailing slash), but must exist.
func below(segs []string, dir string) ([]string, bool) {
	if dir == "" {
		return nil, false
	}
	want := strings.Split(strings.TrimSuffix(dir, "/"), "/")
	if len(segs) <= len(want) {
		return nil, false
	}
	for i, w := range want {
		if decode(segs[i]) != decode(w) {
			return nil, false
		}
	}
	return segs[len(want):], true
}

// placeholders names the segments by position: kinds[i] for the i-th, the last
// kind for all deeper ones. Empty segments (a trailing slash) stay empty.
func (p *Pseudonymizer) placeholders(segs []string, kinds ...string) string {
	out := make([]string, len(segs))
	for i, seg := range segs {
		if seg == "" {
			continue
		}
		kind := kinds[min(i, len(kinds)-1)]
		dec := decode(seg)
		out[i] = kind + "-" + p.hash(dec)
		if kind == "obj" && len(dec) >= len(".ics") && strings.EqualFold(dec[len(dec)-len(".ics"):], ".ics") {
			out[i] += ".ics"
		}
	}
	return strings.Join(out, "/")
}

func (p *Pseudonymizer) hash(s string) string {
	mac := hmac.New(sha256.New, p.key)
	mac.Write([]byte(s))
	return hex.EncodeToString(mac.Sum(nil)[:hashBytes])
}

// decode percent-decodes a path segment; one that is not valid is used as sent.
func decode(seg string) string {
	if dec, err := url.PathUnescape(seg); err == nil {
		return dec
	}
	return seg
}
