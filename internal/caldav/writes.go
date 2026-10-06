package caldav

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/domain"
)

// copyRemovalTimeout bounds the compensating DELETE of a completed copy,
// which runs on after the request that started it is cancelled (FR-17).
const copyRemovalTimeout = 10 * time.Second

// removeEntries deletes the entries in calPath a change created before its
// master was not written, a completed copy or the entries of other apps'
// completions, unless they changed since (FR-17). One whose ETag is unknown
// stays, logged: a delete could not tell it from one another client changed
// since, so it never weakens its precondition to If-Match: *. It runs on
// after the request is cancelled: a closed tab would leave the entries next
// to the occurrences they were made from.
func (s *service) removeEntries(ctx context.Context, calPath string, entries []calObject) {
	if len(entries) == 0 {
		return
	}
	defer s.invalidate(calPath)
	dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), copyRemovalTimeout)
	defer cancel()
	for _, o := range entries {
		// Paths and errors only, never task content.
		if o.etag == "" {
			s.p.log.WarnContext(ctx, "keeping the entry of a completed repeat whose etag is unknown", "path", o.path)
			continue
		}
		if err := s.deleteObject(dctx, o.path, o.etag); err != nil {
			s.p.log.WarnContext(ctx, "could not remove the entry of a completed repeat", "path", o.path, "error", err)
		}
	}
}

// errWriteUnverified marks the error of a master PUT that failed without the
// server's definite refusal and whose outcome could not be verified either,
// see settleWrite: the write may have been applied, so what the change
// wrote before it stays.
var errWriteUnverified = errors.New("the write could not be verified")

// settleWrite settles the failure err of the PUT of objPath with If-Match
// etag, the master write of a change that wrote other objects before it, a
// completed copy or the entries of other apps' completions (FR-17, A-01):
//   - the server refused it (see writeRefused): the write was not applied,
//     and err is returned, so that the caller removes what it wrote before;
//   - an ambiguous failure, and the master's ETag is no longer etag: the
//     write counts as applied all the same, as behind a reverse proxy whose
//     read timeout fired after the server committed. The change succeeded,
//     and nil is returned: the caller goes on with the new ETag unknown, as
//     after a write whose ETag cannot be read back. Another client's write
//     in the meantime looks the same; what the change wrote before then
//     stays as a duplicate the user can see;
//   - an ambiguous failure, and the ETag is still etag: not applied, err;
//   - an ambiguous failure, and the ETag cannot be read, or the server tells
//     none: err wrapped in errWriteUnverified, so that the caller keeps what
//     it wrote. A stray copy or entry is a duplicate the user can see and
//     delete; a completion deleted on doubt is a loss nobody sees.
//
// A change that wrote nothing before has nothing to decide on and returns
// its error as it is: a changed ETag can as well be another client's write
// while its own was lost. The verification runs on after the request is
// cancelled, like the compensation it decides on.
func (s *service) settleWrite(ctx context.Context, objPath, etag string, err error) error {
	if writeRefused(err) {
		return err
	}
	vctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), copyRemovalTimeout)
	defer cancel()
	current, verr := s.objectETag(vctx, objPath)
	switch {
	case verr != nil || current == "":
		// Paths and errors only, never task content.
		s.p.log.WarnContext(ctx, "keeping what a change wrote before a write that could not be verified",
			"path", objPath, "error", err, "verification_error", verr)
		return fmt.Errorf("%w: %w", err, errWriteUnverified)
	case current == etag:
		return err
	}
	return nil
}

// restoreResource writes the resource of snap back as it is, if it still has
// the ETag the change gave it (ErrConflict otherwise), and then removes the
// resources the change created, see removeCreated (FR-17). It does all of a
// restore except building the answer from the restored object o, whose main
// component is c, of kind comp (ical.CompToDo or ical.CompEvent). calPath is
// the path of its calendar, and createdKept reports that a resource the
// change created stays.
//
// kind is the kind of resource the caller restores. A snapshot of another
// kind, of another account or without an ETag is no snapshot of it
// (ErrNotFound), and nothing is written.
func (s *service) restoreResource(ctx context.Context, snap domain.Snapshot, kind domain.SnapshotKind, comp string) (o calObject, c *ical.Component, calPath string, createdKept bool, err error) {
	if s.err != nil {
		return calObject{}, nil, "", false, s.err
	}
	if snap.Kind != kind {
		return calObject{}, nil, "", false, fmt.Errorf("%w: snapshot of another kind", domain.ErrNotFound)
	}
	objPath, calPath, err := decodeObjectID(s.homePath, snap.ID)
	if err != nil {
		return calObject{}, nil, "", false, err
	}
	if snap.Account != s.identity() {
		return calObject{}, nil, "", false, fmt.Errorf("%w: snapshot of another account", domain.ErrNotFound)
	}
	// The services never hand out a snapshot without an ETag (an unknown one
	// yields none), but a caller-constructed one could; refuse it rather
	// than send a meaningless empty If-Match (review minor).
	if snap.ETag == "" {
		return calObject{}, nil, "", false, fmt.Errorf("%w: snapshot has no etag", domain.ErrNotFound)
	}
	if err := s.checkWritable(ctx, calPath, ""); err != nil {
		return calObject{}, nil, "", false, err
	}
	// Parsed before the write, so that nothing is written that could not be
	// reported; the change parsed the same data when it read it.
	cal, err := ical.NewDecoder(bytes.NewReader(snap.Data)).Decode()
	if err != nil {
		return calObject{}, nil, "", false, fmt.Errorf("%w: invalid iCalendar data: %w", domain.ErrUpstream, err)
	}
	c = mainComponent(cal, comp)
	if c == nil {
		return calObject{}, nil, "", false, fmt.Errorf("%w: %w", domain.ErrNotFound, errWrongComponent)
	}

	defer s.invalidate(calPath)
	o = calObject{path: objPath, cal: cal}
	if o.etag, err = s.putBytes(ctx, objPath, snap.Data, snap.ETag, false); err != nil {
		return calObject{}, nil, "", false, err
	}
	return o, c, calPath, s.removeCreated(ctx, snap.Created), nil
}

// removeCreated deletes the resources refs a change created, each unless it
// no longer has the ETag its ref gives, and reports whether any stays
// (FR-17). An unknown ETag keeps the resource: a delete could not tell one
// another client changed since from the one the change left, so it never
// weakens its precondition to If-Match: *. It runs on after the request is
// cancelled: the resource is restored, and a closed tab would leave what the
// change created next to it.
func (s *service) removeCreated(ctx context.Context, refs []domain.CreatedRef) (kept bool) {
	for _, ref := range refs {
		if !s.removeCreatedRef(ctx, ref) {
			kept = true
		}
	}
	return kept
}

// removeCreatedRef deletes the resource ref created, unless it no longer has
// the ETag of ref, and reports whether it is gone, see removeCreated.
func (s *service) removeCreatedRef(ctx context.Context, ref domain.CreatedRef) bool {
	objPath, _, err := decodeObjectID(s.homePath, ref.ID)
	switch {
	case err != nil:
	case ref.ETag == "":
		// Paths only, never calendar content.
		s.p.log.WarnContext(ctx, "keeping a resource a change created on undo: its etag is unknown", "path", objPath)
		return false
	default:
		dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), copyRemovalTimeout)
		defer cancel()
		err = s.deleteObject(dctx, objPath, ref.ETag)
	}
	if err == nil || errors.Is(err, domain.ErrNotFound) {
		return true
	}
	// Paths and errors only, never calendar content.
	s.p.log.WarnContext(ctx, "keeping a resource a change created on undo", "path", objPath, "error", err)
	return false
}
