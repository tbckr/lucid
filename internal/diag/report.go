package diag

import "time"

// ReportFormat is the version of the report's JSON layout. It changes when a
// field is removed or changes its meaning, not when one is added.
const ReportFormat = 1

// LucidInfo describes the binary that made the report.
type LucidInfo struct {
	Version string `json:"version"`
	Mode    string `json:"mode"`
	OS      string `json:"os"`
	Arch    string `json:"arch"`
}

// ServerInfo describes the CalDAV server as it introduced itself.
type ServerInfo struct {
	Host    string `json:"host"`
	Product string `json:"product"`
	DAV     string `json:"dav"`
}

// AccountInfo is where the account's calendars live. The caller redacts the
// user name from the paths (NFR-36).
type AccountInfo struct {
	Endpoint  string `json:"endpoint"`
	Principal string `json:"principal"`
	Home      string `json:"home"`
}

// Report is the problem report a user can download (FR-36). It holds metadata
// and skeletons only: contents are added to it by the user, one object at a
// time, outside this type.
type Report struct {
	Format        int            `json:"format"`
	CreatedAt     time.Time      `json:"createdAt"`
	Lucid         LucidInfo      `json:"lucid"`
	Authenticated bool           `json:"authenticated"`
	Server        ServerInfo     `json:"server"`
	Account       *AccountInfo   `json:"account,omitempty"`
	Calendars     []CalendarNote `json:"calendars"`
	Exchanges     []Exchange     `json:"exchanges"`
	Problems      []Problem      `json:"problems"`
}

// BuildReport assembles the report of a session from a snapshot of its Buffer.
// Server is taken from the newest exchange that has a Server header, Host and
// DAV from that exchange too. The report shares the snapshot's slices. Empty
// ones are empty, not nil, so they marshal as [].
func BuildReport(s Snapshot, lucid LucidInfo, acct *AccountInfo, authenticated bool, now time.Time) Report {
	r := Report{
		Format:        ReportFormat,
		CreatedAt:     now,
		Lucid:         lucid,
		Authenticated: authenticated,
		Account:       acct,
		Calendars:     s.Calendars,
		Exchanges:     s.Exchanges,
		Problems:      s.Problems,
	}
	if r.Calendars == nil {
		r.Calendars = []CalendarNote{}
	}
	if r.Exchanges == nil {
		r.Exchanges = []Exchange{}
	}
	if r.Problems == nil {
		r.Problems = []Problem{}
	}
	for i := len(s.Exchanges) - 1; i >= 0; i-- {
		if e := s.Exchanges[i]; e.Server != "" {
			r.Server = ServerInfo{Host: e.Host, Product: e.Server, DAV: e.DAV}
			break
		}
	}
	return r
}
