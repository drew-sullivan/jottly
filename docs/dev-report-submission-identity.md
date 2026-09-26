# Developer report retry identity

New submissions retain a versioned SHA-256 fingerprint of the normalized original
kind, title, description, diagnostic text, app version and build. Display titles,
status and resolution remain editable. Retries never rewrite those fields or
restore diagnostic text after closure. A changed original field returns 409.
The digest stays private and is never projected through the report API.

Migration is additive and retries actual database failures. Existing rows have a
null fingerprint because the original title may already have been edited and a
closed report's diagnostics may already have been erased. Those rows compare all
remaining immutable fields and compare diagnostics while still open. Their
unrecoverable original title and erased diagnostic text cannot be authenticated;
we neither fabricate them from the current title nor bind history to the first
retry. The legacy retry path never changes the stored ticket. New submissions
always receive the stronger full-input fingerprint, including title and logs.

Production health retains response schemaVersion 2 for compatible app clients
and adds submissionIdentityVersion 1. Health reads the fingerprint column, so the
capability cannot report success before its actual database migration succeeds.

Verification uses the real router with SQLite: lost acknowledgements, repeated
retries through every work state, renamed closed tickets, changed-field conflicts,
concurrent insert races, normalization, older rows, failed migrations and concurrent
migration workers. Live verification is a read-only health request; it creates no
reports and changes no developer queue status.
