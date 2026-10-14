# Changelog

## 0.1.1 — 2026-10-14

Found by `test-skill/SSP-2716-summary-run1.md`: a wrong `JIRA_EMAIL` took several rounds to find, because Jira answers 401 the same way for a wrong email, a wrong token and a token used on the wrong URL.

- The 401 hint now tells the user to check that `JIRA_EMAIL` is the email of the account that created the token, and that the token was copied without spaces or quotes.
- The 401 hint now fits the URL type in use. Site URL: a classic token works, a token created with scopes needs the gateway URL. Gateway URL: only a token created with scopes works, and the cloudId must be for the site.
- `check` shows the token length (never the value) and warns if the email or token contains whitespace or quotes, or if the email does not look like an email address. The warnings never quote the values.

## 0.1.0 — 2026-10-14

First version.

**Read-only guarantees**

- `scripts/jira.mjs` only ever sends GET; this is checked by tests on the source and on the wire.
- Credentials are sent only to `*.atlassian.net` or the `api.atlassian.com/ex/jira/<cloudId>` gateway.
- Redirects are checked hop by hop.
- `get` has an allowlist plus a denylist for secret and personal-data endpoints.
- Email addresses and avatar URLs are scrubbed from all output.

**Commands**

- Issues:
  - `search` uses `/rest/api/3/search/jql` with token paging.
  - `issue` renders ADF as Markdown and shows custom fields by name.
  - `comments`, `changelog` (with `--field`), `transitions` (list only), `links`, `worklogs`, `attachments` (metadata only)
- Lookups: `fields` and `user-search`
- Agile:
  - `boards`, `board` (columns, filter JQL, estimation), `sprints`, `sprint`
  - `sprint-issues` groups by status, with estimate totals, flags and blockers.
  - `backlog`, `board-issues`, `epics`
- Setup: `check`, `me`, `get`
