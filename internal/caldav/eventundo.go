package caldav

// This file implements the undo of a change to a recurring event series
// (FR-17): the snapshot a write hands out, and the restore that writes it
// back.

import (
	"context"
	"slices"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/domain"
)

// eventSnapshot returns the snapshot RestoreEvent undoes a change of the
// series eventID with: raw, the resource exactly as the change read it. The
// restore sends it with If-Match newETag, the series' ETag after the change,
// so a later change by anyone else is never overwritten. Without a known
// newETag there is none (nil): an undo could not tell its own change from
// another client's. There is none either if the resource has attendees: the
// server may have sent them the change with the SEQUENCE it carries, and a
// restore would write an older one back (RFC 5545 section 3.8.7.4). attendees
// is hasAttendees of the calendar as the change read it (FR-17).
func (s *service) eventSnapshot(eventID string, raw []byte, newETag string, attendees bool) *domain.Snapshot {
	if newETag == "" || attendees {
		return nil
	}
	return &domain.Snapshot{Kind: domain.SnapshotEvent, ID: eventID, ETag: newETag, Data: raw, Account: s.identity()}
}

// hasAttendees reports whether any event of cal, the series or one of its
// overrides, has an ORGANIZER or an ATTENDEE, that is, whether a server that
// schedules implicitly may have told others of a change (FR-17).
func hasAttendees(cal *ical.Calendar) bool {
	return slices.ContainsFunc(cal.Children, func(c *ical.Component) bool {
		return c.Name == ical.CompEvent &&
			(c.Props.Get(ical.PropOrganizer) != nil || c.Props.Get(ical.PropAttendee) != nil)
	})
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
