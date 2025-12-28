package transport

import (
	"fmt"
	"net"
	"net/http"
	"strings"
)

// SafeTransport wraps http.RoundTripper and prevents SSRF attacks
type SafeTransport struct {
	rt http.RoundTripper
}

// NewSafeTransport creates a new SSRF-safe transport
func NewSafeTransport() *SafeTransport {
	return &SafeTransport{
		rt: &http.Transport{
			MaxIdleConns:        100,
			MaxIdleConnsPerHost: 100,
			IdleConnTimeout:     90,
		},
	}
}

// RoundTrip implements http.RoundTripper and validates URLs
func (st *SafeTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	// Validate the request URL
	if err := st.validateURL(req.URL.Host); err != nil {
		return nil, err
	}
	
	return st.rt.RoundTrip(req)
}

// validateURL checks if the URL is safe from SSRF attacks
func (st *SafeTransport) validateURL(host string) error {
	// Parse the host (remove port if present)
	hostname, _, err := net.SplitHostPort(host)
	if err != nil {
		// If no port, use the whole host
		hostname = host
	}
	
	// Check if it's an IP address
	ip := net.ParseIP(hostname)
	if ip != nil {
		return st.validateIP(ip)
	}
	
	// For hostnames, resolve and check the IPs
	ips, err := net.LookupIP(hostname)
	if err != nil {
		return fmt.Errorf("failed to resolve host %s: %w", hostname, err)
	}
	
	for _, resolvedIP := range ips {
		if err := st.validateIP(resolvedIP); err != nil {
			return err
		}
	}
	
	return nil
}

// validateIP checks if an IP is in a private or reserved range
func (st *SafeTransport) validateIP(ip net.IP) error {
	// Reject localhost
	if ip.IsLoopback() {
		return fmt.Errorf("loopback addresses are not allowed: %s", ip.String())
	}
	
	// Reject private IPs (RFC 1918)
	if ip.IsPrivate() {
		return fmt.Errorf("private IP addresses are not allowed: %s", ip.String())
	}
	
	// Reject link-local addresses (169.254.0.0/16)
	if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return fmt.Errorf("link-local addresses are not allowed: %s", ip.String())
	}
	
	// Reject multicast addresses
	if ip.IsMulticast() {
		return fmt.Errorf("multicast addresses are not allowed: %s", ip.String())
	}
	
	// Reject unspecified address (0.0.0.0 or ::)
	if ip.IsUnspecified() {
		return fmt.Errorf("unspecified addresses are not allowed: %s", ip.String())
	}
	
	return nil
}

// BlockedHostList maintains a list of blocked hostnames (optional additional security)
type BlockedHostList struct {
	blockedHosts map[string]bool
}

// NewBlockedHostList creates a new list
func NewBlockedHostList(hosts ...string) *BlockedHostList {
	list := make(map[string]bool)
	for _, host := range hosts {
		list[strings.ToLower(host)] = true
	}
	return &BlockedHostList{
		blockedHosts: list,
	}
}

// IsBlocked checks if a hostname is blocked
func (bhl *BlockedHostList) IsBlocked(host string) bool {
	return bhl.blockedHosts[strings.ToLower(host)]
}
