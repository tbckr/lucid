package caldav

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/tbckr/lucid/internal/caldav/caldavtest"
	"github.com/tbckr/lucid/internal/domain"
)

const idHome = "/dav/calendars/alice/"

// newTestCodec returns a codec with random keys, as a provider has one.
func newTestCodec(t *testing.T) *idCodec {
	t.Helper()
	encKey, macKey := make([]byte, 32), make([]byte, 32)
	_, _ = rand.Read(encKey)
	_, _ = rand.Read(macKey)
	return newCodecWith(t, encKey, macKey)
}

func newCodecWith(t *testing.T, encKey, macKey []byte) *idCodec {
	t.Helper()
	c, err := newIDCodec(encKey, macKey)
	if err != nil {
		t.Fatalf("newIDCodec: %v", err)
	}
	return c
}

func mustNotFound(t *testing.T, what string, err error) {
	t.Helper()
	if !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("%s: err = %v; want ErrNotFound", what, err)
	}
}

// TestIDRoundTrip checks that an ID decodes to the path it was made from,
// that the same path always gives the same ID, and that the ID shows nothing
// of the path (NFR-36).
func TestIDRoundTrip(t *testing.T) {
	t.Parallel()
	// Fixed keys, so that the leak checks below cannot pass or fail by chance.
	c := newCodecWith(t, bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32))
	objPath := idHome + "work/meeting-42.ics"
	id := c.encode(objPath)

	obj, cal, err := c.decodeObjectID(idHome, id)
	mustNoErr(t, err)
	if obj != objPath || cal != idHome+"work/" {
		t.Fatalf("decodeObjectID = %q in %q; want %q in %q", obj, cal, objPath, idHome+"work/")
	}
	if again := c.encode(objPath); again != id {
		t.Fatalf("encode is not deterministic: %q, then %q", id, again)
	}
	calID := c.encode(idHome + "work/")
	gotCal, err := c.decodeCalendarID(idHome, calID)
	mustNoErr(t, err)
	if gotCal != idHome+"work/" {
		t.Fatalf("decodeCalendarID = %q; want %q", gotCal, idHome+"work/")
	}
	if calID == id {
		t.Fatalf("calendar and object share the ID %q", id)
	}

	for _, seg := range strings.Split(strings.Trim(objPath, "/"), "/") {
		for _, s := range []string{seg, base64.RawURLEncoding.EncodeToString([]byte(seg))} {
			if strings.Contains(id, s) || strings.Contains(calID, s) {
				t.Errorf("IDs %q, %q contain %q of the path segment %q", id, calID, s, seg)
			}
		}
	}
	if legacy := base64.RawURLEncoding.EncodeToString([]byte(idHome)); strings.Contains(id, legacy[:8]) {
		t.Errorf("ID %q starts like the base64url of the path %q", id, legacy)
	}
}

// TestIDConstruction pins the construction against values computed outside
// Go (Python's hmac and hashlib): HKDF-SHA256 of the key without salt, the
// HMAC-SHA256 of the path truncated to 16 bytes as SIV, and the path
// encrypted with AES-256-CTR under that SIV as IV.
func TestIDConstruction(t *testing.T) {
	t.Parallel()
	key := make([]byte, 32)
	for i := range key {
		key[i] = byte(i)
	}
	p, err := NewProvider(Options{HTTPClient: http.DefaultClient, Key: key})
	mustNoErr(t, err)
	const objPath = "/dav/calendars/alice/work/meeting.ics"
	raw, err := base64.RawURLEncoding.DecodeString(p.ids.encode(objPath))
	mustNoErr(t, err)

	const (
		encKey = "2f2670d2840affefa908b3bb1c579b1e87611a8739426878efc4eb003ee1bdf1" // HKDF info "lucid/v1 id-enc"
		siv    = "f24253c766cd1fd4694ee2ff56ed4595"                                 // HMAC under HKDF info "lucid/v1 id-mac"
	)
	if len(raw) != 16+len(objPath) {
		t.Fatalf("ID has %d bytes; want 16 + %d", len(raw), len(objPath))
	}
	if got := hex.EncodeToString(raw[:16]); got != siv {
		t.Fatalf("SIV = %s; want %s", got, siv)
	}
	k, _ := hex.DecodeString(encKey)
	block, err := aes.NewCipher(k)
	mustNoErr(t, err)
	plain := make([]byte, len(raw)-16)
	cipher.NewCTR(block, raw[:16]).XORKeyStream(plain, raw[16:])
	if string(plain) != objPath {
		t.Fatalf("decrypted = %q; want %q", plain, objPath)
	}
}

// TestIDConcurrent backs the codec's claim to be safe for concurrent use:
// all requests of a provider share it (run with -race).
func TestIDConcurrent(t *testing.T) {
	t.Parallel()
	c := newTestCodec(t)
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Go(func() {
			p := idHome + "work/" + strconv.Itoa(i) + ".ics"
			for range 100 {
				if got, _, err := c.decodeObjectID(idHome, c.encode(p)); err != nil || got != p {
					t.Errorf("round trip of %q = %q, %v", p, got, err)
					return
				}
			}
		})
	}
	wg.Wait()
}

