# JQL cheat-sheet

Read this when a `search` fails with a 400, or when you need an operator or function that isn't in SKILL.md. Pass the whole JQL to `jira search` as one quoted argument.

## Contents

- [Shape of a query](#shape-of-a-query)
- [Fields people ask about](#fields-people-ask-about)
- [Operators](#operators)
- [Functions](#functions)
- [Dates](#dates)
- [Ready-made queries](#ready-made-queries)
- [Errors and their fixes](#errors-and-their-fixes)

## Shape of a query

```
<clause> [AND|OR <clause> …] [ORDER BY <field> [ASC|DESC], …]
```

- Use parentheses to group clauses: `project = ABC AND (priority = High OR labels = urgent)`.
- Values that contain spaces or reserved words need double quotes: `status = "In Progress"`, `fixVersion = "2.4.0"`.
- Field names that contain spaces need quotes too: `"Story Points" > 3`. You can also use the `cf[NNNNN]` form: `cf[10016] > 3`.
- Keywords are case-insensitive. Values usually are as well, but not for every field.

## Fields people ask about

| Field                                                  | Notes                                                                                                                  |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `project`                                              | Key or name: `project = ABC`, `project in (ABC, XYZ)`                                                                  |
| `issuetype` / `type`                                   | `issuetype = Bug`, `issuetype in (Story, Task)`, `issuetype in standardIssueTypes()`                                   |
| `status`                                               | The exact name on this workflow: `status = "Code Review"`                                                              |
| `statusCategory`                                       | One of three values that work across workflows: `"To Do"`, `"In Progress"`, `Done`. Prefer it to listing status names. |
| `resolution`                                           | `resolution = Unresolved` means open in most workflows                                                                 |
| `assignee`, `reporter`, `creator`                      | accountId or `currentUser()`; `assignee is EMPTY`                                                                      |
| `priority`                                             | `priority in (Highest, High)`                                                                                          |
| `labels`, `component`, `fixVersion`, `affectedVersion` | `labels = backend`, `fixVersion = "2.4.0"`, `fixVersion in unreleasedVersions()`                                       |
| `parent`                                               | Children of an epic or task: `parent = ABC-100`. Works on every project type.                                          |
| `"Epic Link"`                                          | Legacy, for company-managed projects on older sites                                                                    |
| `sprint`                                               | `sprint in openSprints()`, `sprint = 345` (id), `sprint = "ABC Sprint 12"`                                             |
| `text`, `summary`, `description`, `comment`            | Text search: `text ~ "timeout"`, `summary ~ "login*"`                                                                  |
| `created`, `updated`, `resolved`, `due`                | See [Dates](#dates)                                                                                                    |
| `issueLinkType`                                        | `issueLinkType = "is blocked by"`                                                                                      |
| `Flagged`                                              | `Flagged is not EMPTY` finds flagged issues (impediments)                                                              |
| `watcher`, `voter`                                     | `watcher = currentUser()`                                                                                              |

## Operators

- Comparison: `=` `!=` `>` `>=` `<` `<=`
- Lists: `in (a, b)` and `not in (a, b)`
- Empty values: `is EMPTY` and `is not EMPTY` (`is null` also works)
- Text: `~` (contains) and `!~` (does not contain). The `~` operator matches words, not substrings. A trailing `*` acts as a prefix wildcard, and quoted phrases match the exact phrase: `text ~ "\"null pointer\""`.
- History:
  - `status WAS "In Progress"`
  - `status CHANGED FROM "Done" TO "To Do"`, which finds reopened issues
  - `status CHANGED DURING (startOfWeek(), now())`
  - `assignee CHANGED BY <accountId>`
  - `status WAS NOT Done BEFORE "2025-01-01"`

## Functions

| Function                                                                | Use                                                |
| ----------------------------------------------------------------------- | -------------------------------------------------- |
| `currentUser()`                                                         | The token's own account                            |
| `openSprints()`, `closedSprints()`, `futureSprints()`                   | `sprint in openSprints()`                          |
| `startOfDay()`, `startOfWeek()`, `startOfMonth()`, `endOfWeek()` …      | Take offsets, e.g. `startOfWeek(-1)` for last week |
| `now()`                                                                 | The current time                                   |
| `unreleasedVersions()`, `releasedVersions()`, `latestReleasedVersion()` | `fixVersion in unreleasedVersions(ABC)`            |
| `membersOf("group")`                                                    | `assignee in membersOf("team-alpha")`              |
| `issueHistory()`                                                        | Issues you viewed recently                         |
| `linkedIssues(ABC-1)`                                                   | `issue in linkedIssues(ABC-1, "is blocked by")`    |

## Dates

- Relative values: `updated >= -7d`, `created > -2w`, `resolved >= -24h`, `due <= 3d`. The units are `m`, `h`, `d` and `w`; months are `startOfMonth(-1)`.
- Absolute values: `created >= "2025-01-01"` or `"2025/01/01 14:00"`
- Dates are interpreted in the account's time zone, which `jira me` shows.

## Ready-made queries

```text
# my open work, most important first
assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC, updated DESC

# what I touched yesterday or today (standup)
assignee = currentUser() AND updated >= startOfDay(-1) ORDER BY updated DESC

# open bugs in a project, newest first
project = ABC AND issuetype = Bug AND statusCategory != Done ORDER BY created DESC

# reopened recently
project = ABC AND status CHANGED FROM Done DURING (-14d, now())

# stale in-progress work
project = ABC AND statusCategory = "In Progress" AND updated <= -10d ORDER BY updated ASC

# current sprint, unfinished
project = ABC AND sprint in openSprints() AND statusCategory != Done

# flagged or blocked
project = ABC AND (Flagged is not EMPTY OR issueLinkType = "is blocked by") AND statusCategory != Done

# release notes
project = ABC AND fixVersion = "2.4.0" AND statusCategory = Done ORDER BY issuetype, key

# unassigned high-priority items
project = ABC AND assignee is EMPTY AND priority in (Highest, High) AND resolution = Unresolved
```

## Errors and their fixes

| Message contains                                           | Fix                                                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Unbounded JQL queries are not allowed`                    | Add a restriction such as `project = X` or `updated >= -30d` before `ORDER BY`       |
| `The value 'jane' does not exist for the field 'assignee'` | Use the accountId from `jira user-search 'jane'`, or `currentUser()`                 |
| `Field 'Story Points' does not exist`                      | Run `jira fields --search point` to get the exact name, or use `cf[NNNNN]`           |
| `does not exist or you do not have permission`             | The project key or value is wrong, or the account can't see it                       |
| `Expecting operator` / `Expecting ')'`                     | A value with spaces is missing quotes, or a quote was lost in the shell (PowerShell) |
| `The operator '~' is not supported by the 'status' field`  | Use `=` or `in` for fields that aren't text                                          |
