package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"

	"github.com/tbckr/lucid/internal/domain"
	"github.com/tbckr/lucid/internal/middleware"
)

// Error codes of docs/API.md.
const (
	codeInvalidInput           = middleware.CodeInvalidInput
	codeForbiddenTarget        = "forbidden_target"
	codeUnauthenticated        = "unauthenticated"
	codeInvalidCredentials     = "invalid_credentials" //nolint:gosec // G101: an error code, not a credential
	codeReadOnly               = "read_only"
	codeUnsupportedComponent   = "unsupported_component"
	codeSeriesMoveUnsupported  = "series_move_unsupported"
	codeSeriesSplitUnsupported = "series_split_unsupported"
	codeNotFound               = "not_found"
	codeConflict               = "conflict"
	codeDiscoveryFailed        = "discovery_failed"
	codePreconditionRequired   = "precondition_required"
	codeUpstreamError          = "upstream_error"
	codeInternal               = middleware.CodeInternal
)

// errBodyTooLarge marks request bodies above middleware.MaxBodyBytes.
var errBodyTooLarge = errors.New("request body too large")

// writeError maps an error from the domain layer to the API error shape.
// Details of upstream and internal errors are logged, not returned.
func (s *Server) writeError(w http.ResponseWriter, r *http.Request, err error) {
	var verr *domain.ValidationError
	switch {
	case errors.As(err, &verr):
		middleware.WriteError(w, http.StatusBadRequest, codeInvalidInput, verr.Msg)
	case errors.Is(err, errBodyTooLarge):
		middleware.WriteError(w, http.StatusRequestEntityTooLarge, codeInvalidInput, "request body too large")
	case errors.Is(err, domain.ErrInvalidInput):
		middleware.WriteError(w, http.StatusBadRequest, codeInvalidInput, "invalid input")
	case errors.Is(err, domain.ErrSeriesMoveUnsupported):
		middleware.WriteError(w, http.StatusBadRequest, codeSeriesMoveUnsupported,
			"this series can't move like this, only this event can")
	case errors.Is(err, domain.ErrSeriesSplitUnsupported):
		middleware.WriteError(w, http.StatusBadRequest, codeSeriesSplitUnsupported,
			"this series can't be split, only this event or all events can change")
	case errors.Is(err, domain.ErrForbiddenTarget):
		s.sec.Log(r, middleware.EventSSRFBlocked, slog.String("error", err.Error()))
		middleware.WriteError(w, http.StatusBadRequest, codeForbiddenTarget,
			"the server address points to a blocked (internal) network")
	case errors.Is(err, domain.ErrUnauthorized):
		middleware.WriteError(w, http.StatusUnauthorized, codeUnauthenticated, "not logged in")
	case errors.Is(err, domain.ErrReadOnly):
		middleware.WriteError(w, http.StatusForbidden, codeReadOnly, "calendar is read-only")
	case errors.Is(err, domain.ErrUnsupportedComponent):
		middleware.WriteError(w, http.StatusUnprocessableEntity, codeUnsupportedComponent,
			"the calendar does not accept this type of item")
	case errors.Is(err, domain.ErrNotFound):
		middleware.WriteError(w, http.StatusNotFound, codeNotFound, "not found")
	case errors.Is(err, domain.ErrConflict):
		middleware.WriteError(w, http.StatusConflict, codeConflict, "the item was changed elsewhere, reload and retry")
	case errors.Is(err, domain.ErrDiscovery):
		middleware.WriteError(w, http.StatusUnprocessableEntity, codeDiscoveryFailed, "no CalDAV service found at this address")
	case errors.Is(err, domain.ErrUpstream), errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		s.logger.LogAttrs(r.Context(), slog.LevelWarn, "upstream error",
			slog.String("request_id", middleware.RequestID(r.Context())), slog.String("error", err.Error()))
		middleware.WriteError(w, http.StatusBadGateway, codeUpstreamError, "the CalDAV server failed or is unreachable")
	default:
		s.logger.LogAttrs(r.Context(), slog.LevelError, "internal error",
			slog.String("request_id", middleware.RequestID(r.Context())), slog.String("error", err.Error()))
		middleware.WriteError(w, http.StatusInternalServerError, codeInternal, "internal server error")
	}
}

// decodeJSON strictly decodes a single JSON value from the request body.
func decodeJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return errBodyTooLarge
		}
		return &domain.ValidationError{Msg: fmt.Sprintf("invalid JSON body: %v", err)}
	}
	if err := dec.Decode(new(json.RawMessage)); !errors.Is(err, io.EOF) {
		return &domain.ValidationError{Msg: "invalid JSON body: unexpected data after value"}
	}
	return nil
}
