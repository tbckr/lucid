package diag

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"
)

func exchangeAt(i int) Exchange {
	return Exchange{Path: fmt.Sprintf("p%d", i), Status: 200}
}

func exchangePaths(xs []Exchange) []string {
	out := make([]string, len(xs))
	for i := range xs {
		out[i] = xs[i].Path
	}
	return out
}

func problemPaths(ps []Problem) []string {
	out := make([]string, len(ps))
	for i := range ps {
		out[i] = ps[i].Path
	}
	return out
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestLimits(t *testing.T) {
	t.Parallel()
	if AnonymousLimits != (Limits{Exchanges: 30, Problems: 5}) {
		t.Errorf("AnonymousLimits = %+v, want {30 5}", AnonymousLimits)
	}
	if SessionLimits != (Limits{Exchanges: 100, Problems: 20}) {
		t.Errorf("SessionLimits = %+v, want {100 20}", SessionLimits)
	}
	if MaxCalendarNotes != 50 {
		t.Errorf("MaxCalendarNotes = %d, want 50", MaxCalendarNotes)
	}
	if MaxHeaderValue != 256 {
		t.Errorf("MaxHeaderValue = %d, want 256", MaxHeaderValue)
	}
}

func TestBufferRing(t *testing.T) {
	t.Parallel()
	b := NewBuffer(Limits{Exchanges: 3, Problems: 2})
	for i := range 5 {
		b.AddExchange(exchangeAt(i))
	}
	for i := range 3 {
		b.AddProblem(Problem{Path: fmt.Sprintf("q%d", i)})
	}

	snap := b.Snapshot()
	if got, want := exchangePaths(snap.Exchanges), []string{"p2", "p3", "p4"}; !equalStrings(got, want) {
		t.Errorf("exchanges = %v, want %v", got, want)
	}
	if got, want := problemPaths(snap.Problems), []string{"q1", "q2"}; !equalStrings(got, want) {
		t.Errorf("problems = %v, want %v", got, want)
	}
}

func TestBufferZeroLimitsKeepNothing(t *testing.T) {
	t.Parallel()
	for _, l := range []Limits{{}, {Exchanges: -1, Problems: -1}} {
		b := NewBuffer(l)
		b.AddExchange(exchangeAt(0))
		b.AddProblem(Problem{Path: "q"})
		snap := b.Snapshot()
		if len(snap.Exchanges) != 0 || len(snap.Problems) != 0 {
			t.Errorf("limits %+v kept %d exchanges, %d problems, want none", l, len(snap.Exchanges), len(snap.Problems))
		}
	}
}

func TestBufferSetLimits(t *testing.T) {
	t.Parallel()
	b := NewBuffer(Limits{Exchanges: 5, Problems: 5})
	for i := range 5 {
		b.AddExchange(exchangeAt(i))
		b.AddProblem(Problem{Path: fmt.Sprintf("q%d", i)})
	}

	b.SetLimits(Limits{Exchanges: 2, Problems: 1})
	snap := b.Snapshot()
	if got, want := exchangePaths(snap.Exchanges), []string{"p3", "p4"}; !equalStrings(got, want) {
		t.Errorf("after shrinking, exchanges = %v, want %v", got, want)
	}
	if got, want := problemPaths(snap.Problems), []string{"q4"}; !equalStrings(got, want) {
		t.Errorf("after shrinking, problems = %v, want %v", got, want)
	}

	b.SetLimits(Limits{Exchanges: 10, Problems: 10})
	snap = b.Snapshot()
	if len(snap.Exchanges) != 2 || len(snap.Problems) != 1 {
		t.Errorf("growing dropped entries: %d exchanges, %d problems, want 2 and 1", len(snap.Exchanges), len(snap.Problems))
	}
	for i := 5; i < 12; i++ {
		b.AddExchange(exchangeAt(i))
	}
	if got, want := len(b.Snapshot().Exchanges), 9; got != want {
		t.Errorf("after growing and 7 adds, %d exchanges, want %d", got, want)
	}
}

func TestBufferSnapshotIsACopy(t *testing.T) {
	t.Parallel()
	b := NewBuffer(Limits{Exchanges: 3, Problems: 3})
	b.AddExchange(exchangeAt(0))
	b.AddProblem(Problem{Path: "q0"})
	b.NoteCalendar("c", func(n *CalendarNote) { n.Events = true })

	snap := b.Snapshot()
	snap.Exchanges[0].Path = "changed"
	snap.Problems[0].Path = "changed"
	snap.Calendars[0].Events = false

	again := b.Snapshot()
	if again.Exchanges[0].Path != "p0" || again.Problems[0].Path != "q0" || !again.Calendars[0].Events {
		t.Errorf("editing a snapshot changed the buffer: %+v", again)
	}
}

func TestBufferWithoutObjects(t *testing.T) {
	t.Parallel()
	b := NewBuffer(SessionLimits)
	for i := range 40 {
		b.AddExchange(exchangeAt(i))
	}
	for i := range 8 {
		b.AddProblem(Problem{Path: fmt.Sprintf("q%d", i), ObjectID: fmt.Sprintf("obj%d", i), Reason: "r", Skeleton: Skeleton{Text: "s"}})
	}
	b.NoteCalendar("c", func(n *CalendarNote) { n.Events, n.Objects = true, 4 })

	c := b.WithoutObjects()

	got := c.Snapshot()
	for i, p := range got.Problems {
		if p.ObjectID != "" {
			t.Errorf("copy problem %d has ObjectID %q, want none", i, p.ObjectID)
		}
	}
	// The copy has the anonymous limits and keeps the newest entries.
	if len(got.Exchanges) != AnonymousLimits.Exchanges || got.Exchanges[0].Path != "p10" || got.Exchanges[29].Path != "p39" {
		t.Errorf("copy exchanges = %v, want the newest %d (p10..p39)", exchangePaths(got.Exchanges), AnonymousLimits.Exchanges)
	}
	if want := []string{"q3", "q4", "q5", "q6", "q7"}; !equalStrings(problemPaths(got.Problems), want) {
		t.Errorf("copy problems = %v, want %v", problemPaths(got.Problems), want)
	}
	if got.Problems[0].Reason != "r" || got.Problems[0].Skeleton.Text != "s" {
		t.Errorf("copy lost the pseudonymous part of a problem: %+v", got.Problems[0])
	}
	if len(got.Calendars) != 1 || got.Calendars[0] != (CalendarNote{Path: "c", Events: true, Objects: 4}) {
		t.Errorf("copy calendars = %+v, want the note of c", got.Calendars)
	}

	// The original is unchanged.
	orig := b.Snapshot()
	if len(orig.Exchanges) != 40 || len(orig.Problems) != 8 {
		t.Errorf("original has %d exchanges, %d problems, want 40 and 8", len(orig.Exchanges), len(orig.Problems))
	}
	for i, p := range orig.Problems {
		if want := fmt.Sprintf("obj%d", i); p.ObjectID != want {
			t.Errorf("original problem %d ObjectID = %q, want %q", i, p.ObjectID, want)
		}
	}

	// The two do not share storage in either direction.
	c.AddExchange(Exchange{Path: "only-copy"})
	c.AddProblem(Problem{Path: "only-copy"})
	c.NoteCalendar("c", func(n *CalendarNote) { n.Todos = true })
	c.NoteCalendar("copy-only", func(n *CalendarNote) { n.Todos = true })
	b.AddExchange(Exchange{Path: "only-original"})
	b.NoteCalendar("c", func(n *CalendarNote) { n.ReadOnly = true })

	orig = b.Snapshot()
	if len(orig.Exchanges) != 41 || orig.Exchanges[40].Path != "only-original" {
		t.Errorf("original exchanges changed through the copy: %v", exchangePaths(orig.Exchanges))
	}
	if len(orig.Problems) != 8 {
		t.Errorf("original has %d problems, want 8", len(orig.Problems))
	}
	if len(orig.Calendars) != 1 || orig.Calendars[0].Todos || !orig.Calendars[0].ReadOnly {
		t.Errorf("original calendars = %+v, shared with the copy", orig.Calendars)
	}
	got = c.Snapshot()
	if got.Exchanges[len(got.Exchanges)-1].Path != "only-copy" {
		t.Errorf("copy exchanges = %v, want only-copy last", exchangePaths(got.Exchanges))
	}
	if len(got.Calendars) != 2 || got.Calendars[0].ReadOnly || !got.Calendars[0].Todos {
		t.Errorf("copy calendars = %+v, shared with the original", got.Calendars)
	}
}

func TestBufferCalendarNotes(t *testing.T) {
	t.Parallel()
	b := NewBuffer(AnonymousLimits)
	b.NoteCalendar("{home}/cal-bbbbbbbb/", func(n *CalendarNote) { n.Events = true; n.CTag = true })
	b.NoteCalendar("{home}/cal-aaaaaaaa/", func(n *CalendarNote) { n.ReadOnly = true })
	b.NoteCalendar("{home}/cal-bbbbbbbb/", func(n *CalendarNote) { n.Todos = true; n.Objects = 7 })

	got := b.Snapshot().Calendars
	want := []CalendarNote{
		{Path: "{home}/cal-aaaaaaaa/", ReadOnly: true},
		{Path: "{home}/cal-bbbbbbbb/", Events: true, Todos: true, CTag: true, Objects: 7},
	}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Errorf("calendars = %+v, want %+v (merged, sorted by path)", got, want)
	}

	// The update sees the stored note and cannot rename it.
	b.NoteCalendar("{home}/cal-aaaaaaaa/", func(n *CalendarNote) {
		if n.Path != "{home}/cal-aaaaaaaa/" || !n.ReadOnly {
			t.Errorf("update got %+v, want the stored note", *n)
		}
		n.Path = "renamed"
	})
	if got := b.Snapshot().Calendars; got[0].Path != "{home}/cal-aaaaaaaa/" {
		t.Errorf("update renamed the note: %+v", got)
	}
}

