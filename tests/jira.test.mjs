// Tests for scripts/jira.mjs. Run from the skill root with: node --test (or npm test).
// Unit tests import the pure helpers; end-to-end tests run the CLI against loopback mock servers
// (JIRA_BASE_URL=http://127.0.0.1:<port>, which the HTTPS check allows for loopback only).

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  commands,
  parseArgs,
  checkFlags,
  maxArgs,
  parseBase,
  isOwn,
  refusedPath,
  issueKeyFrom,
  boardIdFrom,
  sprintIdFrom,
  adfToMarkdown,
  scrub,
  fieldValue,
  blockers,
  fmtDate,
  fmtSeconds,
  historyText,
  project,
  errorDetail,
  UNAUTHORIZED_HINT,
} from '../scripts/jira.mjs'

const JIRA = fileURLToPath(new URL('../scripts/jira.mjs', import.meta.url))
const SITE = {
  origin: 'https://acme.atlassian.net',
  prefix: '',
  host: 'acme.atlassian.net',
  mode: 'site',
}
const CLOUD = '11111111-2222-3333-4444-555555555555'
const GATEWAY = {
  origin: 'https://api.atlassian.com',
  prefix: `/ex/jira/${CLOUD}`,
  host: 'api.atlassian.com',
  mode: 'gateway',
}

// ---------------------------------------------------------------- read-only by construction

