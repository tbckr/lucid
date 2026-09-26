package caldav

import (
	"encoding/base64"
	"fmt"
	"path"
	"strings"
	"unicode/utf8"

	"github.com/tbckr/lucid/internal/domain"
)

// IDs are the base64url (unpadded) encoding of the resource path on the
// server. They are opaque to clients but must be validated on decode so that
// a crafted ID can never address anything outside the account's calendar
// home.

func encodeID(p string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(p))
}

// decodeCalendarID returns the calendar collection path for id, normalized to
// end with "/". The path must be a direct child of home (which ends with "/").
func decodeCalendarID(home, id string) (string, error) {
	p, err := decodePath(home, id)
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
func decodeObjectID(home, id string) (obj, cal string, err error) {
	p, err := decodePath(home, id)
	if err != nil {
		return "", "", err
	}
	calName, objName, ok := strings.Cut(p[len(home):], "/")
	if !ok || !validSegment(calName) || !validSegment(objName) {
		return "", "", notFound("object")
	}
	return p, home + calName + "/", nil
}

func decodePath(home, id string) (string, error) {
	if id == "" || len(id) > 4096 {
		return "", notFound("resource")
	}
	b, err := base64.RawURLEncoding.DecodeString(id)
	if err != nil {
		return "", notFound("resource")
	}
	p := string(b)
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
