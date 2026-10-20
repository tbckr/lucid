package diag

import "strings"

// MaxSkeleton caps the text of a Skeleton at this many bytes.
const MaxSkeleton = 4 << 10

// mask stands for every value a skeleton does not show.
const mask = "…"

// Skeleton is the content-free shape of a document Lucid could not read: its
// structure, names and formats, never its values (NFR-36). It is what gets
// logged and put into the problem report instead of the document (FR-36).
type Skeleton struct {
	// Text is the shape, one line per content line or element, lines joined by
	// "\n", at most MaxSkeleton bytes. The cut is on a line boundary.
	Text string `json:"text"`
	// Truncated reports that lines were left out to stay within MaxSkeleton.
	Truncated bool `json:"truncated,omitempty"`
}

// capped collects the lines of a skeleton up to MaxSkeleton bytes. The first
// line that does not fit ends it: the lines after it are not tried, so the text
// stays a prefix of the document's shape.
type capped struct {
	buf       []byte
	truncated bool
}

// add appends line, preceded by a line break unless it is the first, and
// reports whether it fitted. After a line has not, nothing fits any more.
func (c *capped) add(line string) bool {
	if c.truncated {
		return false
	}
	need := len(line)
	if len(c.buf) > 0 {
		need++
	}
	if len(c.buf)+need > MaxSkeleton {
		c.truncated = true
		return false
	}
	if len(c.buf) > 0 {
		c.buf = append(c.buf, '\n')
	}
	c.buf = append(c.buf, line...)
	return true
}

func (c *capped) skeleton() Skeleton {
	return Skeleton{Text: string(c.buf), Truncated: c.truncated}
}

// isToken reports whether s is a name as RFC 5545 has them: letters, digits and
// hyphens, at least one. It is what a component, property or parameter name
// looks like, and what a name that is really text does not.
func isToken(s string) bool {
	if s == "" {
		return false
	}
	for i := range len(s) {
		c := s[i]
		if (c < 'A' || c > 'Z') && (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' {
			return false
		}
	}
	return true
}

// oneLine keeps a string that is shown as it is from breaking the line
// structure of a skeleton: control characters become "?".
func oneLine(s string) string {
	clean := true
	for i := range len(s) {
		if s[i] < ' ' || s[i] == 0x7f {
			clean = false
			break
		}
	}
	if clean {
		return s
	}
	return strings.Map(func(r rune) rune {
		if r < ' ' || r == 0x7f {
			return '?'
		}
		return r
	}, s)
}
