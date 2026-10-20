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

func TestBufferHeaderCaps(t *testing.T) {
	t.Parallel()
	long := strings.Repeat("x", 100<<10)
	b := NewBuffer(AnonymousLimits)
	b.AddExchange(Exchange{DAV: long, Server: long, ContentType: long})
	b.AddExchange(Exchange{
		DAV:         strings.Repeat("é", 1000),       // runes start at even offsets: the cut at 256 is on one
		Server:      "a" + strings.Repeat("é", 1000), // runes start at odd offsets: the cut at 256 splits one
		ContentType: "text/xml; charset=utf-8",
	})
	b.AddExchange(Exchange{
		DAV:         strings.Repeat("a", MaxHeaderValue-2) + "😀", // the rune ends 2 bytes after the cap
		Server:      strings.Repeat("a", MaxHeaderValue-3) + "😀", // the rune ends 3 bytes after the cap
		ContentType: strings.Repeat("a", MaxHeaderValue-1) + "😀", // the rune ends 4 bytes after the cap
	})
	b.AddExchange(Exchange{Server: strings.Repeat("\x80", 1000)}) // no rune start anywhere
	got := b.Snapshot().Exchanges

	for name, v := range map[string]string{"DAV": got[0].DAV, "Server": got[0].Server, "ContentType": got[0].ContentType} {
		if v != long[:MaxHeaderValue] {
			t.Errorf("%s of 100 KiB stored as %d bytes, want the first %d", name, len(v), MaxHeaderValue)
		}
	}
	if got[1].DAV != strings.Repeat("é", MaxHeaderValue/2) {
		t.Errorf("DAV cut on a boundary = %d bytes, want %d bytes of whole runes", len(got[1].DAV), MaxHeaderValue)
	}
	if got[1].Server != "a"+strings.Repeat("é", MaxHeaderValue/2-1) {
		t.Errorf("Server cut inside a rune = %d bytes, want %d bytes without the split rune", len(got[1].Server), MaxHeaderValue-1)
	}
	if got[1].ContentType != "text/xml; charset=utf-8" {
		t.Errorf("short ContentType = %q, want it unchanged", got[1].ContentType)
	}
	for name, v := range map[string]string{"DAV": got[2].DAV, "Server": got[2].Server, "ContentType": got[2].ContentType} {
		if want := strings.Repeat("a", len(v)); v != want || !utf8.ValidString(v) {
			t.Errorf("%s with a 4-byte rune over the cap = %q, want only the a's before it", name, v)
		}
	}
	if len(got[2].DAV) != MaxHeaderValue-2 || len(got[2].Server) != MaxHeaderValue-3 || len(got[2].ContentType) != MaxHeaderValue-1 {
		t.Errorf("lengths with a 4-byte rune over the cap = %d, %d, %d, want %d, %d, %d",
			len(got[2].DAV), len(got[2].Server), len(got[2].ContentType), MaxHeaderValue-2, MaxHeaderValue-3, MaxHeaderValue-1)
	}
	// Bytes that are no UTF-8 are cut after at most 3 steps back, not to nothing.
	if want := strings.Repeat("\x80", MaxHeaderValue-3); got[3].Server != want {
		t.Errorf("Server of continuation bytes = %d bytes, want %d", len(got[3].Server), len(want))
	}
}

