// Package diag keeps calendar contents and credentials out of logs and out of
// the problem report (NFR-36, FR-36).
//
// CalDAV paths carry names a user chose: the calendar "therapy", an event
// UID, the account name. A Pseudonymizer replaces them with placeholders that
// are stable for one key, so two log lines about the same calendar can still
// be matched, while the name cannot be read back and, under another key, the
// placeholders do not line up. Reason shortens a parser error to its fixed
// text, because the parsers quote the offending value in the message.
//
// Everything that logs a path or a parser error goes through this package.
package diag
