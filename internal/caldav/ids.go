package caldav

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"path"
	"strings"
	"unicode/utf8"

	"github.com/tbckr/lucid/internal/domain"
)

// IDs are resource paths on the server, encrypted deterministically and
// authenticated under a key that lives in RAM only (NFR-20): SIV-style, the
// first 16 bytes of HMAC-SHA256(macKey, path) are both the tag and the IV of
// AES-256-CTR(encKey) over the path, and the ID is base64url (unpadded) of
// SIV || ciphertext. So the same path gives the same ID until Lucid restarts,
// while URLs in access and reverse-proxy logs show nothing of usernames,
// calendar names or object names (NFR-36). Only IDs this codec issued
// decode; the decoded path is then validated so that an ID can never
// address anything outside the account's calendar home.

const (
	// idKeySize is the size of both codec keys: AES-256 and HMAC-SHA256.
	idKeySize = 32
	// sivSize is the size of the synthetic IV: one AES block.
	sivSize = aes.BlockSize
	// maxIDLength bounds the work for an ID before it is authenticated.
	maxIDLength = 4096
	// stableIDLength is the length of Calendar.StableID (132 bits).
	stableIDLength = 22
)

// idCodec encrypts resource paths to API IDs and back. It is safe for
// concurrent use.
type idCodec struct {
	block  cipher.Block
	macKey []byte
}

func newIDCodec(encKey, macKey []byte) (*idCodec, error) {
	if len(encKey) != idKeySize || len(macKey) != idKeySize {
		return nil, fmt.Errorf("caldav: ID keys must be %d bytes", idKeySize)
	}
	block, err := aes.NewCipher(encKey)
	if err != nil {
		return nil, fmt.Errorf("caldav: %w", err)
	}
	return &idCodec{block: block, macKey: macKey}, nil
}

// encode returns the ID of the resource path p.
func (c *idCodec) encode(p string) string {
	b := make([]byte, sivSize+len(p))
	siv := c.siv([]byte(p))
	copy(b, siv)
	cipher.NewCTR(c.block, siv).XORKeyStream(b[sivSize:], []byte(p))
	return base64.RawURLEncoding.EncodeToString(b)
}

// siv returns the synthetic IV of the plaintext p.
func (c *idCodec) siv(p []byte) []byte {
	m := hmac.New(sha256.New, c.macKey)
	m.Write(p)
	return m.Sum(nil)[:sivSize]
}

// open returns the path id encrypts, if this codec issued id.
func (c *idCodec) open(id string) (string, bool) {
	if len(id) > maxIDLength {
		return "", false
	}
	// One ID per path: Strict refuses variants in the unused bits, and the
	// length the line breaks that the decoder skips anywhere in its input.
	b, err := base64.RawURLEncoding.Strict().DecodeString(id)
	if err != nil || len(b) <= sivSize || len(id) != base64.RawURLEncoding.EncodedLen(len(b)) {
		return "", false
	}
	siv, ct := b[:sivSize], b[sivSize:]
	p := make([]byte, len(ct))
	cipher.NewCTR(c.block, siv).XORKeyStream(p, ct)
	if !hmac.Equal(siv, c.siv(p)) {
		return "", false
	}
	return string(p), true
}

// objRef holds the API IDs of a calendar object and of its calendar, as the
// domain types carry them.
type objRef struct {
	id, calendarID string
}

// ref returns the API IDs of the object objPath in the calendar calendarID.
func (s *service) ref(objPath, calendarID string) objRef {
	return objRef{id: s.p.ids.encode(objPath), calendarID: calendarID}
}

// stableCalendarID returns the Calendar.StableID of the calendar calPath of
// the account identity (see service.identity): the same across restarts, so
// that the frontend can persist per-calendar settings under it. It is no
// API ID and never part of a URL.
func stableCalendarID(identity, calPath string) string {
	sum := sha256.Sum256([]byte(identity + "\x00" + calPath))
	return base64.RawURLEncoding.EncodeToString(sum[:])[:stableIDLength]
}

// decodeCalendarID returns the calendar collection path for id, normalized to
// end with "/". The path must be a direct child of home (which ends with "/").
func (c *idCodec) decodeCalendarID(home, id string) (string, error) {
	p, err := c.decodePath(home, id)
	if err != nil {
		return "", err
	}
	rest := strings.TrimSuffix(p[len(home):], "/")
	if !validSegment(rest) {
		return "", notFound("calendar")
	}
	return home + rest + "/", nil
}

// decodeObjectID returns the object path and its parent calendar path for id.
// The object must live directly inside a calendar below home.
func (c *idCodec) decodeObjectID(home, id string) (obj, cal string, err error) {
	p, err := c.decodePath(home, id)
	if err != nil {
		return "", "", err
	}
	calName, objName, ok := strings.Cut(p[len(home):], "/")
	if !ok || !validSegment(calName) || !validSegment(objName) {
		return "", "", notFound("object")
	}
	return p, home + calName + "/", nil
}

// decodePath returns the path id encrypts if it lies below home.
func (c *idCodec) decodePath(home, id string) (string, error) {
	p, ok := c.open(id)
	if !ok {
		return "", notFound("resource")
	}
	switch {
	case !utf8.ValidString(p),
		!strings.HasPrefix(p, "/"),
		strings.ContainsAny(p, "\x00\\?#"),
		!strings.HasPrefix(p, home),
		len(p) <= len(home):
		return "", notFound("resource")
	}
	clean := path.Clean(p)
	if strings.HasSuffix(p, "/") {
		clean += "/"
	}
	if clean != p {
		return "", notFound("resource")
	}
	return p, nil
}

func validSegment(s string) bool {
	return s != "" && s != "." && s != ".." && !strings.Contains(s, "/")
}

func notFound(what string) error {
	return fmt.Errorf("%w: invalid %s id", domain.ErrNotFound, what)
}

// objectPath joins a calendar collection path and a resource name.
func objectPath(cal, name string) string {
	return strings.TrimSuffix(cal, "/") + "/" + name
}