func TestBufferCalendarNotesCap(t *testing.T) {
	t.Parallel()
	b := NewBuffer(AnonymousLimits)
	for i := range MaxCalendarNotes {
		b.NoteCalendar(fmt.Sprintf("c%03d", i), func(n *CalendarNote) { n.Events = true })
	}

	called := false
	b.NoteCalendar("c-extra", func(*CalendarNote) { called = true })
	if called {
		t.Error("update ran for the 51st path")
	}
	snap := b.Snapshot()
	if len(snap.Calendars) != MaxCalendarNotes {
		t.Fatalf("%d calendars, want %d", len(snap.Calendars), MaxCalendarNotes)
	}
	for _, n := range snap.Calendars {
		if n.Path == "c-extra" {
			t.Error("the 51st path was stored")
		}
	}

	// A path that is already known can still be updated at the cap.
	b.NoteCalendar("c007", func(n *CalendarNote) { n.Objects = 9 })
	for _, n := range b.Snapshot().Calendars {
		if n.Path == "c007" && n.Objects != 9 {
			t.Errorf("known path at the cap was not updated: %+v", n)
		}
	}

	// A nil update is ignored.
	b.NoteCalendar("c-nil", nil)
	if len(b.Snapshot().Calendars) != MaxCalendarNotes {
		t.Error("a nil update stored a note")
	}
}