func TestBufferFieldCaps(t *testing.T) {
	t.Parallel()
	long := strings.Repeat("x", 100<<10)
	capped := strings.Repeat("x", MaxFieldValue)
	mid := strings.Repeat("y", 400) // over a header's cap, under a field's

	b := NewBuffer(AnonymousLimits)
	b.AddExchange(Exchange{RequestID: long, Method: long, Host: long, Path: long, Error: long})
	b.AddExchange(Exchange{RequestID: "r", Method: "PROPFIND", Host: "dav.example", Path: mid, Error: "e", Server: mid})
	b.AddProblem(Problem{RequestID: long, Path: long, ObjectID: long, Reason: long})
	b.AddProblem(Problem{RequestID: "r", Path: mid, ObjectID: mid, Reason: "x"})
	snap := b.Snapshot()

	if x := snap.Exchanges[0]; x.RequestID != capped || x.Method != capped || x.Host != capped || x.Path != capped || x.Error != capped {
		t.Errorf("exchange fields of 100 KiB = %d, %d, %d, %d, %d bytes, want %d each",
			len(x.RequestID), len(x.Method), len(x.Host), len(x.Path), len(x.Error), MaxFieldValue)
	}
	if x := snap.Exchanges[1]; x.RequestID != "r" || x.Method != "PROPFIND" || x.Host != "dav.example" || x.Path != mid || x.Error != "e" {
		t.Errorf("short exchange fields were changed: %+v", x)
	} else if x.Server != mid[:MaxHeaderValue] {
		t.Errorf("Server of 400 bytes = %d bytes, want the header cap %d", len(x.Server), MaxHeaderValue)
	}
	if p := snap.Problems[0]; p.RequestID != capped || p.Path != capped || p.ObjectID != capped || p.Reason != capped {
		t.Errorf("problem fields of 100 KiB = %d, %d, %d, %d bytes, want %d each",
			len(p.RequestID), len(p.Path), len(p.ObjectID), len(p.Reason), MaxFieldValue)
	}
	if p := snap.Problems[1]; p.RequestID != "r" || p.Path != mid || p.ObjectID != mid || p.Reason != "x" {
		t.Errorf("short problem fields were changed: %+v", p)
	}

	// The cap does not split a rune of a field either.
	b.AddExchange(Exchange{Path: "a" + strings.Repeat("é", 400)})
	if got := b.Snapshot().Exchanges[2].Path; got != "a"+strings.Repeat("é", MaxFieldValue/2-1) {
		t.Errorf("Path cut inside a rune = %d bytes, want %d without the split rune", len(got), MaxFieldValue-1)
	}
}

func TestBufferCalendarPathCap(t *testing.T) {
	t.Parallel()
	capped := strings.Repeat("c", MaxFieldValue)
	b := NewBuffer(AnonymousLimits)
	// Two paths that differ only beyond the cap are one calendar, noted under
	// the cut path, and the update sees that path.
	b.NoteCalendar(capped+"1", func(n *CalendarNote) {
		if n.Path != capped {
			t.Errorf("update got Path of %d bytes, want the cut path of %d", len(n.Path), MaxFieldValue)
		}
		n.Events = true
	})
	b.NoteCalendar(capped+"2", func(n *CalendarNote) { n.Todos = true })

	got := b.Snapshot().Calendars
	if len(got) != 1 || got[0] != (CalendarNote{Path: capped, Events: true, Todos: true}) {
		t.Errorf("calendars = %+v, want one note of the cut path with both flags", got)
	}
}

func TestBufferSkeletonCap(t *testing.T) {
	t.Parallel()
	lines := strings.Repeat("xxxxxxxxx\n", 500) // 10-byte lines, 5000 bytes, the last ends in a line break
	tests := []struct {
		name          string
		in            Skeleton
		want          string
		wantTruncated bool
	}{
		{"within the cap", Skeleton{Text: "a\nb"}, "a\nb", false},
		{"at the cap", Skeleton{Text: strings.Repeat("x", MaxSkeleton)}, strings.Repeat("x", MaxSkeleton), false},
		{"truncated flag stays", Skeleton{Text: "a", Truncated: true}, "a", true},
		// Line breaks are at 9, 19, ...: the last one in the first 4097 bytes is at 4089.
		{"cut on a line", Skeleton{Text: lines}, lines[:4089], true},
		{"line break right after the cap", Skeleton{Text: strings.Repeat("x", MaxSkeleton) + "\nmore"}, strings.Repeat("x", MaxSkeleton), true},
		{"one long line", Skeleton{Text: strings.Repeat("x", 10000)}, strings.Repeat("x", MaxSkeleton), true},
		{"line break first", Skeleton{Text: "\n" + strings.Repeat("x", 10000)}, "\n" + strings.Repeat("x", MaxSkeleton-1), true},
		{"not inside a rune", Skeleton{Text: "a" + strings.Repeat("é", 3000)}, "a" + strings.Repeat("é", MaxSkeleton/2-1), true},
		{"long and already truncated", Skeleton{Text: lines, Truncated: true}, lines[:4089], true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			b := NewBuffer(AnonymousLimits)
			b.AddProblem(Problem{Skeleton: tt.in})
			got := b.Snapshot().Problems[0].Skeleton
			if got.Text != tt.want || got.Truncated != tt.wantTruncated {
				t.Errorf("skeleton = %d bytes, truncated %v, want %d bytes, truncated %v",
					len(got.Text), got.Truncated, len(tt.want), tt.wantTruncated)
			}
		})
	}
}