describe('read-only by construction', () => {
  const src = readFileSync(JIRA, 'utf8')
  test('there is exactly one fetch call, and every method in the source is GET', () => {
    assert.equal((src.match(/\bfetch\(/g) || []).length, 1)
    const methods = [...src.matchAll(/method\s*:\s*["'`]([A-Za-z]+)/g)].map(
      (m) => m[1]
    )
    assert.deepEqual(methods, ['GET'])
  })
  test('no other HTTP client is imported', () => {
    assert.doesNotMatch(
      src,
      /from\s+["']node:(http|https|net|tls|child_process)["']/
    )
    assert.doesNotMatch(src, /\b(XMLHttpRequest|undici|axios)\b/)
  })
  test('every command is registered with a usage line and a summary', () => {
    for (const c of Object.values(commands))
      assert.ok(c.usage.startsWith(c.name) && c.summary, c.name)
  })
})

// ---------------------------------------------------------------- unit

describe('parseBase', () => {
  test('accepts a site root and the scoped-token gateway', () => {
    assert.deepEqual(parseBase('https://acme.atlassian.net/'), SITE)
    assert.deepEqual(
      parseBase(`https://api.atlassian.com/ex/jira/${CLOUD}`),
      GATEWAY
    )
    assert.equal(
      parseBase('https://ACME.atlassian.net').host,
      'acme.atlassian.net'
    )
  })
  test('refuses other hosts, look-alikes, http, credentials in the URL and stray paths', () => {
    for (const bad of [
      'https://evil.com',
      'https://acme.atlassian.net.evil.com',
      'https://atlassian.net',
      'https://acme.atlassian.net.',
      'https://evil.com/acme.atlassian.net',
      'http://acme.atlassian.net',
      'https://user:pw@acme.atlassian.net',
      'https://acme.atlassian.net/jira/software',
      'https://acme.atlassian.net/?x=1',
      'https://api.atlassian.com',
      'https://api.atlassian.com/ex/confluence/' + CLOUD,
      'https://api.atlassian.com/ex/jira/not-a-uuid',
      'not a url',
      '',
    ])
      assert.throws(
        () => parseBase(bad),
        /Refusing|must|should be|not set|not a valid/,
        bad
      )
  })
  test('loopback may use http (tests only)', () => {
    assert.equal(parseBase('http://127.0.0.1:1234').mode, 'test')
  })
})

describe('isOwn', () => {
  test('site: same origin only', () => {
    assert.ok(isOwn('https://acme.atlassian.net/rest/api/3/myself', SITE))
    assert.ok(!isOwn('https://other.atlassian.net/rest/api/3/myself', SITE))
    assert.ok(!isOwn('http://acme.atlassian.net/rest/api/3/myself', SITE))
  })
  test('gateway: same origin AND under the cloudId prefix', () => {
    assert.ok(
      isOwn(
        `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/myself`,
        GATEWAY
      )
    )
    assert.ok(
      !isOwn(`https://api.atlassian.com/ex/confluence/${CLOUD}/wiki`, GATEWAY)
    )
    assert.ok(
      !isOwn(`https://api.atlassian.com/ex/jira/${CLOUD}x/rest`, GATEWAY)
    )
  })
})

describe('refusedPath (get)', () => {
  const u = (p) => `https://acme.atlassian.net${p}`
  test('allows ordinary REST and agile reads', () => {
    for (const p of [
      '/rest/api/3/project/ABC',
      '/rest/api/2/issue/ABC-1',
      '/rest/agile/1.0/board/1/sprint',
      '/rest/api/3/issue/ABC-1?expand=names',
    ])
      assert.equal(refusedPath(u(p)), null, p)
  })
  test('refuses APIs outside Jira REST (JSM, Confluence, internal)', () => {
    for (const p of [
      '/rest/servicedeskapi/request',
      '/wiki/rest/api/content',
      '/rest/greenhopper/1.0/x',
      '/secure/Dashboard.jspa',
    ])
      assert.match(refusedPath(u(p)), /only reads/, p)
  })
  test('refuses secret-bearing and personal-data endpoints', () => {
    for (const p of [
      '/rest/api/3/webhook',
      '/rest/api/3/issue/ABC-1/properties/x',
      '/rest/api/3/project/ABC/properties',
      '/rest/api/3/user/properties',
      '/rest/api/3/application-properties',
      '/rest/api/3/application-properties/advanced-settings',
      '/rest/api/3/app/field/x/context/configuration',
      '/rest/api/3/auditing/record',
      '/rest/api/3/user/email?accountId=1',
      '/rest/api/3/user/email/bulk',
      '/rest/api/3/attachment/content/10000',
      '/rest/api/3/attachment/thumbnail/10000',
      '/rest/atlassian-connect/1/addons/x',
    ])
      assert.ok(refusedPath(u(p)), p)
  })
  test('percent-encoding and dot segments do not get past it', () => {
    for (const p of [
      '/rest/api/3/issue/ABC-1/%70roperties',
      '/rest/api/3/issue/ABC-1/%2570roperties',
      '/rest/api/3/project/%2e%2e/webhook',
      '/rest/api/3/x/%2e%2e/%2e%2e/%2e%2e/rest/servicedeskapi/request',
      '/rest/api/3/issue%2fABC-1%2fproperties',
      '/rest/api/3/WebHook',
    ])
      assert.ok(refusedPath(u(p)), p)
  })
  test('gateway paths are checked below the cloudId prefix', () => {
    const g = `https://api.atlassian.com/ex/jira/${CLOUD}`
    assert.equal(refusedPath(`${g}/rest/api/3/myself`, GATEWAY.prefix), null)
    assert.ok(refusedPath(`${g}/rest/api/3/webhook`, GATEWAY.prefix))
    assert.ok(
      refusedPath(
        `https://api.atlassian.com/ex/jira/${CLOUD}/../x/rest/api/3/myself`,
        GATEWAY.prefix
      )
    )
  })
})

describe('targets', () => {
  test('issue keys, ids and URLs', () => {
    assert.equal(issueKeyFrom('abc-12', SITE), 'ABC-12')
    assert.equal(issueKeyFrom('10042', SITE), '10042')
    assert.equal(
      issueKeyFrom('https://acme.atlassian.net/browse/ABC-7', SITE),
      'ABC-7'
    )
    assert.equal(
      issueKeyFrom(
        'https://acme.atlassian.net/jira/software/c/projects/ABC/boards/3?selectedIssue=ABC-9',
        SITE
      ),
      'ABC-9'
    )
    assert.equal(
      issueKeyFrom(
        'https://acme.atlassian.net/jira/software/projects/ABC/issues/ABC-5',
        SITE
      ),
      'ABC-5'
    )
  })
  test('a link from another site is refused, not silently answered from this one', () => {
    assert.throws(
      () => issueKeyFrom('https://other.atlassian.net/browse/ABC-7', SITE),
      /JIRA_BASE_URL points to acme/
    )
    assert.equal(
      issueKeyFrom('https://acme.atlassian.net/browse/ABC-7', GATEWAY),
      'ABC-7'
    )
  })
  test('garbage is not an issue key', () => {
    for (const bad of ['ABC', 'ABC-', '-1', 'AB C-1', '../x', ''])
      assert.throws(() => issueKeyFrom(bad, SITE), undefined, bad)
  })
  test('boards and sprints', () => {
    assert.equal(boardIdFrom('12', SITE), '12')
    assert.equal(
      boardIdFrom(
        'https://acme.atlassian.net/jira/software/c/projects/ABC/boards/12/backlog',
        SITE
      ),
      '12'
    )
    assert.equal(
      boardIdFrom(
        'https://acme.atlassian.net/secure/RapidBoard.jspa?rapidView=8',
        SITE
      ),
      '8'
    )
    assert.throws(() => boardIdFrom('ABC', SITE), /not a board id/)
    assert.equal(sprintIdFrom('345', SITE), '345')
    assert.equal(
      sprintIdFrom(
        'https://acme.atlassian.net/jira/software/c/projects/ABC/boards/12?sprint=77',
        SITE
      ),
      '77'
    )
  })
})

describe('adfToMarkdown', () => {
  const doc = (...content) => ({ type: 'doc', version: 1, content })
  const p = (...content) => ({ type: 'paragraph', content })
  const t = (text, marks) => ({
    type: 'text',
    text,
    ...(marks ? { marks } : {}),
  })
  test('paragraphs, marks, links, mentions', () => {
    const md = adfToMarkdown(
      doc(
        p(
          t('Hi '),
          { type: 'mention', attrs: { id: '1', text: '@Jane Doe' } },
          t(', see '),
          t('docs', [{ type: 'link', attrs: { href: 'https://x.io' } }])
        ),
        p(t('bold', [{ type: 'strong' }]), t(' '), t('x()', [{ type: 'code' }]))
      )
    )
    assert.equal(md, 'Hi @Jane Doe, see [docs](https://x.io)\n\n**bold** `x()`')
  })
  test('headings, nested lists, tasks, code, quotes, rules', () => {
    const md = adfToMarkdown(
      doc(
        { type: 'heading', attrs: { level: 2 }, content: [t('Steps')] },
        {
          type: 'orderedList',
          content: [
            {
              type: 'listItem',
              content: [
                p(t('one')),
                {
                  type: 'bulletList',
                  content: [{ type: 'listItem', content: [p(t('sub'))] }],
                },
              ],
            },
            { type: 'listItem', content: [p(t('two'))] },
          ],
        },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { state: 'DONE' },
              content: [t('done')],
            },
            {
              type: 'taskItem',
              attrs: { state: 'TODO' },
              content: [t('todo')],
            },
          ],
        },
        {
          type: 'codeBlock',
          attrs: { language: 'js' },
          content: [t('a()\nb()')],
        },
        { type: 'blockquote', content: [p(t('quoted'))] },
        { type: 'rule' }
      )
    )
    assert.equal(
      md,
      '## Steps\n\n1. one\n   - sub\n2. two\n\n- [x] done\n- [ ] todo\n\n```js\na()\nb()\n```\n\n> quoted\n\n---'
    )
  })
  test('tables, status, dates, cards and media', () => {
    const cell = (type, s) => ({ type, content: [p(t(s))] })
    const md = adfToMarkdown(
      doc(
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [cell('tableHeader', 'A'), cell('tableHeader', 'B|C')],
            },
            {
              type: 'tableRow',
              content: [cell('tableCell', '1'), cell('tableCell', '2')],
            },
          ],
        },
        p(
          { type: 'status', attrs: { text: 'BLOCKED' } },
          t(' '),
          { type: 'date', attrs: { timestamp: '1735689600000' } },
          t(' '),
          {
            type: 'inlineCard',
            attrs: { url: 'https://acme.atlassian.net/browse/ABC-1' },
          }
        ),
        {
          type: 'mediaSingle',
          content: [
            { type: 'media', attrs: { id: 'm', alt: 'screenshot.png' } },
          ],
        }
      )
    )
    assert.equal(
      md,
      '| A | B\\|C |\n| --- | --- |\n| 1 | 2 |\n\n[BLOCKED] 2025-01-01 <https://acme.atlassian.net/browse/ABC-1>\n\n[attachment: screenshot.png]'
    )
  })
  test('strings, null and unknown nodes', () => {
    assert.equal(adfToMarkdown('plain'), 'plain')
    assert.equal(adfToMarkdown(null), '')
    assert.equal(
      adfToMarkdown(
        doc({ type: 'futureThing', content: [p(t('still shown'))] })
      ),
      'still shown'
    )
  })
})

