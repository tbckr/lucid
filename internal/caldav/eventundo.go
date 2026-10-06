package caldav

// This file implements the undo of a change to a recurring event series
// (FR-17): the snapshot a write hands out, and the restore that writes it
// back.

import (
	"context"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/domain"
)

// eventSnapshot returns the snapshot RestoreEvent undoes a change of the
// series eventID with: raw, the resource exactly as the change read it. The
// restore sends it with If-Match newETag, the series' ETag after the change,
// so a later change by anyone else is never overwritten. Without a known
// newETag there is none (nil): an undo could not tell its own change from
// another client's (FR-17).
func (s *service) eventSnapshot(eventID string, raw []byte, newETag string) *domain.Snapshot {
	if newETag == "" {
		return nil
	}
	return &domain.Snapshot{Kind: domain.SnapshotEvent, ID: eventID, ETag: newETag, Data: raw, Account: s.identity()}
}

// RestoreEvent implements domain.CalendarService. It writes the resource of
// snap back as it is, if it still has the ETag the change gave it, and then
// removes what the change created, see restoreResource (FR-17).
func (s *service) RestoreEvent(ctx context.Context, snap domain.Snapshot) (domain.EventRestore, error) {
	o, _, _, createdKept, err := s.restoreResource(ctx, snap, domain.SnapshotEvent, ical.CompEvent)
	if err != nil {
		return domain.EventRestore{}, err
	}
	return domain.EventRestore{ETag: o.etag, CopyKept: createdKept}, nil
}