func TestBufferKeepsTimesInUTC(t *testing.T) {
	t.Parallel()
	zone := time.FixedZone("CEST", 2*60*60)
	at := time.Date(2026, 10, 20, 14, 0, 0, 0, zone)
	b := NewBuffer(AnonymousLimits)
	b.AddExchange(Exchange{At: at})
	b.AddProblem(Problem{At: at})
	snap := b.Snapshot()
	for name, got := range map[string]time.Time{"exchange": snap.Exchanges[0].At, "problem": snap.Problems[0].At} {
		if !got.Equal(at) || got.Location() != time.UTC {
			t.Errorf("%s At = %v, want the same instant in UTC", name, got)
		}
	}
}

func TestCap(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		in    string
		limit int
		want  string
	}{
		{"within", "abc", 3, "abc"},
		{"ascii", "abcd", 3, "abc"},
		{"on a boundary", "éé", 2, "é"},
		{"inside a 2-byte rune", "aé", 2, "a"},
		{"inside a 3-byte rune", "a€", 3, "a"},
		{"inside a 4-byte rune", "a😀", 4, "a"},
		{"inside a 4-byte rune at its first continuation", "a😀", 2, "a"},
		{"only continuation bytes", "\x80\x80\x80\x80\x80\x80", 5, "\x80\x80"},
		{"limit one", "\x80\x80\x80", 1, ""},
		{"limit zero", "abc", 0, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			if got := Cap(tt.in, tt.limit); got != tt.want {
				t.Errorf("Cap(%q, %d) = %q, want %q", tt.in, tt.limit, got, tt.want)
			}
		})
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

