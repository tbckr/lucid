package caldav

import (
	"context"
	"net/http"
)

// ObjectData implements domain.CalendarService. It asks the server for the
// object again, with no cache in between, and returns the body as it came: an
// object that does not parse is no error here, as it is the one the user wants to
// see the content of after a problem was recorded for it (FR-36). The data go to
// the caller only, never into a log line or a buffer (NFR-36), and an ID that is
// not an object of this account's calendar home is not asked for (NFR-24).
func (s *service) ObjectData(ctx context.Context, objectID string) ([]byte, error) {
	if s.err != nil {
		return nil, s.err
	}
	objPath, _, err := s.p.ids.decodeObjectID(s.homePath, objectID)
	if err != nil {
		return nil, err
	}
	resp, err := s.t.do(ctx, request{method: http.MethodGet, url: s.urlFor(objPath)})
	if err != nil {
		return nil, mapError(err)
	}
	return resp.body, nil
}