func TestBufferFieldCaps(t *testing.T) {
	t.Parallel()
	long := strings.Repeat("x", 100<<10)
	even := strings.Repeat("é", 1000)      // runes start at even offsets: a cut at 256 is on a boundary
	odd := "a" + strings.Repeat("é", 1000) // runes start at odd offsets: a cut at 256 splits one

	b := NewBuffer(AnonymousLimits)
	b.AddExchange(Exchange{DAV: long, Server: long, ContentType: long, Path: long[:1000], Error: "e"})
	b.AddExchange(Exchange{DAV: even, Server: odd, ContentType: "text/xml; charset=utf-8"})
	got := b.Snapshot().Exchanges

	for name, v := range map[string]string{"DAV": got[0].DAV, "Server": got[0].Server, "ContentType": got[0].ContentType} {
		if len(v) != MaxHeaderValue || v != long[:MaxHeaderValue] {
			t.Errorf("%s of 100 KiB stored as %d bytes, want the first %d", name, len(v), MaxHeaderValue)
		}
	}
	if len(got[0].Path) != 1000 || got[0].Error != "e" {
		t.Errorf("fields that are not headers were cut: path %d bytes, error %q", len(got[0].Path), got[0].Error)
	}
	if v := got[1].DAV; len(v) != MaxHeaderValue || !utf8.ValidString(v) {
		t.Errorf("DAV cut on a boundary = %d bytes, valid UTF-8 %v, want %d bytes and valid", len(v), utf8.ValidString(v), MaxHeaderValue)
	}
	if v := got[1].Server; len(v) != MaxHeaderValue-1 || !utf8.ValidString(v) {
		t.Errorf("Server cut inside a rune = %d bytes, valid UTF-8 %v, want %d bytes and valid", len(v), utf8.ValidString(v), MaxHeaderValue-1)
	}
	if got[1].ContentType != "text/xml; charset=utf-8" {
		t.Errorf("short ContentType = %q, want it unchanged", got[1].ContentType)
	}

	// A header that is not UTF-8 at all is cut at the limit or, with no rune
	// start to back up to, to nothing.
	b = NewBuffer(AnonymousLimits)
	b.AddExchange(Exchange{Server: strings.Repeat("\x80", 1000)})
	if v := b.Snapshot().Exchanges[0].Server; len(v) > MaxHeaderValue {
		t.Errorf("Server of continuation bytes = %d bytes, want at most %d", len(v), MaxHeaderValue)
	}
}

