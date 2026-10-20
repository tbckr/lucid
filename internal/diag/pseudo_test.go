package diag

import (
	"net/url"
	"regexp"
	"strings"
	"testing"
)

var testKey = []byte("0123456789abcdef0123456789abcdef")

func TestPathBelowHome(t *testing.T) {
	t.Parallel()
	p := NewPseudonymizer(testKey)
	n := Names{Username: "alice", Home: "/remote.php/dav/calendars/alice/"}
	const object = "/remote.php/dav/calendars/alice/therapy/3f9a.ics"

	got := p.Path(n, object)
	if !regexp.MustCompile(`^\{home\}/cal-[0-9a-f]{8}/obj-[0-9a-f]{8}\.ics$`).MatchString(got) {
		t.Fatalf("Path(%q) = %q, want {home}/cal-<h>/obj-<h>.ics", object, got)
	}
	for _, leak := range []string{"therapy", "3f9a", "alice"} {
		if strings.Contains(got, leak) {
			t.Errorf("Path(%q) = %q leaks %q", object, got, leak)
		}
	}
	if again := p.Path(n, object); again != got {
		t.Errorf("second call = %q, want the same %q", again, got)
	}
	if got := p.Path(n, "/remote.php/dav/calendars/alice/"); got != "{home}/" {
		t.Errorf("Path(home) = %q, want {home}/", got)
	}
	if got := p.Path(n, "/remote.php/dav/calendars/alice/therapy/"); !strings.HasSuffix(got, "/") {
		t.Errorf("Path(calendar collection) = %q, want a trailing slash", got)
	}
}

func TestPathBelowHomeDeeperAndEncoded(t *testing.T) {
	t.Parallel()
	p := NewPseudonymizer(testKey)
	n := Names{Home: "/dav/calendars/alice%40example.com/"}
	seg := regexp.MustCompile(`^\{home\}/cal-[0-9a-f]{8}/obj-[0-9a-f]{8}/seg-[0-9a-f]{8}$`)

	// Deeper than the object: the third segment and below are seg-<h>.
	if got := p.Path(n, "/dav/calendars/alice@example.com/c/o/attachment"); !seg.MatchString(got) {
		t.Errorf("deeper path = %q, want {home}/cal-<h>/obj-<h>/seg-<h>", got)
	}
	// Every level below the third is seg-<h> too.
	deep := regexp.MustCompile(`^\{home\}/cal-[0-9a-f]{8}/obj-[0-9a-f]{8}(/seg-[0-9a-f]{8}){3}$`)
	if got := p.Path(n, "/dav/calendars/alice@example.com/c/o/a/b/c"); !deep.MatchString(got) {
		t.Errorf("deep path = %q, want three seg-<h> below obj-<h>", got)
	}
	// An object without .ics gets no suffix; a different escape of the home still matches.
	got := p.Path(n, "/dav/calendars/alice%40example.com/c/o")
	if !regexp.MustCompile(`^\{home\}/cal-[0-9a-f]{8}/obj-[0-9a-f]{8}$`).MatchString(got) {
		t.Errorf("object without suffix = %q, want {home}/cal-<h>/obj-<h>", got)
	}
}

func TestPathObjectSuffix(t *testing.T) {
	t.Parallel()
	p := NewPseudonymizer(testKey)
	n := Names{Home: "/dav/calendars/alice/"}

	// The suffix is kept for the object only, in any case, and is not hashed away.
	if got := p.Path(n, "/dav/calendars/alice/c/o.ICS"); !strings.HasSuffix(got, ".ics") {
		t.Errorf("object with .ICS = %q, want a .ics suffix", got)
	}
	if got := p.Path(n, "/dav/calendars/alice/c/.ics"); !strings.HasSuffix(got, ".ics") {
		t.Errorf("object named .ics = %q, want a .ics suffix", got)
	}
	if got := p.Path(n, "/dav/calendars/alice/c.ics/"); strings.Contains(got, ".ics") {
		t.Errorf("calendar named c.ics = %q, want no suffix", got)
	}
}

