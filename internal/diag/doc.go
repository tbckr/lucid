// Package diag keeps calendar contents and credentials out of logs and out of
// the problem report (NFR-36, FR-36).
//
// CalDAV paths carry names a user chose: the calendar "therapy", an event
// UID, the account name. A Pseudonymizer replaces them with placeholders that
// are stable for one key, so two log lines about the same calendar can still
// be matched, while the name cannot be read back and, under another key, the
// placeholders do not line up. Reason cuts a parser error down to its fixed
// wording, because the parsers put the offending value into the message,
// quoted or not.
//
// Callers log a path only through a Pseudonymizer and a parser error only
// through Reason.
package diag
