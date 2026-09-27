package caldav

import (
	"cmp"
	"context"
	"encoding/xml"
	"hash/fnv"
	"path"
	"slices"
	"strings"

	"github.com/emersion/go-ical"

	"github.com/tbckr/lucid/internal/domain"
)

var (
	propDisplayName   = xml.Name{Space: nsDAV, Local: "displayname"}
	propDescription   = xml.Name{Space: nsCalDAV, Local: "calendar-description"}
	propColor         = xml.Name{Space: nsApple, Local: "calendar-color"}
	propSupportedComp = xml.Name{Space: nsCalDAV, Local: "supported-calendar-component-set"}
)

// defaultPalette is used for calendars without a calendar-color.
var defaultPalette = []string{
	"#3b82f6", // blue
	"#22c55e", // green
	"#f97316", // orange
	"#a855f7", // purple
	"#ef4444", // red
	"#14b8a6", // teal
	"#eab308", // yellow
	"#ec4899", // pink
}

// ListCalendars implements domain.CalendarService.
func (s *service) ListCalendars(ctx context.Context) ([]domain.Calendar, error) {
	if s.err != nil {
		return nil, s.err
	}
	ms, _, err := s.t.propfind(ctx, s.home, "1", []xml.Name{
		propResourceType, propDisplayName, propDescription, propColor,
		propSupportedComp, propPrivilegeSet,
	}, false)
	if err != nil {
		return nil, mapError(err)
	}
	cals := []domain.Calendar{}
	for _, r := range ms.Responses {
		if len(r.Hrefs) == 0 {
			continue
		}
		u, err := resolveHref(s.home, r.Hrefs[0], false)
		if err != nil {
			continue
		}
		calPath := strings.TrimSuffix(u.Path, "/") + "/"
		if !strings.HasPrefix(calPath, s.homePath) || !validSegment(strings.TrimSuffix(calPath[len(s.homePath):], "/")) {
			continue // the home itself or something unexpected
		}
		pr := r.ok()
		if !pr.ResourceType.has(nsCalDAV, "calendar") {
			continue
		}
		c := domain.Calendar{
			ID:          encodeID(calPath),
			Name:        cmp.Or(str(pr.DisplayName), path.Base(calPath)),
			Description: str(pr.Description),
			Color:       normalizeColor(str(pr.Color)),
			ReadOnly:    !canWrite(pr.PrivilegeSet),
		}
		if c.Color == "" {
			c.Color = defaultColor(calPath)
		}
		c.SupportsEvents = supportsComp(pr.SupportedComponents, ical.CompEvent)
		c.SupportsTodos = supportsComp(pr.SupportedComponents, ical.CompToDo)
		if !c.SupportsEvents && !c.SupportsTodos {
			continue
		}
		cals = append(cals, c)
	}
	slices.SortStableFunc(cals, func(a, b domain.Calendar) int {
		return cmp.Or(
			cmp.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)),
			cmp.Compare(a.ID, b.ID),
		)
	})
	return cals, nil
}

// supportsComp reports whether a calendar with the supported component set cs
// accepts comp. A missing or empty set means all components (RFC 4791 5.2.3).
func supportsComp(cs *compSet, comp string) bool {
	if cs == nil || len(cs.Comps) == 0 {
		return true
	}
	return slices.ContainsFunc(cs.Comps, func(c compName) bool { return strings.EqualFold(c.Name, comp) })
}

// normalizeColor converts "#RGB", "#RRGGBB" and "#RRGGBBAA" to lower-case
// "#rrggbb". It returns "" for anything else.
func normalizeColor(c string) string {
	c = strings.ToLower(strings.TrimSpace(c))
	if !strings.HasPrefix(c, "#") {
		return ""
	}
	hex := c[1:]
	for _, r := range hex {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return ""
		}
	}
	switch len(hex) {
	case 3:
		return "#" + string([]byte{hex[0], hex[0], hex[1], hex[1], hex[2], hex[2]})
	case 6:
		return "#" + hex
	case 8:
		return "#" + hex[:6]
	}
	return ""
}

// defaultColor picks a deterministic palette color for a calendar path.
func defaultColor(calPath string) string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(calPath))
	return defaultPalette[int(h.Sum32()>>1)%len(defaultPalette)]
}
