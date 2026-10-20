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

// structuralNames are the path segments that stay as they are outside the home
// and the principal: the names that CalDAV servers and the usual paths to them
// are built from, which say what kind of server it is and nothing about the
// user (FR-36). They are matched whole, percent-decoded and in exactly this
// case ("SOGo" is how SOGo spells it). A user can name a calendar like one of
// them, and then that name shows: the price of keeping the discovery paths
// readable.
var structuralNames = map[string]bool{
	".well-known": true, "caldav": true, "carddav": true, "dav": true,
	"remote.php": true, "dav.php": true, "caldav.php": true, "cal.php": true, "index.php": true,
	"principals": true, "principal": true, "users": true, "user": true,
	"calendars": true, "calendar": true,
	"SOGo": true, "so": true, "radicale": true, "baikal": true, "nextcloud": true, "owncloud": true,
	"apps": true, "api": true, "public": true, "home": true, "html": true, "v1": true, "v2": true,
}

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

// Path replaces the user-chosen names in a URL path:
//
//  1. Names.Home, found anywhere in the path as a run of whole segments (a
//     server behind a prefix such as "/nextcloud" has its home further in):
//     "{home}/", then the first segment after it as "cal-<h>", the second as
//     "obj-<h>" (an ".ics" suffix stays) and deeper ones as "seg-<h>".
//  2. Names.Principal, found the same way: "{principal}/", then every segment as
//     "seg-<h>".
//  3. Otherwise a segment that is the username is replaced, see RedactUser,
//     and one that is a structural name (structuralNames) stays: the structure
//     of the server is what makes a discovery path readable. A segment that
//     ends in ".ics" is an object name and becomes "obj-<h>.ics", and every
//     other one is a name somebody chose, a calendar the user pasted the URL
//     of, and becomes "seg-<h>".
//
// Of the home and the principal the one whose run starts first applies, the
// home if both start at the same segment: what is below the one that starts
// first is below it, even if the other turns up in it. What comes before the
// home or principal is treated like rule 3. <h> is the first 8 hex characters
// of HMAC-SHA256(key, percent-decoded segment). A trailing slash is preserved.
func (p *Pseudonymizer) Path(n Names, path string) string {
	segs := strings.Split(path, "/")
	homeAt, homeRest, homeOK := below(segs, n.Home)
	principalAt, principalRest, principalOK := below(segs, n.Principal)
	switch {
	case homeOK && (!principalOK || homeAt <= principalAt):
		return p.lead(n, segs[:homeAt]) + "{home}/" + p.placeholders(homeRest, "cal", "obj", "seg")
	case principalOK:
		return p.lead(n, segs[:principalAt]) + "{principal}/" + p.placeholders(principalRest, "seg")
	}
	return p.outside(n, segs)
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
	segs := strings.Split(path, "/")
	redactUser(username, segs)
	return strings.Join(segs, "/")
}

// redactUser is RedactUser on segments, in place.
func redactUser(username string, segs []string) {
	if username == "" {
		return
	}
	local, _, hasAt := strings.Cut(username, "@")
	for i, seg := range segs {
		dec := decode(seg)
		if strings.EqualFold(dec, username) || (hasAt && local != "" && strings.EqualFold(dec, local)) {
			segs[i] = "{user}"
		}
	}
}

// lead is the part of a path in front of the home or the principal, with the
// slash that joins it to what follows; empty if there is none. The slash that
// starts an absolute path is the one of the first segment, so a path that
// starts at the home has no lead.
func (p *Pseudonymizer) lead(n Names, segs []string) string {
	if out := p.outside(n, segs); out != "" {
		return out + "/"
	}
	return ""
}

// outside is what rule 3 does to segments that are neither the home nor below
// it: the username is replaced, the structural names stay, and every other
// name, objects included, is hashed. Empty segments stay empty.
func (p *Pseudonymizer) outside(n Names, segs []string) string {
	redactUser(n.Username, segs)
	for i, seg := range segs {
		dec := decode(seg)
		switch {
		case seg == "" || seg == "{user}" || structuralNames[dec]:
		case hasICSSuffix(dec):
			segs[i] = "obj-" + p.hash(dec) + ".ics"
		default:
			segs[i] = "seg-" + p.hash(dec)
		}
	}
	return strings.Join(segs, "/")
}

// below finds the segments of dir, a URL path, in the segments of a path as a
// run of whole segments, the first such run, and returns the index of its first
// segment and the segments after it. Segments are compared percent-decoded, so
// a dir without its trailing slash does not match a longer name and a
// differently escaped dir still matches. The path must reach past dir: the
// segment after dir's slash may be empty (a trailing slash), but must exist.
func below(segs []string, dir string) (at int, rest []string, ok bool) {
	if dir == "" {
		return 0, nil, false
	}
	var want []string
	if trimmed := strings.Trim(dir, "/"); trimmed != "" {
		want = strings.Split(trimmed, "/")
	}
	// The slash that starts an absolute path is no segment of the run.
	first := 0
	if segs[0] == "" {
		first = 1
	}
	for i := first; i+len(want) < len(segs); i++ {
		if matchRun(segs[i:], want) {
			return i, segs[i+len(want):], true
		}
	}
	return 0, nil, false
}

// matchRun reports whether segs start with want, compared percent-decoded.
func matchRun(segs, want []string) bool {
	for i, w := range want {
		if decode(segs[i]) != decode(w) {
			return false
		}
	}
	return true
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
		if kind == "obj" && hasICSSuffix(dec) {
			out[i] += ".ics"
		}
	}
	return strings.Join(out, "/")
}

// hasICSSuffix reports whether s ends in ".ics", in any case: the name of a
// calendar object.
func hasICSSuffix(s string) bool {
	return len(s) >= len(".ics") && strings.EqualFold(s[len(s)-len(".ics"):], ".ics")
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