func TestPathEqualSegmentsHashEqual(t *testing.T) {
	t.Parallel()
	p := NewPseudonymizer(testKey)
	n := Names{Home: "/dav/calendars/alice/"}

	// The hash is over the percent-decoded segment, so both escapes agree.
	a := p.Path(n, "/dav/calendars/alice/j%C3%B6rg/")
	b := p.Path(n, "/dav/calendars/alice/jörg/")
	if a != b {
		t.Errorf("escaped %q != unescaped %q", a, b)
	}
	if c := p.Path(n, "/dav/calendars/alice/jorg/"); c == a {
		t.Errorf("different segments share the placeholder %q", c)
	}
}

func TestPathHomeBelowPrincipal(t *testing.T) {
	t.Parallel()
	p := NewPseudonymizer(testKey)
	n := Names{Principal: "/dav/user/", Home: "/dav/user/calendars/"}

	if got := p.Path(n, "/dav/user/calendars/x/"); !regexp.MustCompile(`^\{home\}/cal-[0-9a-f]{8}/$`).MatchString(got) {
		t.Errorf("below home = %q, want {home}/cal-<h>/", got)
	}
	if got := p.Path(n, "/dav/user/"); got != "{principal}/" {
		t.Errorf("principal = %q, want {principal}/", got)
	}
	if got := p.Path(n, "/dav/user/inbox/"); !regexp.MustCompile(`^\{principal\}/seg-[0-9a-f]{8}/$`).MatchString(got) {
		t.Errorf("below principal = %q, want {principal}/seg-<h>/", got)
	}
}

func TestPathPrefixIsWholeSegments(t *testing.T) {
	t.Parallel()
	p := NewPseudonymizer(testKey)

	// A Principal without its trailing slash must not match a longer name.
	n := Names{Principal: "/dav/user"}
	if got := p.Path(n, "/dav/username/x"); got != "/dav/username/x" {
		t.Errorf("sibling of the principal = %q, want it unchanged", got)
	}
	if got := p.Path(n, "/dav/user/x"); !strings.HasPrefix(got, "{principal}/seg-") {
		t.Errorf("below the principal = %q, want {principal}/seg-<h>", got)
	}
	// The home without its slash is not below the home.
	n = Names{Home: "/dav/calendars/alice/"}
	if got := p.Path(n, "/dav/calendars/alice"); got != "/dav/calendars/alice" {
		t.Errorf("home without slash = %q, want it unchanged", got)
	}
}

func TestPathUsernameForms(t *testing.T) {
	t.Parallel()
	p := NewPseudonymizer(testKey)
	tests := []struct {
		name     string
		username string
		path     string
		want     string
	}{
		{"email as sent", "alice@example.com", "/dav/alice@example.com/", "/dav/{user}/"},
		{"email escaped", "alice@example.com", "/dav/alice%40example.com/", "/dav/{user}/"},
		{"email other case", "alice@example.com", "/dav/ALICE%40Example.COM/", "/dav/{user}/"},
		{"local part", "alice@example.com", "/dav/alice/", "/dav/{user}/"},
		{"non-ascii", "jörg", "/dav/j%C3%B6rg/", "/dav/{user}/"},
		{"in a name that is no object", "alice", "/dav/alice/cal.txt", "/dav/{user}/cal.txt"},
		{"caldav kept", "cal", "/caldav/", "/caldav/"},
		{"calendars kept", "cal", "/calendars/", "/calendars/"},
		{"well-known kept", "cal", "/.well-known/caldav", "/.well-known/caldav"},
		{"substring kept", "alice", "/dav/alice-two/xalice/", "/dav/alice-two/xalice/"},
		{"no username", "", "/dav//x/", "/dav//x/"},
		{"email without local part", "@example.com", "/dav//x/", "/dav//x/"},
		{"other segments as sent", "alice", "/Cal%20One/alice/", "/Cal%20One/{user}/"},
		{"invalid escape as sent", "alice", "/dav/%zz/alice/", "/dav/%zz/{user}/"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := p.Path(Names{Username: tc.username}, tc.path); got != tc.want {
				t.Errorf("Path(%q, %q) = %q, want %q", tc.username, tc.path, got, tc.want)
			}
		})
	}
}