func TestIDForeignKey(t *testing.T) {
	t.Parallel()
	a, b := newTestCodec(t), newTestCodec(t)
	_, _, err := b.decodeObjectID(idHome, a.encode(idHome+"work/a.ics"))
	mustNotFound(t, "object", err)
	_, err = b.decodeCalendarID(idHome, a.encode(idHome+"work/"))
	mustNotFound(t, "calendar", err)
}

func TestIDTampered(t *testing.T) {
	t.Parallel()
	c := newTestCodec(t)
	objPath := idHome + "work/a.ics" // 16 + 31 bytes: the last base64 character has spare bits
	id := c.encode(objPath)
	raw, err := base64.RawURLEncoding.DecodeString(id)
	mustNoErr(t, err)
	if _, _, err := c.decodeObjectID(idHome, id); err != nil {
		t.Fatalf("untampered ID: %v", err)
	}

	for i := range raw {
		b := bytes.Clone(raw)
		b[i] ^= 0x01
		_, _, err := c.decodeObjectID(idHome, base64.RawURLEncoding.EncodeToString(b))
		mustNotFound(t, "flipped byte "+strconv.Itoa(i), err)
	}

	// The SIV alone is no ID, not even that of the empty path.
	if _, ok := c.open(c.encode("")); ok {
		t.Error("the ID of the empty path opens")
	}

	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
	if len(raw)%3 == 0 {
		t.Fatalf("test path leaves no spare bits: %d bytes", len(raw))
	}
	last := strings.IndexByte(alphabet, id[len(id)-1])
	nonCanonical := id[:len(id)-1] + string(alphabet[last^1])
	enc := base64.RawURLEncoding.EncodeToString
	tests := map[string]string{
		"10 bytes":                  enc(raw[:10]),
		"only the SIV":              enc(raw[:16]),
		"the SIV of the empty path": c.encode(""),
		"truncated":                 enc(raw[:len(raw)-1]),
		"extended":                  enc(append(bytes.Clone(raw), 'x')),
		"non-canonical base64":      nonCanonical,
		"CR inside":                 id[:5] + "\r" + id[5:],
		"LF inside":                 id[:5] + "\n" + id[5:],
		"CR LF at the end":          id + "\r\n",
		"not base64":                "*/*",
		"padded":                    base64.URLEncoding.EncodeToString(raw),
		"empty":                     "",
		"too long":                  strings.Repeat("A", 5000),
		"too long, though genuine":  c.encode(idHome + "work/" + strings.Repeat("a", 3100) + ".ics"),
	}
	for name, tid := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, _, err := c.decodeObjectID(idHome, tid)
			mustNotFound(t, "object", err)
			_, err = c.decodeCalendarID(idHome, tid)
			mustNotFound(t, "calendar", err)
		})
	}
}

// TestIDLegacyFormat checks that the IDs Lucid issued before (the base64url
// of the path) are no longer accepted.
func TestIDLegacyFormat(t *testing.T) {
	t.Parallel()
	c := newTestCodec(t)
	legacy := base64.RawURLEncoding.EncodeToString
	_, _, err := c.decodeObjectID(idHome, legacy([]byte(idHome+"work/a.ics")))
	mustNotFound(t, "object", err)
	_, err = c.decodeCalendarID(idHome, legacy([]byte(idHome+"work/")))
	mustNotFound(t, "calendar", err)
}

// TestIDOutsideHome checks that a genuine ID still only addresses the
// calendar home it is decoded against.
func TestIDOutsideHome(t *testing.T) {
	t.Parallel()
	c := newTestCodec(t)
	_, _, err := c.decodeObjectID(idHome, c.encode("/other/x.ics"))
	mustNotFound(t, "object", err)
	_, err = c.decodeCalendarID(idHome, c.encode("/other/cal/"))
	mustNotFound(t, "calendar", err)
	_, _, err = c.decodeObjectID(idHome, c.encode(idHome+"../bob/work/x.ics"))
	mustNotFound(t, "traversal", err)
}

