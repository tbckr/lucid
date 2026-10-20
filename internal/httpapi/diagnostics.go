package httpapi

import (
	"errors"
	"net/http"
	"net/url"
	"runtime"
	"time"

	"github.com/tbckr/lucid/internal/diag"
	"github.com/tbckr/lucid/internal/domain"
	"github.com/tbckr/lucid/internal/middleware"
	"github.com/tbckr/lucid/internal/session"
)

// withDiagnostics gives every API request that carries a live session the
// diagnostics scope of it: the session's buffer and the request's ID. What the
// CalDAV layer records for the request, the exchanges with the server and the
// problems it meets, lands in that buffer, and in the log lines of the request
// under its ID (FR-36). A request without a session, or with one that is gone,
// has no scope and records nothing.
//
// It is the innermost middleware, so the CSRF check, which resolves the session
// of an unsafe request first, has already seen an expired one. For the others
// the lookup here is the first: a session that has expired is removed by it, and
// no later lookup would report the expiry, so it logs the security event itself.
func (s *Server) withDiagnostics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if middleware.IsAPI(r) {
			if c, err := r.Cookie(CookieName); err == nil {
				buf, err := s.sessions.Diagnostics(c.Value)
				switch {
				case err == nil:
					scope := diag.Scope{Buffer: buf, RequestID: middleware.RequestID(r.Context())}
					r = r.WithContext(diag.WithScope(r.Context(), scope))
				case errors.Is(err, session.ErrExpired):
					s.sec.Log(r, middleware.EventSessionExpired)
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

// handleDiagnostics answers with the problem report of the caller's session
// (FR-36): metadata and skeletons only, from the session's buffer. Any session
// has one, an anonymous one too, which is how the report can be downloaded from
// the login screen or after a forced logout. It makes no call to the CalDAV
// server.
func (s *Server) handleDiagnostics(w http.ResponseWriter, r *http.Request) {
	sess, err := s.currentSession(r)
	scope, ok := diag.ScopeFrom(r.Context())
	if err != nil || !ok {
		middleware.WriteError(w, http.StatusUnauthorized, codeUnauthenticated, "not logged in")
		return
	}
	var acct *diag.AccountInfo
	if sess.Authenticated {
		a, ok := s.account(w, r)
		if !ok {
			return
		}
		info := accountInfo(a)
		acct = &info
	}
	mode := "server"
	if s.local {
		mode = "local"
	}
	lucid := diag.LucidInfo{Version: s.version, Mode: mode, OS: runtime.GOOS, Arch: runtime.GOARCH}
	middleware.WriteJSON(w, http.StatusOK, diag.BuildReport(scope.Buffer.Snapshot(), lucid, acct, sess.Authenticated, time.Now()))
}

// accountInfo is where the account's calendars live, for the report: the
// endpoint's origin and path, and the paths of the principal and the calendar
// home, each with the user name left out of the path (diag.RedactUser). Never
// credentials, query or fragment (NFR-36). A URL that does not parse is left
// out.
func accountInfo(acct domain.Account) diag.AccountInfo {
	return diag.AccountInfo{
		Endpoint:  redactedURL(acct.Username, acct.EndpointURL, true),
		Principal: redactedURL(acct.Username, acct.PrincipalURL, false),
		Home:      redactedURL(acct.Username, acct.CalendarHomeURL, false),
	}
}

// redactedURL returns the path of raw without the user name, with the scheme and
// host in front if withOrigin is set and raw has them.
func redactedURL(username, raw string, withOrigin bool) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	out := diag.RedactUser(username, u.EscapedPath())
	if withOrigin && u.Host != "" {
		out = u.Scheme + "://" + u.Host + out
	}
	return out
}

// objectSkeleton is the answer of handleObjectSkeleton.
type objectSkeleton struct {
	ID       string        `json:"id"`
	Skeleton diag.Skeleton `json:"skeleton"`
}

// objectContent is the answer of handleObjectContent.
type objectContent struct {
	ID      string `json:"id"`
	Content string `json:"content"`
}

// objectData fetches the data of the object named in the path from the CalDAV
// server for the caller's account. On failure it writes the response and
// returns false.
func (s *Server) objectData(w http.ResponseWriter, r *http.Request) (id string, data []byte, ok bool) {
	id, ok = pathID(w, r, "objectId")
	if !ok {
		return "", nil, false
	}
	svc, ok := s.service(w, r)
	if !ok {
		return "", nil, false
	}
	data, err := svc.ObjectData(r.Context(), id)
	if err != nil {
		s.fail(w, r, err)
		return "", nil, false
	}
	return id, data, true
}

// handleObjectSkeleton answers with the skeleton of a calendar object: its
// shape without its values (FR-36). The user looks at it before deciding
// whether to add the object's content to the report.
func (s *Server) handleObjectSkeleton(w http.ResponseWriter, r *http.Request) {
	id, data, ok := s.objectData(w, r)
	if !ok {
		return
	}
	middleware.WriteJSON(w, http.StatusOK, objectSkeleton{ID: id, Skeleton: diag.ICalSkeleton(data)})
}

// handleObjectContent answers with the data of a calendar object, as the CalDAV
// server sends them: the one place where Lucid returns contents for the report,
// to the session that owns the object, on the user's request for that object
// (FR-36). It never logs them (NFR-36).
func (s *Server) handleObjectContent(w http.ResponseWriter, r *http.Request) {
	id, data, ok := s.objectData(w, r)
	if !ok {
		return
	}
	middleware.WriteJSON(w, http.StatusOK, objectContent{ID: id, Content: string(data)})
}