describe('formatting helpers', () => {
  test('scrub removes emails and avatars at any depth', () => {
    const out = scrub({
      a: {
        emailAddress: 'x@y',
        displayName: 'X',
        avatarUrls: { '48x48': 'u' },
      },
      l: [{ emailAddress: 'z' }],
    })
    assert.deepEqual(out, { a: { displayName: 'X' }, l: [{}] })
  })
  test('fieldValue renders the usual shapes', () => {
    assert.equal(fieldValue(null), null)
    assert.equal(fieldValue([]), null)
    assert.equal(fieldValue(5), '5')
    assert.equal(
      fieldValue({ value: 'High', child: { value: 'Sub' } }),
      'High / Sub'
    )
    assert.equal(
      fieldValue([{ name: 'Sprint 3', state: 'active' }]),
      'Sprint 3 (active)'
    )
    assert.equal(fieldValue({ displayName: 'Jane' }), 'Jane')
    assert.equal(
      fieldValue({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'rich' }] },
        ],
      }),
      'rich'
    )
    assert.equal(fieldValue({}), null)
  })
  test("blockers: only unresolved 'is blocked by' links", () => {
    const type = { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }
    const st = (name, key) => ({ status: { name, statusCategory: { key } } })
    const f = {
      issuelinks: [
        {
          type,
          inwardIssue: {
            key: 'A-1',
            fields: st('In Progress', 'indeterminate'),
          },
        },
        { type, inwardIssue: { key: 'A-2', fields: st('Done', 'done') } },
        { type, outwardIssue: { key: 'A-3', fields: st('To Do', 'new') } },
      ],
    }
    assert.deepEqual(blockers(f), ['A-1 [In Progress]'])
  })
  test('dates and durations', () => {
    assert.equal(
      fmtDate('2025-01-14T10:23:45.123+0000'),
      '2025-01-14 10:23 +0000'
    )
    assert.equal(fmtDate('2025-01-14'), '2025-01-14')
    assert.equal(fmtSeconds(5400), '1h 30m')
    assert.equal(fmtSeconds(1800), '30m')
  })
  test("history uses the item's own toString, never Object.prototype.toString", () => {
    const line = historyText({
      created: '2025-01-01T00:00:00.000+0000',
      author: { displayName: 'A' },
      items: [{ field: 'status', fromString: 'To Do', to: '3' }],
    })
    assert.equal(line, '- 2025-01-01 00:00 +0000 A: status: To Do → 3')
  })
  test("errorDetail joins Jira's error shapes", () => {
    assert.equal(
      errorDetail('{"errorMessages":["Bad JQL"],"errors":{"jql":"x"}}'),
      'Bad JQL; jql: x'
    )
    assert.equal(errorDetail('<html>proxy</html>'), '')
  })
  test('--select projects list items', () => {
    const out = project(
      { values: [{ key: 'A-1', fields: { status: { name: 'Done' } } }] },
      'key,fields.status.name'
    )
    assert.deepEqual(out.values, [{ key: 'A-1', 'fields.status.name': 'Done' }])
  })
})