func TestPathKeys(t *testing.T) {
	t.Parallel()
	n := Names{Home: "/dav/calendars/alice/"}
	const path = "/dav/calendars/alice/therapy/"

	a := NewPseudonymizer([]byte("key one key one key one key one!")).Path(n, path)
	b := NewPseudonymizer([]byte("key two key two key two key two!")).Path(n, path)
	if a == b {
		t.Errorf("different keys gave the same placeholder %q", a)
	}
}

func TestNewPseudonymizerCopiesKey(t *testing.T) {
	t.Parallel()
	n := Names{Home: "/dav/calendars/alice/"}
	const path = "/dav/calendars/alice/therapy/"
	key := []byte("0123456789abcdef0123456789abcdef")

	p := NewPseudonymizer(key)
	want := p.Path(n, path)
	clear(key)
	if got := p.Path(n, path); got != want {
		t.Errorf("Path after the caller cleared its key = %q, want %q", got, want)
	}
}

func TestURL(t *testing.T) {
	t.Parallel()
	p := NewPseudonymizer(testKey)
	n := Names{Username: "alice", Home: "/remote.php/dav/calendars/alice/"}

	u, err := url.Parse("https://u:p@dav.example.com/remote.php/dav/calendars/alice/x/?a=1#frag")
	if err != nil {
		t.Fatal(err)
	}
	got := p.URL(n, u)
	if !regexp.MustCompile(`^https://dav\.example\.com/\{home\}/cal-[0-9a-f]{8}/$`).MatchString(got) {
		t.Errorf("URL = %q, want https://dav.example.com/{home}/cal-<h>/", got)
	}

	for _, tc := range []struct {
		name, raw, want string
	}{
		{"port and user path", "http://127.0.0.1:5232/alice/x", "http://127.0.0.1:5232/{user}/x"},
		{"no path", "https://dav.example.com", "https://dav.example.com"},
		{"root", "https://dav.example.com/", "https://dav.example.com/"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			u, err := url.Parse(tc.raw)
			if err != nil {
				t.Fatal(err)
			}
			if got := p.URL(n, u); got != tc.want {
				t.Errorf("URL(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
	if got := p.URL(n, nil); got != "" {
		t.Errorf("URL(nil) = %q, want empty", got)
	}
}

func TestRedactUser(t *testing.T) {
	t.Parallel()
	if got, want := RedactUser("alice", "/remote.php/dav/calendars/alice/"), "/remote.php/dav/calendars/{user}/"; got != want {
		t.Errorf("RedactUser = %q, want %q", got, want)
	}
	if got := RedactUser("", "/a/b/"); got != "/a/b/" {
		t.Errorf("RedactUser with no username = %q, want it unchanged", got)
	}
}

func TestPathHomeBehindAPrefix(t *testing.T) {
	t.Parallel()
	p := NewPseudonymizer(testKey)
	n := Names{Username: "alice", Home: "/remote.php/dav/calendars/alice/"}
	object := regexp.MustCompile(`^/nextcloud/\{home\}/cal-[0-9a-f]{8}/obj-[0-9a-f]{8}\.ics$`)

	// The probe of the review: the server sits below /nextcloud, so the home is
	// not a prefix of the path, and the calendar and object names must not show.
	const probe = "/nextcloud/remote.php/dav/calendars/alice/therapy/6f1c-uid-0042.ics"
	got := p.Path(n, probe)
	if !object.MatchString(got) {
		t.Errorf("Path(%q) = %q, want /nextcloud/{home}/cal-<h>/obj-<h>.ics", probe, got)
	}
	for _, leak := range []string{"therapy", "6f1c", "0042", "alice"} {
		if strings.Contains(got, leak) {
			t.Errorf("Path(%q) = %q leaks %q", probe, got, leak)
		}
	}
	// The same names give the same placeholders as below a home that is a prefix.
	if direct := p.Path(n, "/remote.php/dav/calendars/alice/therapy/6f1c-uid-0042.ics"); "/nextcloud/"+direct != got {
		t.Errorf("behind a prefix %q, as a prefix %q: the placeholders differ", got, direct)
	}

	for _, tc := range []struct{ name, path, want string }{
		{"the home itself", "/nextcloud/remote.php/dav/calendars/alice/", "/nextcloud/{home}/"},
		{"two prefix segments", "/a/b/remote.php/dav/calendars/alice/", "/a/b/{home}/"},
		{"escaped", "/nextcloud/remote.php/dav/calendars/ali%63e/", "/nextcloud/{home}/"},
		{"without the leading slash", "nextcloud/remote.php/dav/calendars/alice/", "nextcloud/{home}/"},
		{"username in the prefix", "/alice/remote.php/dav/calendars/alice/", "/{user}/{home}/"},
		{"object name in the prefix", "/x.ics/remote.php/dav/calendars/alice/", "/obj-" + p.hash("x.ics") + ".ics/{home}/"},
	} {
		if got := p.Path(n, tc.path); got != tc.want {
			t.Errorf("%s: Path(%q) = %q, want %q", tc.name, tc.path, got, tc.want)
		}
	}

	// The run has to be whole and contiguous, and has to reach past the home.
	for _, path := range []string{
		"/nextcloud/remote.php/dav/calendars/alice",
		"/nextcloud/remote.php/x/dav/calendars/alice/c/",
		"/nextcloud/remote.php/dav/calendars/",
		"/nextcloud/remote.php/dav/calendars/alicex/c/",
	} {
		if got := p.Path(n, path); strings.Contains(got, "{home}") {
			t.Errorf("Path(%q) = %q, want no home in it", path, got)
		}
	}
	// The first run is the home, a later one is a calendar that is named like it.
	got = p.Path(n, "/remote.php/dav/calendars/alice/remote.php/dav/calendars/alice/x")
	if !regexp.MustCompile(`^\{home\}/cal-[0-9a-f]{8}/obj-[0-9a-f]{8}(/seg-[0-9a-f]{8}){3}$`).MatchString(got) {
		t.Errorf("home inside the home = %q, want the first run to be the home", got)
	}
}

func TestPathPrincipalBehindAPrefix(t *testing.T) {
	t.Parallel()
	p := NewPseudonymizer(testKey)
	n := Names{Principal: "/dav/principals/users/alice/", Home: "/dav/calendars/alice/"}

	if got := p.Path(n, "/nextcloud/dav/principals/users/alice/inbox/zz.ics"); !regexp.MustCompile(`^/nextcloud/\{principal\}/seg-[0-9a-f]{8}/seg-[0-9a-f]{8}$`).MatchString(got) {
		t.Errorf("below the principal behind a prefix = %q", got)
	}
	// The home wins when both are in the path.
	if got := p.Path(Names{Principal: "/dav/", Home: "/dav/calendars/alice/"}, "/nextcloud/dav/calendars/alice/c/"); !strings.HasPrefix(got, "/nextcloud/{home}/cal-") {
		t.Errorf("home and principal = %q, want the home rule", got)
	}
}

func TestPathRootHome(t *testing.T) {
	t.Parallel()
	p := NewPseudonymizer(testKey)
	// A server that keeps its calendars at the root: everything is below the home.
	n := Names{Home: "/"}
	if got := p.Path(n, "/work/x.ics"); !regexp.MustCompile(`^\{home\}/cal-[0-9a-f]{8}/obj-[0-9a-f]{8}\.ics$`).MatchString(got) {
		t.Errorf("below the root home = %q", got)
	}
	if got := p.Path(n, "/"); got != "{home}/" {
		t.Errorf("root = %q, want {home}/", got)
	}
	if got := p.Path(n, ""); got != "" {
		t.Errorf("empty path = %q, want it unchanged", got)
	}
}

func TestPathObjectNamesOutsideTheHome(t *testing.T) {
	t.Parallel()
	p := NewPseudonymizer(testKey)
	n := Names{Username: "alice", Home: "/dav/calendars/alice/"}
	ics := regexp.MustCompile(`^/other/\{user\}/obj-[0-9a-f]{8}\.ics$`)

	for _, path := range []string{"/other/alice/zz-canary.ics", "/other/alice/zz-canary.ICS"} {
		got := p.Path(n, path)
		if !ics.MatchString(got) || strings.Contains(strings.ToLower(got), "canary") {
			t.Errorf("Path(%q) = %q, want /other/{user}/obj-<h>.ics", path, got)
		}
	}
	// Whatever else is there stays, as it is outside both.
	if got := p.Path(n, "/other/zz-canary/"); got != "/other/zz-canary/" {
		t.Errorf("Path = %q, want it unchanged", got)
	}
	// An object has the same placeholder wherever it is.
	inside := p.Path(n, "/dav/calendars/alice/c/zz.ics")
	outside := p.Path(n, "/elsewhere/zz.ics")
	if !strings.HasSuffix(inside, "/"+outside[strings.LastIndex(outside, "/")+1:]) {
		t.Errorf("inside %q and outside %q name the object differently", inside, outside)
	}
}

func TestURLHomeBehindAPrefix(t *testing.T) {
	t.Parallel()
	p := NewPseudonymizer(testKey)
	n := Names{Username: "alice", Home: "/remote.php/dav/calendars/alice/"}

	u := mustParse(t, "https://u:p@dav.example.com/nextcloud/remote.php/dav/calendars/alice/therapy/x.ics?a=1#frag")
	got := p.URL(n, u)
	if !regexp.MustCompile(`^https://dav\.example\.com/nextcloud/\{home\}/cal-[0-9a-f]{8}/obj-[0-9a-f]{8}\.ics$`).MatchString(got) {
		t.Errorf("URL = %q, want https://dav.example.com/nextcloud/{home}/cal-<h>/obj-<h>.ics", got)
	}
	// Outside the home an object is named by its placeholder too.
	got = p.URL(n, mustParse(t, "https://dav.example.com/public/zz-canary.ics"))
	if !regexp.MustCompile(`^https://dav\.example\.com/public/obj-[0-9a-f]{8}\.ics$`).MatchString(got) {
		t.Errorf("URL = %q, want https://dav.example.com/public/obj-<h>.ics", got)
	}
}

func TestPathTheRunThatStartsFirstWins(t *testing.T) {
	t.Parallel()
	p := NewPseudonymizer(testKey)
	n := Names{Username: "alice", Principal: "/p/alice/", Home: "/cal/"}

	// The home turns up below the principal, in a name the user chose: the
	// principal starts first, and what is below it is below it.
	got := p.Path(n, "/p/alice/secret-name/cal/x/")
	if !regexp.MustCompile(`^\{principal\}/(seg-[0-9a-f]{8}/){3}$`).MatchString(got) {
		t.Errorf("Path = %q, want {principal}/ and three seg-<h>", got)
	}
	if strings.Contains(got, "secret-name") {
		t.Errorf("Path = %q leaks the name", got)
	}
	// The other way round: the home starts first.
	n = Names{Principal: "/p/", Home: "/cal/alice/"}
	got = p.Path(n, "/cal/alice/c/p/x/")
	if !regexp.MustCompile(`^\{home\}/cal-[0-9a-f]{8}/obj-[0-9a-f]{8}/seg-[0-9a-f]{8}/$`).MatchString(got) {
		t.Errorf("Path = %q, want {home}/cal-<h>/obj-<h>/seg-<h>/", got)
	}
	// Starting at the same segment, the home wins (it is the more specific).
	n = Names{Principal: "/dav/user/", Home: "/dav/user/calendars/"}
	if got := p.Path(n, "/dav/user/calendars/c/"); !strings.HasPrefix(got, "{home}/cal-") {
		t.Errorf("Path = %q, want the home rule", got)
	}
	// Behind a prefix, with both there: the earlier one wins there as well.
	n = Names{Principal: "/p/alice/", Home: "/cal/"}
	if got := p.Path(n, "/nextcloud/p/alice/x/cal/y/"); !strings.HasPrefix(got, "/nextcloud/{principal}/seg-") {
		t.Errorf("Path = %q, want /nextcloud/{principal}/...", got)
	}
}