func TestBufferProblemDedupe(t *testing.T) {
	t.Parallel()
	at := func(h int) time.Time { return time.Date(2026, 10, 20, h, 0, 0, 0, time.UTC) }
	base := Problem{At: at(1), RequestID: "req-1", Kind: ProblemInvalidObject, Path: "p", ObjectID: "o", Reason: "r", Skeleton: Skeleton{Text: "s"}}

	t.Run("a repeat is not new and takes the place of the newest", func(t *testing.T) {
		t.Parallel()
		b := NewBuffer(Limits{Problems: 3})
		if !b.AddProblem(base) {
			t.Error("AddProblem of a new problem = false, want true")
		}
		other := base
		other.Path = "other"
		b.AddProblem(other)

		again := base
		again.At, again.RequestID = at(2), "req-2"
		if b.AddProblem(again) {
			t.Error("AddProblem of a repeat = true, want false")
		}

		got := b.Snapshot().Problems
		if len(got) != 2 || got[0].Path != "other" || got[1].Path != "p" {
			t.Fatalf("problems = %+v, want other, then the repeat as the newest", got)
		}
		if !got[1].At.Equal(at(2)) || got[1].RequestID != "req-2" {
			t.Errorf("repeat = %+v, want the new time and request ID", got[1])
		}
	})
	t.Run("a repeat pushes nothing out", func(t *testing.T) {
		t.Parallel()
		b := NewBuffer(Limits{Problems: 2})
		for _, path := range []string{"a", "b"} {
			p := base
			p.Path = path
			b.AddProblem(p)
		}
		a := base
		a.Path = "a"
		b.AddProblem(a)
		if got, want := problemPaths(b.Snapshot().Problems), []string{"b", "a"}; !equalStrings(got, want) {
			t.Errorf("problems = %v, want %v", got, want)
		}
	})
	t.Run("kind, path, reason and skeleton tell problems apart", func(t *testing.T) {
		t.Parallel()
		b := NewBuffer(Limits{Problems: 10})
		b.AddProblem(base)
		for name, edit := range map[string]func(*Problem){
			"kind":     func(p *Problem) { p.Kind = ProblemUnparsableObject },
			"path":     func(p *Problem) { p.Path = "q" },
			"reason":   func(p *Problem) { p.Reason = "other" },
			"skeleton": func(p *Problem) { p.Skeleton.Text = "t" },
		} {
			p := base
			edit(&p)
			if !b.AddProblem(p) {
				t.Errorf("a problem with another %s = repeat, want new", name)
			}
		}
		if got := len(b.Snapshot().Problems); got != 5 {
			t.Errorf("problems = %d, want 5", got)
		}
	})
	t.Run("the object and the time are no part of the identity", func(t *testing.T) {
		t.Parallel()
		b := NewBuffer(Limits{Problems: 10})
		b.AddProblem(base)
		p := base
		p.ObjectID, p.At, p.RequestID = "o2", at(5), "req-9"
		if b.AddProblem(p) {
			t.Error("AddProblem with another object ID, time and request = new, want repeat")
		}
	})
	t.Run("the cut values count", func(t *testing.T) {
		t.Parallel()
		b := NewBuffer(Limits{Problems: 10})
		prefix := strings.Repeat("x", MaxFieldValue)
		b.AddProblem(Problem{Path: prefix + "a"})
		if b.AddProblem(Problem{Path: prefix + "b"}) {
			t.Error("two paths equal after the cut = new, want repeat")
		}
		lines := strings.Repeat("xxxxxxxxx\n", 500)
		b.AddProblem(Problem{Skeleton: Skeleton{Text: lines}})
		if b.AddProblem(Problem{Skeleton: Skeleton{Text: lines + "more"}}) {
			t.Error("two skeletons equal after the cut = new, want repeat")
		}
	})
	t.Run("nothing is kept, everything is new", func(t *testing.T) {
		t.Parallel()
		b := NewBuffer(Limits{})
		first, second := b.AddProblem(base), b.AddProblem(base)
		if !first || !second {
			t.Errorf("AddProblem twice on a buffer that keeps nothing = %v, %v, want new both times", first, second)
		}
		var nilBuffer *Buffer
		if !nilBuffer.AddProblem(base) {
			t.Error("AddProblem on a nil buffer = repeat, want new")
		}
	})
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
			// Both read the elements, not just the lengths, so a copy that
			// shared storage with the buffer would be a data race.
			for _, snap := range []Snapshot{b.Snapshot(), b.WithoutObjects().Snapshot()} {
				if len(snap.Exchanges) > 50 || len(snap.Problems) > 10 || len(snap.Calendars) > MaxCalendarNotes {
					t.Errorf("snapshot over the limits: %d exchanges, %d problems, %d calendars",
						len(snap.Exchanges), len(snap.Problems), len(snap.Calendars))
					return
				}
				var seen int
				for i := range snap.Exchanges {
					seen += len(snap.Exchanges[i].Path)
				}
				for i := range snap.Problems {
					seen += len(snap.Problems[i].Path) + len(snap.Problems[i].ObjectID)
				}
				for i := range snap.Calendars {
					seen += snap.Calendars[i].Objects
				}
				_ = seen
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