describe('argument checks', () => {
  test('unknown flags get a suggestion; paging flags only on lists', () => {
    assert.throws(
      () => checkFlags(commands.issue, { feilds: 'x' }),
      /Did you mean --fields/
    )
    assert.throws(
      () => checkFlags(commands.issue, { all: true }),
      /not a list command/
    )
    assert.throws(
      () => checkFlags(commands.search, { start: '5' }),
      /not supported by search/
    )
    assert.throws(
      () => checkFlags(commands.comments, { all: true, start: '5' }),
      /cannot be combined/
    )
    assert.throws(
      () => checkFlags(commands.comments, { 'max-pages': '2' }),
      /only applies together with --all/
    )
    checkFlags(commands.search, { next: 'tok', all: true, 'max-pages': '3' })
  })
  test('single-dash options are rejected', () => {
    assert.throws(
      () => parseArgs(['issue', 'ABC-1', '-f', 'x']),
      /Unknown option -f/
    )
  })
  test('maxArgs counts <…> tokens', () => {
    assert.equal(maxArgs(commands.search.usage), 1)
    assert.equal(maxArgs(commands.boards.usage), 0)
  })
})

// ---------------------------------------------------------------- end to end against a mock Jira

const seen = []
const foreignSeen = []
let base
let foreignBase
let rateHits = 0

