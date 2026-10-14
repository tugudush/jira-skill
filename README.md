# jira skill (read-only Jira Cloud)

This is an agent skill for Claude Code and other agents that load `SKILL.md` skills. It lets the agent read Jira Cloud: issues, JQL search, comments, change history, links, worklogs and attachment metadata, plus boards, sprints, backlogs and epics. It cannot change anything.

## Why it is read-only by design, not by instruction

| Layer                                                                                                                                                                                                                                                                       | What it stops                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `scripts/jira.mjs` has a single `fetch` call, and its method is the literal `"GET"`. A test fails if any other method shows up in the source.                                                                                                                               | Any write: create, edit, comment, transition, assign, log work, sprint changes. The code to do them doesn't exist. |
| Credentials are sent only to `https://<site>.atlassian.net` or `https://api.atlassian.com/ex/jira/<cloudId>`. Redirects are followed by hand, and any hop off that origin and prefix is refused.                                                                            | Leaking the token to another host, including through a planted `JIRA_BASE_URL` or an open redirect.                |
| `get <path>` only allows `/rest/api/{2,3}/` and `/rest/agile/1.0/`. It also refuses webhooks, entity properties, application properties, app/Connect configuration, auditing, account emails and attachment downloads. These checks run on the decoded, dot-collapsed path. | Reading secrets or personal data through the generic escape hatch.                                                 |
| `emailAddress` and `avatarUrls` are removed from every response, including `--json`.                                                                                                                                                                                        | Personal data in the conversation.                                                                                 |
| Recommended: an API token **with scopes**, limited to read scopes.                                                                                                                                                                                                          | Writes are refused by Jira itself as well, even if someone bypassed the script.                                    |

## Setup

1. Create a token at <https://id.atlassian.com/manage-profile/security/api-tokens>. Choose **Create API token with scopes**, then **Jira**, and select only these scopes:
   - `read:jira-work`
   - `read:jira-user`
   - `read:board-scope:jira-software`
   - `read:sprint:jira-software`
2. Find your site's cloudId by opening `https://<your-site>.atlassian.net/_edge/tenant_info` in a browser.
3. Set these three variables in your own user environment, outside any chat. All three are required:
   - `JIRA_BASE_URL`: with a scoped token, `https://api.atlassian.com/ex/jira/<cloudId>`. With a classic, unscoped token, `https://<your-site>.atlassian.net`.
   - `JIRA_EMAIL`: your Atlassian account email.
   - `JIRA_API_TOKEN`: the token.

   **Windows (recommended: the settings dialog, so the token never lands in a command history):**
   1. Press the Windows key, type `environment variables`, and choose **Edit environment variables for your account**.
   2. Under **User variables for <you>**, click **New…**, enter the variable name and value, and click OK. Repeat for each of the three variables.
   3. Click OK to close the dialog.

   Avoid `setx JIRA_API_TOKEN ...` and `$env:JIRA_API_TOKEN = ...`: the token would be saved in your shell history, and in a chat if you run it through an agent.

   **macOS / Linux:** add `export JIRA_BASE_URL=...`, `export JIRA_EMAIL=...` and `export JIRA_API_TOKEN=...` to your shell profile (`~/.zshrc`, `~/.bashrc` or `~/.profile`), edited in a text editor rather than typed into the terminal. Then run `source` on the file, or open a new terminal.

   Don't put them in a `.env` file inside a repository or in the skill folder, where they could be committed or read by other tools. Don't put them in Claude Code's `settings.json` `env` block either, since that file is plain text and may be synced.

4. Restart VS Code completely (close every window, not just the terminal), so it and the agent it runs pick up the new variables. Then run `node scripts/jira.mjs check`. It shows each variable as `set` or `NOT SET` without printing the values, and the display name of the account that the token belongs to.

Never paste a token into a chat. If one is exposed, revoke it and report it through the Information Security incident process.

Optional settings: `JIRA_REQUEST_TIMEOUT` (ms, default 30000). For a corporate proxy, set `HTTPS_PROXY` together with `NODE_USE_ENV_PROXY=1`. For a TLS-inspecting proxy, use `NODE_EXTRA_CA_CERTS`.

## Development

- `npm test` runs `node --test`. The tests use a loopback mock server, with no network and no credentials.
- The tests cover:
  - GET-only enforcement, both in the source and on the wire
  - the host and redirect guards
  - the `get` allow/deny lists, including percent-encoding and `..` bypass attempts
  - scrubbing, ADF → Markdown, both paging styles, retries, and argument checks
- The design follows the sibling `bitbucket-cloud` skill (`scripts/bb.mjs`).