func TestTrimDropsReferences(t *testing.T) {
	t.Parallel()
	s := []string{"a", "b", "c", "d"}
	got := trim(s, 2)
	if !equalStrings(got, []string{"c", "d"}) {
		t.Errorf("trim = %v, want [c d]", got)
	}
	// The slots behind the result are cleared, or the dropped values would stay
	// reachable through the backing array.
	if s[2] != "" || s[3] != "" {
		t.Errorf("backing array = %q, want the dropped slots cleared", s)
	}
	if got := trim(s[:2], 5); len(got) != 2 {
		t.Errorf("trim within the limit changed the length to %d", len(got))
	}
}

func TestBufferNil(t *testing.T) {
	t.Parallel()
	var b *Buffer
	b.AddExchange(exchangeAt(0))
	b.AddProblem(Problem{})
	b.NoteCalendar("c", func(*CalendarNote) { t.Error("update ran on a nil buffer") })
	b.SetLimits(SessionLimits)
	snap := b.Snapshot()
	if len(snap.Exchanges)+len(snap.Problems)+len(snap.Calendars) != 0 {
		t.Errorf("nil buffer snapshot = %+v, want empty", snap)
	}
	c := b.WithoutObjects()
	c.AddExchange(exchangeAt(0))
	if got := len(c.Snapshot().Exchanges); got != 1 {
		t.Errorf("copy of a nil buffer holds %d exchanges, want a working buffer with 1", got)
	}
}

func TestBufferConcurrent(t *testing.T) {
	t.Parallel()
	const (
		workers = 8
		rounds  = 200
	)
	b := NewBuffer(Limits{Exchanges: 50, Problems: 10})

	stop := make(chan struct{})
	var snapshots sync.WaitGroup
	snapshots.Go(func() {
		for {
			select {
			case <-stop:
				return
			default:
			}
			_ = b.WithoutObjects()
			snap := b.Snapshot()
			if len(snap.Exchanges) > 50 || len(snap.Problems) > 10 || len(snap.Calendars) > MaxCalendarNotes {
				t.Errorf("snapshot over the limits: %d exchanges, %d problems, %d calendars",
					len(snap.Exchanges), len(snap.Problems), len(snap.Calendars))
				return
			}
		}
	})

	var writers sync.WaitGroup
	for w := range workers {
		writers.Go(func() {
			for i := range rounds {
				b.AddExchange(Exchange{At: time.Unix(int64(i), 0), Path: fmt.Sprintf("w%d-%d", w, i)})
				b.AddProblem(Problem{Path: fmt.Sprintf("w%d-%d", w, i), ObjectID: "o"})
				b.NoteCalendar(fmt.Sprintf("c%d-%d", w, i%10), func(n *CalendarNote) { n.Objects++ })
			}
		})
	}
	writers.Wait()
	close(stop)
	snapshots.Wait()

	snap := b.Snapshot()
	if len(snap.Exchanges) != 50 || len(snap.Problems) != 10 {
		t.Errorf("after %d adds, %d exchanges and %d problems, want 50 and 10", workers*rounds, len(snap.Exchanges), len(snap.Problems))
	}
	// 80 distinct paths were noted, the cap lets 50 in.
	if len(snap.Calendars) != MaxCalendarNotes {
		t.Errorf("%d calendars, want %d", len(snap.Calendars), MaxCalendarNotes)
	}
}