const user = (name) => ({
  accountId: `id-${name}`,
  displayName: name,
  emailAddress: `${name.toLowerCase()}@corp.example`,
  avatarUrls: { '48x48': 'https://a' },
  active: true,
})
const status = (name, key) => ({
  name,
  statusCategory: {
    key,
    name: { new: 'To Do', indeterminate: 'In Progress', done: 'Done' }[key],
  },
})
const issue = (key, extra = {}) => ({
  key,
  fields: {
    summary: `Summary of ${key}`,
    status: status('In Progress', 'indeterminate'),
    issuetype: { name: 'Story' },
    priority: { name: 'High' },
    assignee: user('Jane'),
    updated: '2025-03-01T09:00:00.000+0000',
    ...extra,
  },
})

const routes = {
  '/rest/api/3/myself': () => user('Jane'),
  '/rest/api/3/search/jql': (q) =>
    q.get('nextPageToken') === 't2'
      ? { issues: [issue('ABC-3')], isLast: true }
      : {
          issues: [issue('ABC-1'), issue('ABC-2', { customfield_10016: 5 })],
          nextPageToken: 't2',
          isLast: false,
          names: { customfield_10016: 'Story Points' },
        },
  '/rest/api/3/issue/ABC-1': () => ({
    ...issue('ABC-1', {
      reporter: user('Bob'),
      description: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Steps to reproduce' },
              { type: 'text', text: '‮evil' },
            ],
          },
        ],
      },
      customfield_10016: 3,
      customfield_10019: '0|i0001:',
      customfield_10020: [{ id: 5, name: 'Sprint 5', state: 'active' }],
    }),
    names: {
      customfield_10016: 'Story Points',
      customfield_10019: 'Rank',
      customfield_10020: 'Sprint',
    },
  }),
  '/rest/api/3/issue/ABC-1/comment': (q) => ({
    startAt: Number(q.get('startAt')),
    maxResults: 1,
    total: 2,
    comments: [
      Number(q.get('startAt')) === 0
        ? {
            author: user('Bob'),
            created: '2025-03-02T10:00:00.000+0000',
            body: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'newest' }],
                },
              ],
            },
          }
        : {
            author: user('Jane'),
            created: '2025-03-01T10:00:00.000+0000',
            body: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'oldest' }],
                },
              ],
            },
          },
    ],
  }),
  '/rest/api/3/issue/ABC-1/changelog': () => ({
    startAt: 0,
    maxResults: 100,
    total: 2,
    isLast: true,
    values: [
      {
        created: '2025-03-01T10:00:00.000+0000',
        author: user('Jane'),
        items: [
          {
            field: 'status',
            fieldId: 'status',
            fromString: 'To Do',
            toString: 'In Progress',
          },
        ],
      },
      {
        created: '2025-03-02T10:00:00.000+0000',
        author: user('Bob'),
        items: [
          {
            field: 'assignee',
            fieldId: 'assignee',
            fromString: 'Jane',
            toString: 'Bob',
          },
        ],
      },
    ],
  }),
  '/rest/agile/1.0/sprint/5': () => ({
    id: 5,
    name: 'Sprint 5',
    state: 'active',
    startDate: '2025-03-01T00:00:00.000Z',
    endDate: '2025-03-14T00:00:00.000Z',
    goal: 'Ship it',
    originBoardId: 12,
  }),
  '/rest/agile/1.0/board/12/configuration': () => ({
    filter: { id: '100' },
    estimation: {
      type: 'field',
      field: { fieldId: 'customfield_10016', displayName: 'Story Points' },
    },
    columnConfig: { columns: [{ name: 'To Do', statuses: [{ id: '1' }] }] },
  }),
  '/rest/agile/1.0/sprint/5/issue': (q) => {
    const blocks = {
      name: 'Blocks',
      inward: 'is blocked by',
      outward: 'blocks',
    }
    const all = [
      issue('ABC-1', { customfield_10016: 3, flagged: true }),
      issue('ABC-2', {
        customfield_10016: 5,
        issuelinks: [
          {
            type: blocks,
            inwardIssue: {
              key: 'XYZ-9',
              fields: { status: status('To Do', 'new') },
            },
          },
        ],
      }),
      issue('ABC-4', { customfield_10016: 2, status: status('Done', 'done') }),
    ]
    const at = Number(q.get('startAt'))
    return {
      startAt: at,
      maxResults: 2,
      total: all.length,
      issues: all.slice(at, at + 2),
    }
  },
  '/rest/api/3/rate': () => {
    rateHits++
    return rateHits === 1
      ? {
          __status: 429,
          __headers: { 'retry-after': '0' },
          errorMessages: ['slow down'],
        }
      : { ok: true }
  },
  '/rest/api/3/unauth': () => ({
    __status: 401,
    errorMessage: 'Client must be authenticated to access this resource.',
  }),
  '/rest/api/3/hop': () => ({
    __status: 302,
    __headers: { location: `${foreignBase}/steal` },
  }),
}

