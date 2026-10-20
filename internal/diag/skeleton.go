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
// stays a prefix of the document's shape. It is the one place that knows what
// the cap counts: the bytes of the text, line breaks included.
type capped struct {
	front     []byte // lines that go in front of the others, each ended by "\n"
	buf       []byte // the other lines, each ended by "\n"
	truncated bool
}

// add appends line, and with it the lines in front that it needs: the
// namespace header of an XML skeleton lists the namespaces of the lines kept,
// so a line brings its own. It does so if the text, with all of it, stays
// within MaxSkeleton, and reports whether it did. After a line that did not
// fit, nothing fits any more.
func (c *capped) add(line string, front ...string) bool {
	if c.truncated {
		return false
	}
	// Every line counts with its line break, the last one's is cut off again.
	size := len(c.front) + len(c.buf) + len(line) + 1
	for _, f := range front {
		size += len(f) + 1
	}
	if size > MaxSkeleton+1 {
		c.truncated = true
		return false
	}
	for _, f := range front {
		c.front = append(append(c.front, f...), '\n')
	}
	c.buf = append(append(c.buf, line...), '\n')
	return true
}

func (c *capped) skeleton() Skeleton {
	text := strings.TrimSuffix(string(c.front)+string(c.buf), "\n")
	return Skeleton{Text: text, Truncated: c.truncated}
}

// isToken reports whether s is made as a name of RFC 5545 is: letters, digits
// and hyphens, at least one. A line whose name is not even that, "Bob Smith: x",
// is no content line.
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