func TestStableCalendarID(t *testing.T) {
	t.Parallel()
	// The value the frontend persists: it must never change between releases.
	if got := stableCalendarID("https://dav.example\x00alice", "/dav/calendars/alice/work/"); got != "LnPSpWilT2g0Vp-af-NYtX" {
		t.Fatalf("stableCalendarID = %q; want the pinned value", got)
	}
	if got := stableCalendarID("https://dav.example\x00alice", "/dav/calendars/alice/home/"); got != "2DhQyKBzL_CRMfPBE0Tqh3" {
		t.Fatalf("stableCalendarID = %q; want the pinned value", got)
	}

	e := newEnv(t, caldavtest.Options{})
	for _, slug := range []string{"same-a", "same-b", "same-c"} {
		e.mock.AddCalendar(caldavtest.Calendar{Slug: slug, Name: "Same"})
	}
	list := func(key byte) []domain.Calendar {
		p, err := NewProvider(Options{
			HTTPClient: e.ts.Client(), Key: bytes.Repeat([]byte{key}, 32), Logger: slog.New(slog.DiscardHandler),
		})
		mustNoErr(t, err)
		acct, err := p.Connect(t.Context(), domain.Credentials{ServerURL: e.ts.URL, Username: "user", Password: "pass"})
		mustNoErr(t, err)
		cals, err := p.Service(acct).ListCalendars(t.Context())
		mustNoErr(t, err)
		return cals
	}
	a := list(1)
	if len(a) != 7 {
		t.Fatalf("ListCalendars = %+v; want 7 calendars", a)
	}
	seen := map[string]bool{}
	for _, c := range a {
		if len(c.StableID) != 22 {
			t.Errorf("StableID %q has %d characters; want 22", c.StableID, len(c.StableID))
		}
		seen[c.StableID] = true
	}
	if len(seen) != len(a) {
		t.Errorf("StableIDs not unique per calendar: %+v", a)
	}

	for _, key := range []byte{2, 3, 4} {
		b := list(key)
		if len(b) != len(a) {
			t.Fatalf("key %d: %d calendars; want %d", key, len(b), len(a))
		}
		for i := range a {
			if a[i].StableID != b[i].StableID {
				t.Errorf("key %d: calendar %d StableID %q; want %q (same order, same key)", key, i, b[i].StableID, a[i].StableID)
			}
			if a[i].ID == b[i].ID {
				t.Errorf("key %d: calendar %d ID %q equals the one under another key", key, i, b[i].ID)
			}
		}
		// Calendars of the same name are ordered by their StableID, so the
		// order does not change with the key.
		var same []string
		for _, c := range b {
			if c.Name == "Same" {
				same = append(same, c.StableID)
			}
		}
		if len(same) != 3 || !slices.IsSorted(same) {
			t.Errorf("key %d: same-named calendars in order %q; want 3, sorted by StableID", key, same)
		}
	}
}

func TestNewProviderKeyLength(t *testing.T) {
	t.Parallel()
	for _, n := range []int{0, 16, 31, 33, 64} {
		if _, err := NewProvider(Options{HTTPClient: http.DefaultClient, Key: make([]byte, n)}); err == nil {
			t.Errorf("NewProvider with a %d-byte key: no error", n)
		}
	}

	// nil: a random key per start (NFR-20), kept for further derived keys.
	p1, err := NewProvider(Options{HTTPClient: http.DefaultClient})
	mustNoErr(t, err)
	p2, err := NewProvider(Options{HTTPClient: http.DefaultClient})
	mustNoErr(t, err)
	if len(p1.opts.Key) != 32 || bytes.Equal(p1.opts.Key, p2.opts.Key) {
		t.Fatalf("generated keys %x and %x; want two different 32-byte keys", p1.opts.Key, p2.opts.Key)
	}
	if p1.ids.encode("/a/b/") == p2.ids.encode("/a/b/") {
		t.Fatal("providers with different keys issue the same IDs")
	}

	// A given key is used, and later changes to the caller's slice do not
	// reach the provider.
	key := bytes.Repeat([]byte{7}, 32)
	p3, err := NewProvider(Options{HTTPClient: http.DefaultClient, Key: key})
	mustNoErr(t, err)
	p4, err := NewProvider(Options{HTTPClient: http.DefaultClient, Key: bytes.Clone(key)})
	mustNoErr(t, err)
	key[0] = 8
	if !bytes.Equal(p3.opts.Key, p4.opts.Key) || p3.ids.encode("/a/b/") != p4.ids.encode("/a/b/") {
		t.Fatal("providers with the same key differ")
	}
}

func TestNewIDCodecKeyLength(t *testing.T) {
	t.Parallel()
	k32, k16 := make([]byte, 32), make([]byte, 16)
	for name, keys := range map[string][2][]byte{
		"short encryption key": {k16, k32},
		"short MAC key":        {k32, k16},
		"no MAC key":           {k32, nil},
	} {
		if _, err := newIDCodec(keys[0], keys[1]); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}

// An ID of maxIDLength characters is still worked on; the work is bounded only
// past it.
func TestIDLongest(t *testing.T) {
	t.Parallel()
	c := newTestCodec(t)
	prefix := idHome + "work/"
	objPath := prefix + strings.Repeat("a", base64.RawURLEncoding.DecodedLen(maxIDLength)-sivSize-len(prefix)-len(".ics")) + ".ics"
	id := c.encode(objPath)
	if len(id) != maxIDLength {
		t.Fatalf("ID has %d characters; want %d", len(id), maxIDLength)
	}
	if got, _, err := c.decodeObjectID(idHome, id); err != nil || got != objPath {
		t.Errorf("decodeObjectID = %q, %v; want the path back", got, err)
	}
}