function apiHandler(req, res) {
  const u = new URL(req.url, 'http://x')
  seen.push({
    method: req.method,
    path: u.pathname,
    query: u.searchParams,
    auth: req.headers.authorization,
  })
  const route = routes[u.pathname]
  if (!route) {
    res.writeHead(404, { 'content-type': 'application/json' })
    return res.end(
      JSON.stringify({
        errorMessages: [
          'Issue does not exist or you do not have permission to see it.',
        ],
      })
    )
  }
  const { __status = 200, __headers = {}, ...body } = route(u.searchParams)
  res.writeHead(__status, { 'content-type': 'application/json', ...__headers })
  res.end(JSON.stringify(body))
}

const listen = (handler) =>
  new Promise((done) => {
    const s = http.createServer(handler)
    s.listen(0, '127.0.0.1', () => done(s))
  })

function jira(args, env = {}) {
  const clean = { ...process.env }
  for (const k of Object.keys(clean))
    if (/^(JIRA_|HTTPS?_PROXY$|NODE_USE_ENV_PROXY$)/i.test(k)) delete clean[k]
  return new Promise((done) => {
    execFile(
      process.execPath,
      [JIRA, ...args],
      {
        env: {
          ...clean,
          JIRA_BASE_URL: base,
          JIRA_EMAIL: 'me@example.com',
          JIRA_API_TOKEN: 's3cret-token-value',
          JIRA_RETRY_BASE_MS: '1',
          ...env,
        },
      },
      (err, stdout, stderr) =>
        done({ code: err ? err.code : 0, stdout, stderr })
    )
  })
}

