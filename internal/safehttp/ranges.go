package safehttp

import "net/netip"

type blockedRange struct {
	prefix netip.Prefix
	reason string
}

// blockedV4 lists IPv4 ranges that are not publicly routable (IANA special
// purpose registry). A CalDAV proxy has no business connecting to them.
var blockedV4 = mustRanges(
	"0.0.0.0/8", "unspecified/this-network",
	"10.0.0.0/8", "private",
	"100.64.0.0/10", "carrier-grade NAT",
	"127.0.0.0/8", "loopback",
	"169.254.0.0/16", "link-local",
	"172.16.0.0/12", "private",
	"192.0.0.0/24", "IETF protocol assignment",
	"192.0.2.0/24", "documentation",
	"192.88.99.0/24", "6to4 relay anycast",
	"192.168.0.0/16", "private",
	"198.18.0.0/15", "benchmarking",
	"198.51.100.0/24", "documentation",
	"203.0.113.0/24", "documentation",
	"224.0.0.0/4", "multicast",
	"240.0.0.0/4", "reserved/broadcast",
)

// blockedV6 lists IPv6 ranges that are not publicly routable. IPv4-mapped
// (::ffff:0:0/96), NAT64 (64:ff9b::/96) and 6to4 (2002::/16) addresses are
// handled separately by checking the embedded IPv4 address.
var blockedV6 = mustRanges(
	"::/96", "unspecified/loopback/IPv4-compatible",
	"64:ff9b:1::/48", "local-use NAT64",
	"100::/64", "discard-only",
	"2001::/23", "IETF protocol assignment (incl. Teredo)",
	"2001:db8::/32", "documentation",
	"3fff::/20", "documentation",
	"5f00::/16", "SRv6 SIDs",
	"fc00::/7", "unique local",
	"fe80::/10", "link-local",
	"fec0::/10", "site-local",
	"ff00::/8", "multicast",
)

var (
	nat64     = netip.MustParsePrefix("64:ff9b::/96")
	sixToFour = netip.MustParsePrefix("2002::/16")
)

func mustRanges(pairs ...string) []blockedRange {
	out := make([]blockedRange, 0, len(pairs)/2)
	for i := 0; i+1 < len(pairs); i += 2 {
		out = append(out, blockedRange{netip.MustParsePrefix(pairs[i]), pairs[i+1]})
	}
	return out
}

// blockedReason returns why ip must not be contacted, or "" if it is a
// public unicast address.
func blockedReason(ip netip.Addr) string {
	if !ip.IsValid() {
		return "invalid"
	}
	// ::ffff:a.b.c.d is just a.b.c.d on a dual-stack socket.
	ip = ip.Unmap()
	if ip.Is4() {
		for _, r := range blockedV4 {
			if r.prefix.Contains(ip) {
				return r.reason
			}
		}
		return ""
	}
	// NAT64 and 6to4 route to an embedded IPv4 address: judge that one.
	if nat64.Contains(ip) {
		b := ip.As16()
		if reason := blockedReason(netip.AddrFrom4([4]byte(b[12:16]))); reason != "" {
			return "NAT64 of " + reason
		}
		return ""
	}
	if sixToFour.Contains(ip) {
		b := ip.As16()
		if reason := blockedReason(netip.AddrFrom4([4]byte(b[2:6]))); reason != "" {
			return "6to4 of " + reason
		}
		return ""
	}
	for _, r := range blockedV6 {
		if r.prefix.Contains(ip) {
			return r.reason
		}
	}
	return ""
}