describe('CLI against a mock Jira', () => {
  const servers = []
  before(async () => {
    const a = await listen(apiHandler)
    const f = await listen((req, res) => {
      foreignSeen.push({ auth: req.headers.authorization })
      res.end('{}')
    })
    servers.push(a, f)
    base = `http://127.0.0.1:${a.address().port}`
    foreignBase = `http://127.0.0.1:${f.address().port}`
  })
  after(() => servers.forEach((s) => s.close()))

  test('check reports set/unset but never the values', async () => {
    const r = await jira(['check'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /JIRA_API_TOKEN: set/)
    assert.match(r.stdout, /Authenticated as: Jane/)
    assert.doesNotMatch(
      r.stdout + r.stderr,
      /s3cret-token-value|me@example\.com/
    )
    const none = await jira(['check'], { JIRA_API_TOKEN: '' })
    assert.equal(none.code, 1)
    assert.match(
      none.stdout,
      /JIRA_API_TOKEN: NOT SET[\s\S]*never paste a token/
    )
  })

  test('check shows the token length and warns about paste mistakes without quoting the values', async () => {
    const ok = await jira(['check'])
    assert.match(ok.stdout, /JIRA_API_TOKEN: set \(18 characters\)/)
    assert.doesNotMatch(ok.stdout, /Warning:/)
    const bad = await jira(['check'], {
      JIRA_EMAIL: 'not-an-email',
      JIRA_API_TOKEN: '"s3cret-token-value "',
    })
    assert.match(
      bad.stdout,
      /Warning: JIRA_EMAIL does not look like an email address/
    )
    assert.match(
      bad.stdout,
      /Warning: JIRA_API_TOKEN contains whitespace or quotes/
    )
    assert.doesNotMatch(
      bad.stdout + bad.stderr,
      /s3cret-token-value|not-an-email/
    )
    const spaced = await jira(['check'], { JIRA_EMAIL: ' me@example.com' })
    assert.match(
      spaced.stdout,
      /Warning: JIRA_EMAIL contains whitespace or quotes/
    )
    assert.doesNotMatch(spaced.stdout + spaced.stderr, /me@example\.com/)
  })

  test('a 401 hint tells the user to check the email, and fits the URL type in use', async () => {
    const r = await jira(['get', '/rest/api/3/unauth'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /401/)
    assert.match(
      r.stderr,
      /JIRA_EMAIL is the email of the Atlassian account that created the token/
    )
    assert.doesNotMatch(r.stderr, /s3cret-token-value|me@example\.com/)
    // site URL: classic tokens work, scoped tokens need the gateway
    assert.match(UNAUTHORIZED_HINT.site, /JIRA_EMAIL is the email/)
    assert.match(
      UNAUTHORIZED_HINT.site,
      /classic token.*works on this site URL/
    )
    assert.match(
      UNAUTHORIZED_HINT.site,
      /\*with scopes\* does not.*api\.atlassian\.com\/ex\/jira\/<cloudId>/
    )
    // gateway URL: scoped tokens only, and the cloudId must be for the site
    assert.match(UNAUTHORIZED_HINT.gateway, /JIRA_EMAIL is the email/)
    assert.match(UNAUTHORIZED_HINT.gateway, /classic token is rejected here/)
    assert.match(
      UNAUTHORIZED_HINT.gateway,
      /cloudId in JIRA_BASE_URL is for your site/
    )
  })

  test('search pages with nextPageToken, shows extra fields by name, and scrubs emails from JSON', async () => {
    const one = await jira([
      'search',
      'project = ABC',
      '--fields',
      'customfield_10016',
    ])
    assert.equal(one.code, 0, one.stderr)
    assert.match(
      one.stdout,
      /ABC-1 \[Story\] \[In Progress\] Summary of ABC-1 \(High\) — Jane/
    )
    assert.match(one.stdout, /Story Points: 5/)
    assert.match(one.stdout, /--next t2/)
    const q = seen.findLast((s) => s.path === '/rest/api/3/search/jql').query
    assert.equal(q.get('jql'), 'project = ABC')
    assert.match(q.get('fields'), /summary,status.*customfield_10016/)
    const all = await jira(['search', 'project = ABC', '--all', '--json'])
    const data = JSON.parse(all.stdout)
    assert.deepEqual(
      data.values.map((i) => i.key),
      ['ABC-1', 'ABC-2', 'ABC-3']
    )
    assert.doesNotMatch(all.stdout, /emailAddress|corp\.example|avatarUrls/)
  })

  test('issue renders fields, drops noise, reveals invisible characters', async () => {
    const r = await jira(
      ['issue', 'https://acme.atlassian.net/browse/abc-1'],
      {}
    )
    // the test base is loopback, so an atlassian.net link is accepted as on-site
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /^ABC-1: Summary of ABC-1/)
    assert.match(r.stdout, /Assignee: Jane · Reporter: Bob/)
    assert.match(r.stdout, /Sprint: Sprint 5 \(active\)/)
    assert.match(r.stdout, /Story Points: 3/)
    assert.doesNotMatch(r.stdout, /Rank|0\|i0001/)
    assert.match(r.stdout, /Steps to reproduce<U\+202E>evil/)
    assert.match(r.stderr, /invisible character/)
    const q = seen.findLast((s) => s.path === '/rest/api/3/issue/ABC-1').query
    assert.equal(q.get('fields'), '*all,-comment,-worklog')
  })

  test('comments page by offset and say how to continue', async () => {
    const r = await jira(['comments', 'ABC-1', '--limit', '1'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /Comments on ABC-1, newest first \(1–1 of 2\)/)
    assert.match(r.stdout, /--start 1/)
    assert.equal(
      seen.findLast((s) => s.path.endsWith('/comment')).query.get('orderBy'),
      '-created'
    )
    const all = await jira(['comments', 'ABC-1', '--all'])
    assert.match(all.stdout, /newest[\s\S]*oldest/)
  })

  test('changelog --field filters across pages', async () => {
    const r = await jira(['changelog', 'ABC-1', '--field', 'status'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /status: To Do → In Progress/)
    assert.doesNotMatch(r.stdout, /assignee/)
  })

  test('sprint-issues groups by status with estimates, flags and blockers', async () => {
    const r = await jira(['sprint-issues', '5'])
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /Sprint 5 \[active\] 2025-03-01 → 2025-03-14/)
    assert.match(r.stdout, /3 issue\(s\) · Story Points: 10 total/)
    assert.match(
      r.stdout,
      /In Progress \(2, 8\):[\s\S]*⚑ flagged[\s\S]*blocked by XYZ-9 \[To Do\][\s\S]*Done \(1, 2\):/
    )
    assert.match(
      seen
        .findLast((s) => s.path === '/rest/agile/1.0/sprint/5/issue')
        .query.get('fields'),
      /flagged.*customfield_10016/
    )
  })

  test('429 is retried, honouring Retry-After', async () => {
    rateHits = 0
    const r = await jira(['get', 'rest/api/3/rate'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(rateHits, 2)
  })

  test('a redirect off the configured origin is refused and gets no credentials', async () => {
    const r = await jira(['get', '/rest/api/3/hop'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Refusing to follow a redirect/)
    assert.equal(foreignSeen.length, 0)
  })

  test('get refuses secret endpoints before any request', async () => {
    const before = seen.length
    const r = await jira(['get', '/rest/api/3/issue/ABC-1/%70roperties/secret'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Refusing to read this endpoint/)
    assert.equal(seen.length, before)
  })

  test("404 explains Jira's permission-shaped not-found", async () => {
    const r = await jira(['issue', 'NOPE-1'])
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Hint: Not found\. Jira also answers 404/)
  })

  test('refuses a non-Atlassian base URL before sending anything', async () => {
    const r = await jira(['me'], { JIRA_BASE_URL: 'https://evil.example' })
    assert.equal(r.code, 1)
    assert.match(r.stderr, /Refusing to use JIRA_BASE_URL/)
  })

  test('the mock only ever saw GET', () => {
    assert.ok(seen.length > 10)
    assert.deepEqual(uniqMethods(), ['GET'])
  })
})

const uniqMethods = () => [...new Set(seen.map((s) => s.method))]
