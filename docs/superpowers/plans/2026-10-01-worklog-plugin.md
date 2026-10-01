# Worklog Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A user-scope Claude Code plugin that keeps one private, long-lived Worklog artifact listing every Work Item with its Status, State Phrase and where to find it.

**Architecture:** Fast Node command hooks record Pending Updates to `~/worklog/`. A zero-dependency Node CLI (`bin/worklog.mjs`) turns transcripts in `~/.claude/projects` into Work Item drafts, merges them with the rows already in the artifact database, and archives finished Work Items. The `worklog` skill drives the CLI, writes the State Phrases, and writes rows through the `ArtifactData` tool; a Keeper Session runs the skill on a `/loop`. The artifact page reads rows live from its database and can only delete.

**Tech Stack:** Node ≥ 24 (ES modules, `node:test`, `node:util.parseArgs`), no npm dependencies; Claude Code plugin (skills + hooks); claude.ai Artifact with the `db` capability; `orca`, `git`, `gh` CLIs.

**Spec:** `docs/superpowers/specs/2026-10-01-worklog-design.md`, with vocabulary in `CONTEXT.md` and the publishing decision in `docs/adr/0001-keeper-publishes-from-artifact-database.md`. Read all three before starting.

## Global Constraints

- Node ≥ 24, ES modules (`.mjs`), zero npm dependencies; tests run with `node --test`.
- Hooks finish well inside the 1.5 s `SessionEnd` budget, make no network calls, and always exit 0 with no stderr noise, whatever their input.
- The Worklog never contains transcript text. The digest a draft carries is for writing the State Phrase and is never written to a row.
- Statuses are exactly: `in progress`, `blocked`, `awaiting review`, `done`, `abandoned`.
- User-facing copy (page, skill replies) uses the `CONTEXT.md` terms: Worklog, Work Item, Worktree, Session, Title, Status, State Phrase, Status Override, Pending Update, Keeper, Archived Transcript, Closing, Drift.
- Branches the plugin creates follow `feature/<desc>` or `fix/<desc>`, with `feature/<TICKET>/<desc>` when a ticket exists; lowercase hyphenated description, ticket in original case, never a placeholder segment.
- Archives go to `~/worklog/transcripts/<YYYY-MM-DD>-<branch-slug>/<sessionId>.md` and `<sessionId>.jsonl`; subagent transcripts are excluded.
- First run imports the last 30 days of sessions.
- `WORKLOG_HOME` (default `~/worklog`) and `WORKLOG_CLAUDE_PROJECTS` (default `~/.claude/projects`) override the two roots; every test uses temporary directories through them.
- Code comments follow the `writing-code-comments` skill: only a non-obvious why.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A hook that receives empty, malformed or unexpected stdin must still exit 0 silently**, because a crashing hook surfaces as an error in the user's unrelated Session. Pinned in Task 11.
2. **A Pending Update recorded while the Keeper is mid-sync must not be lost.** Pinned in Task 5 (claim-by-rename, then append, then release).
3. **A row deleted from the page stays deleted even when new Sessions arrive for that Work Item.** Pinned in Task 9.
4. **A Status Override wins over a merged PR**, since the user chose (a) in Q23. Pinned in Task 9.
5. **Work resumed after a Work Item was archived is archived again**, so the Archived Transcript doesn't silently go stale. Pinned in Task 9.

---

## File Structure

```
.claude-plugin/plugin.json        plugin manifest
.claude-plugin/marketplace.json   local marketplace so the plugin can be installed at user scope
package.json                      "type": "module", test script
bin/worklog.mjs                   CLI entry: hook, collect, merge, ack, current, config
hooks/hooks.json                  hook registrations (SessionEnd, Stop, PostCompact, UserPromptSubmit)
lib/paths.mjs                     roots, file locations, JSON read/write
lib/transcript.mjs                one transcript (JSONL) → SessionInfo
lib/workitem.mjs                  Work Item identity, Title, ticket links, grouping
lib/status.mjs                    Status vocabulary and inference
lib/pending.mjs                   Pending Update store
lib/external.mjs                  orca / git / gh lookups behind an injectable exec
lib/archive.mjs                   Archived Transcripts
lib/collect.mjs                   transcripts + lookups → drafts
lib/merge.mjs                     drafts + existing rows → rows to write; local cache
lib/drift.mjs                     Drift context for UserPromptSubmit
page/index.html                   the Worklog artifact page
page/view-model.mjs               tiering, search, display rules (shared by page and tests)
skills/worklog/SKILL.md           /worklog behaviour, sync procedure, Keeper
README.md                         install and Keeper setup
test/helpers.mjs                  temp roots and transcript fixtures
test/*.test.mjs                   one test file per lib module
```

Shared data shapes, used across tasks:

```js
// SessionInfo (Task 2)
{ file, sessionId, cwd, gitBranch, firstAt, lastAt, aiTitle, lastPrompt,
  prUrls: string[], userPromptCount, recentPrompts: string[], lastAssistantText }

// Pending Update (Task 5)
{ id, at, kind: 'session-end' | 'turn' | 'compact', sessionId, cwd, transcriptPath, reason? }

// Draft (Task 8)
{ id, title, ticket, ticketUrl, branch, cwd, firstActiveAt, lastActiveAt,
  sessions: [{ id, lastAt, aiTitle }], sessionFiles: string[], prUrl, inferredStatus,
  where: { displayName, path, resumeCommand },
  digest: { aiTitle, lastPrompt, recentPrompts, lastAssistantText } }

// Row = artifact db document workItems/<id> (Task 9)
{ title, titleOverride, ticket, ticketUrl, branch, cwd, firstActiveAt, lastActiveAt,
  sessions, prUrl, where, inferredStatus, statusOverride, status, phrase,
  archivePath, archivedAt, deleted, updatedAt }
```

---

### Task 1: Plugin scaffold and paths

**Files:**
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `package.json`, `lib/paths.mjs`
- Test: `test/paths.test.mjs`

**Interfaces:**
- Produces: `worklogHome(env)`, `claudeProjectsDir(env)`, `pendingFile(env)`, `stateFile(env)`, `configFile(env)`, `transcriptsDir(env)`, `projectDirFor(cwd, env)`, `readJson(file, fallback)`, `writeJson(file, data)`. Every `env` parameter defaults to `process.env`.

- [ ] **Step 1: Write manifest files**

`.claude-plugin/plugin.json`:
```json
{
  "name": "worklog",
  "description": "Keeps a private Worklog artifact of every Work Item done with Claude: its Status, a one-phrase State, and where to find it.",
  "version": "0.1.0",
  "author": { "name": "Ricardo Moraleida" },
  "license": "UNLICENSED",
  "keywords": ["worklog", "sessions", "artifact", "orca"]
}
```

`.claude-plugin/marketplace.json`:
```json
{
  "name": "worklog-local",
  "owner": { "name": "Ricardo Moraleida" },
  "plugins": [
    { "name": "worklog", "source": "./", "description": "Private Worklog of Work Items done with Claude." }
  ]
}
```

`package.json`:
```json
{
  "name": "worklog",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": { "test": "node --test test/" }
}
```

- [ ] **Step 2: Write the failing test** — `test/paths.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { worklogHome, claudeProjectsDir, pendingFile, projectDirFor, readJson, writeJson } from '../lib/paths.mjs';

test('roots honour env overrides', () => {
  const env = { WORKLOG_HOME: '/tmp/wl', WORKLOG_CLAUDE_PROJECTS: '/tmp/projects' };
  assert.equal(worklogHome(env), '/tmp/wl');
  assert.equal(claudeProjectsDir(env), '/tmp/projects');
  assert.equal(pendingFile(env), '/tmp/wl/pending.jsonl');
});

test('roots default under the home directory', () => {
  assert.equal(worklogHome({}), path.join(os.homedir(), 'worklog'));
  assert.equal(claudeProjectsDir({}), path.join(os.homedir(), '.claude', 'projects'));
});

test('projectDirFor matches Claude Code project directory naming', () => {
  const env = { WORKLOG_CLAUDE_PROJECTS: '/p' };
  assert.equal(
    projectDirFor('/Users/moraleida/orca/workspaces/general/work-tracking-skill', env),
    '/p/-Users-moraleida-orca-workspaces-general-work-tracking-skill',
  );
});

test('readJson falls back on missing or corrupt files; writeJson creates parents', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-paths-'));
  const file = path.join(dir, 'nested', 'x.json');
  assert.deepEqual(readJson(file, { a: 1 }), { a: 1 });
  writeJson(file, { b: 2 });
  assert.deepEqual(readJson(file, null), { b: 2 });
  fs.writeFileSync(file, '{nope');
  assert.deepEqual(readJson(file, []), []);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test test/paths.test.mjs`
Expected: FAIL with `Cannot find module '.../lib/paths.mjs'`.

- [ ] **Step 4: Implement** — `lib/paths.mjs`

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function worklogHome(env = process.env) {
  return env.WORKLOG_HOME || path.join(os.homedir(), 'worklog');
}

export function claudeProjectsDir(env = process.env) {
  return env.WORKLOG_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
}

export const pendingFile = (env = process.env) => path.join(worklogHome(env), 'pending.jsonl');
export const stateFile = (env = process.env) => path.join(worklogHome(env), 'state.json');
export const configFile = (env = process.env) => path.join(worklogHome(env), 'config.json');
export const transcriptsDir = (env = process.env) => path.join(worklogHome(env), 'transcripts');

export function projectDirFor(cwd, env = process.env) {
  return path.join(claudeProjectsDir(env), cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/paths.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin package.json lib/paths.mjs test/paths.test.mjs
git commit -m "feat: scaffold worklog plugin and storage paths" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Transcript parsing

**Files:**
- Create: `lib/transcript.mjs`, `test/helpers.mjs`
- Test: `test/transcript.test.mjs`

**Interfaces:**
- Consumes: `projectDirFor(cwd, env)` from Task 1 (in helpers).
- Produces: `userText(message) → string | null`, `parseSessionLines(lines: string[]) → SessionInfo | null`, `readSessionFile(file) → SessionInfo | null`. Test helpers: `tmpEnv() → { root, env }`, `sessionLines(opts) → string[]`, `writeSession(env, cwd, sessionId, lines) → filePath`.

Transcript facts (verified on this machine): each line is one JSON object. `user`/`assistant` lines carry `sessionId`, `cwd`, `gitBranch`, `timestamp`, `isSidechain`, optional `isMeta`, and `message.content` (a string, or an array of parts: `text`, `tool_use`, `tool_result`). Other line types used here: `{"type":"ai-title","aiTitle":…}` (written many times; the last wins), `{"type":"last-prompt","lastPrompt":…}`, `{"type":"pr-link","prUrl":…,"prNumber":…}`.

- [ ] **Step 1: Write test helpers** — `test/helpers.mjs`

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectDirFor } from '../lib/paths.mjs';

export function tmpEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-test-'));
  return {
    root,
    env: { WORKLOG_HOME: path.join(root, 'home'), WORKLOG_CLAUDE_PROJECTS: path.join(root, 'projects') },
  };
}

export function sessionLines({ sessionId, cwd, branch = 'feature/x', prompts = ['do the thing'], start = '2026-09-28T10:00:00.000Z', aiTitle = null, prUrl = null }) {
  const lines = [];
  let t = Date.parse(start);
  const at = () => new Date((t += 60_000)).toISOString();
  for (const prompt of prompts) {
    lines.push(JSON.stringify({ type: 'user', sessionId, cwd, gitBranch: branch, timestamp: at(), isSidechain: false, message: { role: 'user', content: prompt } }));
    lines.push(JSON.stringify({ type: 'assistant', sessionId, cwd, gitBranch: branch, timestamp: at(), isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: `done: ${prompt}` }, { type: 'tool_use', name: 'Bash', input: {} }] } }));
  }
  if (aiTitle) lines.push(JSON.stringify({ type: 'ai-title', aiTitle, sessionId }));
  if (prUrl) lines.push(JSON.stringify({ type: 'pr-link', sessionId, prNumber: 1, prUrl, timestamp: at() }));
  return lines;
}

export function writeSession(env, cwd, sessionId, lines) {
  const dir = projectDirFor(cwd, env);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}
```

- [ ] **Step 2: Write the failing test** — `test/transcript.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userText, parseSessionLines, readSessionFile } from '../lib/transcript.mjs';
import { tmpEnv, sessionLines, writeSession } from './helpers.mjs';

test('userText reads strings and text parts, ignores tool results', () => {
  assert.equal(userText({ content: 'hi' }), 'hi');
  assert.equal(userText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(userText({ content: [{ type: 'tool_result', content: 'x' }] }), null);
  assert.equal(userText({ content: '   ' }), null);
});

test('parseSessionLines extracts identity, timing, titles and PR links', () => {
  const lines = sessionLines({ sessionId: 's1', cwd: '/w/a', branch: 'fix/9/bug', prompts: ['one', 'two'], aiTitle: 'Fix bug', prUrl: 'https://github.com/o/r/pull/1' });
  const info = parseSessionLines(lines);
  assert.equal(info.sessionId, 's1');
  assert.equal(info.cwd, '/w/a');
  assert.equal(info.gitBranch, 'fix/9/bug');
  assert.equal(info.userPromptCount, 2);
  assert.deepEqual(info.recentPrompts, ['one', 'two']);
  assert.equal(info.lastAssistantText, 'done: two');
  assert.equal(info.aiTitle, 'Fix bug');
  assert.deepEqual(info.prUrls, ['https://github.com/o/r/pull/1']);
  assert.ok(info.firstAt < info.lastAt);
});

test('parseSessionLines skips malformed lines, sidechains and meta lines', () => {
  const lines = [
    '{not json',
    JSON.stringify({ type: 'user', sessionId: 's2', cwd: '/w', gitBranch: 'main', timestamp: '2026-09-01T00:00:00.000Z', isSidechain: true, message: { content: 'side' } }),
    JSON.stringify({ type: 'user', sessionId: 's2', cwd: '/w', gitBranch: 'main', timestamp: '2026-09-01T00:01:00.000Z', isMeta: true, message: { content: 'meta' } }),
    JSON.stringify({ type: 'user', sessionId: 's2', cwd: '/w', gitBranch: 'main', timestamp: '2026-09-01T00:02:00.000Z', message: { content: 'real' } }),
  ];
  const info = parseSessionLines(lines);
  assert.equal(info.userPromptCount, 1);
  assert.deepEqual(info.recentPrompts, ['real']);
});

test('parseSessionLines returns null for a session with no conversation', () => {
  assert.equal(parseSessionLines([JSON.stringify({ type: 'ai-title', aiTitle: 'x', sessionId: 's' })]), null);
});

test('long prompts are clipped and only the last five kept', () => {
  const prompts = ['p1', 'p2', 'p3', 'p4', 'p5', 'x'.repeat(1000)];
  const info = parseSessionLines(sessionLines({ sessionId: 's', cwd: '/w', prompts }));
  assert.equal(info.recentPrompts.length, 5);
  assert.equal(info.recentPrompts[0], 'p2');
  assert.ok(info.recentPrompts[4].length <= 300);
});

test('readSessionFile records its path and tolerates unreadable files', () => {
  const { env } = tmpEnv();
  const file = writeSession(env, '/w/b', 's3', sessionLines({ sessionId: 's3', cwd: '/w/b' }));
  assert.equal(readSessionFile(file).file, file);
  assert.equal(readSessionFile('/nonexistent/x.jsonl'), null);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test test/transcript.test.mjs`
Expected: FAIL with `Cannot find module '.../lib/transcript.mjs'`.

- [ ] **Step 4: Implement** — `lib/transcript.mjs`

```js
import fs from 'node:fs';

const PROMPT_LIMIT = 300;
const ASSISTANT_LIMIT = 600;
const RECENT_PROMPTS = 5;

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function textParts(content) {
  if (!Array.isArray(content)) return null;
  const texts = content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text);
  return texts.length ? texts.join('\n').trim() || null : null;
}

export function userText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.trim() || null;
  return textParts(content);
}

export function parseSessionLines(lines) {
  const info = {
    file: null, sessionId: null, cwd: null, gitBranch: '', firstAt: null, lastAt: null,
    aiTitle: null, lastPrompt: null, prUrls: [], userPromptCount: 0, recentPrompts: [], lastAssistantText: null,
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.sessionId && !info.sessionId) info.sessionId = entry.sessionId;
    if (entry.type === 'ai-title' && entry.aiTitle) info.aiTitle = entry.aiTitle;
    if (entry.type === 'last-prompt' && entry.lastPrompt) info.lastPrompt = entry.lastPrompt;
    if (entry.type === 'pr-link' && entry.prUrl && !info.prUrls.includes(entry.prUrl)) info.prUrls.push(entry.prUrl);
    if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isSidechain) continue;
    if (entry.cwd) info.cwd = entry.cwd;
    if (entry.gitBranch) info.gitBranch = entry.gitBranch;
    if (entry.timestamp) {
      info.firstAt ??= entry.timestamp;
      info.lastAt = entry.timestamp;
    }
    if (entry.type === 'user' && !entry.isMeta) {
      const text = userText(entry.message);
      if (!text) continue;
      info.userPromptCount++;
      info.recentPrompts.push(clip(text, PROMPT_LIMIT));
      if (info.recentPrompts.length > RECENT_PROMPTS) info.recentPrompts.shift();
    } else if (entry.type === 'assistant') {
      const text = textParts(entry.message?.content);
      if (text) info.lastAssistantText = clip(text, ASSISTANT_LIMIT);
    }
  }
  if (!info.sessionId || !info.cwd || !info.firstAt) return null;
  return info;
}

export function readSessionFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const info = parseSessionLines(text.split('\n'));
  if (info) info.file = file;
  return info;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/transcript.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/transcript.mjs test/helpers.mjs test/transcript.test.mjs
git commit -m "feat: parse Claude Code session transcripts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Work Item identity, Title and ticket links

**Files:**
- Create: `lib/workitem.mjs`
- Test: `test/workitem.test.mjs`

**Interfaces:**
- Consumes: `SessionInfo` from Task 2.
- Produces: `DEFAULT_BRANCHES: Set<string>`, `normalizeBranch(branch) → string`, `workItemId(cwd, branch) → 'wi_<12 hex>'`, `deriveTitle(branch, cwd, home?) → { title, ticket | null }`, `ticketUrl(ticket, { jiraBaseUrl, githubRepo }) → string | null`, `parseGithubRemote(url) → 'owner/repo' | null`, `groupSessions(sessions) → Map<id, { id, cwd, branch, sessions }>` (sessions sorted oldest first by `lastAt`), `resumeCommand(cwd, sessionId) → string`.

- [ ] **Step 1: Write the failing test** — `test/workitem.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBranch, workItemId, deriveTitle, ticketUrl, parseGithubRemote, groupSessions, resumeCommand } from '../lib/workitem.mjs';

test('normalizeBranch strips refs and detached HEAD', () => {
  assert.equal(normalizeBranch('refs/heads/feature/a'), 'feature/a');
  assert.equal(normalizeBranch('HEAD'), '');
  assert.equal(normalizeBranch(undefined), '');
});

test('workItemId is stable per worktree and branch', () => {
  assert.equal(workItemId('/w', 'feature/a'), workItemId('/w', 'refs/heads/feature/a'));
  assert.notEqual(workItemId('/w', 'feature/a'), workItemId('/w', 'feature/b'));
  assert.match(workItemId('/w', ''), /^wi_[0-9a-f]{12}$/);
});

test('deriveTitle follows the branch naming rules', () => {
  assert.deepEqual(deriveTitle('fix/16563/expired-token-refresh', '/w'), { title: 'Expired token refresh', ticket: '16563' });
  assert.deepEqual(deriveTitle('feature/NYP-3322/reviewer-assignment', '/w'), { title: 'Reviewer assignment', ticket: 'NYP-3322' });
  assert.deepEqual(deriveTitle('feature/worklog-plugin', '/w'), { title: 'Worklog plugin', ticket: null });
  assert.deepEqual(deriveTitle('work-tracking-skill', '/w'), { title: 'Work tracking skill', ticket: null });
});

test('deriveTitle names default-branch and branchless work after the place', () => {
  assert.deepEqual(deriveTitle('main', '/dev/ncu-gtf-local'), { title: 'ncu-gtf-local · main', ticket: null });
  assert.deepEqual(deriveTitle('', '/Users/me', '/Users/me'), { title: '~', ticket: null });
  assert.deepEqual(deriveTitle('', '/Users/me/notes', '/Users/me'), { title: 'notes', ticket: null });
});

test('ticketUrl links Jira keys and GitHub issue numbers when configured', () => {
  assert.equal(ticketUrl('NYP-3322', { jiraBaseUrl: 'https://x.atlassian.net/' }), 'https://x.atlassian.net/browse/NYP-3322');
  assert.equal(ticketUrl('16563', { githubRepo: 'o/r' }), 'https://github.com/o/r/issues/16563');
  assert.equal(ticketUrl('NYP-3322', {}), null);
  assert.equal(ticketUrl(null, { githubRepo: 'o/r' }), null);
});

test('parseGithubRemote handles ssh and https remotes', () => {
  assert.equal(parseGithubRemote('git@github.com:alleyinteractive/apm.git'), 'alleyinteractive/apm');
  assert.equal(parseGithubRemote('https://github.com/alleyinteractive/apm'), 'alleyinteractive/apm');
  assert.equal(parseGithubRemote('https://gitlab.com/a/b.git'), null);
});

test('groupSessions groups by worktree and branch, oldest first', () => {
  const s = (id, cwd, gitBranch, lastAt) => ({ sessionId: id, cwd, gitBranch, lastAt });
  const groups = groupSessions([s('b', '/w', 'feature/a', '2026-09-02'), s('a', '/w', 'feature/a', '2026-09-01'), s('c', '/w', 'feature/z', '2026-09-03')]);
  assert.equal(groups.size, 2);
  const a = groups.get(workItemId('/w', 'feature/a'));
  assert.deepEqual(a.sessions.map((x) => x.sessionId), ['a', 'b']);
  assert.equal(a.branch, 'feature/a');
});

test('resumeCommand quotes paths safely', () => {
  assert.equal(resumeCommand("/w/it's", 's1'), "cd '/w/it'\\''s' && claude --resume s1");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/workitem.test.mjs`
Expected: FAIL with `Cannot find module '.../lib/workitem.mjs'`.

- [ ] **Step 3: Implement** — `lib/workitem.mjs`

```js
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'trunk']);
const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const NUMERIC = /^\d+$/;

export function normalizeBranch(branch) {
  if (!branch) return '';
  const b = branch.replace(/^refs\/heads\//, '');
  return b === 'HEAD' ? '' : b;
}

export function workItemId(cwd, branch) {
  const hash = crypto.createHash('sha1').update(`${cwd}\0${normalizeBranch(branch)}`).digest('hex');
  return `wi_${hash.slice(0, 12)}`;
}

function humanize(segment) {
  const words = segment.replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}

function placeName(cwd, home) {
  return cwd === home ? '~' : path.basename(cwd);
}

export function deriveTitle(branch, cwd, home = os.homedir()) {
  const b = normalizeBranch(branch);
  if (!b) return { title: placeName(cwd, home), ticket: null };
  if (DEFAULT_BRANCHES.has(b)) return { title: `${placeName(cwd, home)} · ${b}`, ticket: null };
  const segments = b.split('/').filter(Boolean);
  const ticket = segments.slice(0, -1).find((s) => JIRA_KEY.test(s) || NUMERIC.test(s)) ?? null;
  return { title: humanize(segments[segments.length - 1]), ticket };
}

export function ticketUrl(ticket, { jiraBaseUrl = null, githubRepo = null } = {}) {
  if (!ticket) return null;
  if (JIRA_KEY.test(ticket) && jiraBaseUrl) return `${jiraBaseUrl.replace(/\/+$/, '')}/browse/${ticket}`;
  if (NUMERIC.test(ticket) && githubRepo) return `https://github.com/${githubRepo}/issues/${ticket}`;
  return null;
}

export function parseGithubRemote(url) {
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url ?? '');
  return match ? match[1] : null;
}

export function groupSessions(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    const branch = normalizeBranch(session.gitBranch);
    const id = workItemId(session.cwd, branch);
    if (!groups.has(id)) groups.set(id, { id, cwd: session.cwd, branch, sessions: [] });
    groups.get(id).sessions.push(session);
  }
  for (const group of groups.values()) group.sessions.sort((a, b) => a.lastAt.localeCompare(b.lastAt));
  return groups;
}

const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

export function resumeCommand(cwd, sessionId) {
  return `cd ${shellQuote(cwd)} && claude --resume ${sessionId}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/workitem.test.mjs`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/workitem.mjs test/workitem.test.mjs
git commit -m "feat: derive Work Item identity, Title and ticket links" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Status rules

**Files:**
- Create: `lib/status.mjs`
- Test: `test/status.test.mjs`

**Interfaces:**
- Produces: `STATUSES: string[]`, `inferStatus({ prState, worktreeExists }) → status`, `effectiveStatus(inferred, override) → status`, `isFinished(status) → boolean`, `parseStatusArg(arg) → status | null`. `prState` is `'OPEN' | 'MERGED' | 'CLOSED' | null`.

- [ ] **Step 1: Write the failing test** — `test/status.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUSES, inferStatus, effectiveStatus, isFinished, parseStatusArg } from '../lib/status.mjs';

test('the vocabulary is exactly the agreed five', () => {
  assert.deepEqual(STATUSES, ['in progress', 'blocked', 'awaiting review', 'done', 'abandoned']);
});

test('only strong evidence moves a Work Item past in progress', () => {
  assert.equal(inferStatus({ prState: 'MERGED', worktreeExists: true }), 'done');
  assert.equal(inferStatus({ prState: null, worktreeExists: false }), 'done');
  assert.equal(inferStatus({ prState: 'OPEN', worktreeExists: true }), 'awaiting review');
  assert.equal(inferStatus({ prState: 'CLOSED', worktreeExists: true }), 'in progress');
  assert.equal(inferStatus({ prState: null, worktreeExists: true }), 'in progress');
});

test('a Status Override always wins', () => {
  assert.equal(effectiveStatus('done', 'blocked'), 'blocked');
  assert.equal(effectiveStatus('done', null), 'done');
});

test('finished means done or abandoned', () => {
  assert.equal(isFinished('done'), true);
  assert.equal(isFinished('abandoned'), true);
  assert.equal(isFinished('awaiting review'), false);
});

test('parseStatusArg accepts spaced, hyphenated and cased forms', () => {
  assert.equal(parseStatusArg('Awaiting-Review'), 'awaiting review');
  assert.equal(parseStatusArg('in_progress'), 'in progress');
  assert.equal(parseStatusArg('blocked'), 'blocked');
  assert.equal(parseStatusArg('finished'), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/status.test.mjs`
Expected: FAIL with `Cannot find module '.../lib/status.mjs'`.

- [ ] **Step 3: Implement** — `lib/status.mjs`

```js
export const STATUSES = ['in progress', 'blocked', 'awaiting review', 'done', 'abandoned'];

export function inferStatus({ prState = null, worktreeExists = true } = {}) {
  if (prState === 'MERGED' || !worktreeExists) return 'done';
  if (prState === 'OPEN') return 'awaiting review';
  return 'in progress';
}

export const effectiveStatus = (inferred, override) => override ?? inferred;

export const isFinished = (status) => status === 'done' || status === 'abandoned';

export function parseStatusArg(arg) {
  const normalized = String(arg ?? '').trim().toLowerCase().replace(/[-_]+/g, ' ');
  return STATUSES.includes(normalized) ? normalized : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/status.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/status.mjs test/status.test.mjs
git commit -m "feat: add Status vocabulary and inference rules" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Pending Update store

**Files:**
- Create: `lib/pending.mjs`
- Test: `test/pending.test.mjs`

**Interfaces:**
- Consumes: `pendingFile(env)`, `worklogHome(env)` from Task 1.
- Produces: `appendPending(event, env?, now?) → record`, `readPending(env?) → record[]`, `isDebounced(events, sessionId, now?, windowMs?) → boolean`, `claimPending(env?, now?) → { claimFiles: string[], events: record[] }`, `releaseClaims(claimFiles)`.

The Keeper claims by renaming `pending.jsonl` to `pending-<ms>-<pid>.claimed.jsonl`. Hooks keep appending to a fresh `pending.jsonl`, so nothing recorded during a sync is lost (Review Focus 2). Claimed files left by a crashed sync are picked up again on the next claim.

- [ ] **Step 1: Write the failing test** — `test/pending.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appendPending, readPending, isDebounced, claimPending, releaseClaims } from '../lib/pending.mjs';
import { pendingFile } from '../lib/paths.mjs';
import { tmpEnv } from './helpers.mjs';

test('appendPending records id and time; readPending skips corrupt lines', () => {
  const { env } = tmpEnv();
  const rec = appendPending({ kind: 'turn', sessionId: 's1' }, env, new Date('2026-09-30T10:00:00Z'));
  fs.appendFileSync(pendingFile(env), '{broken\n');
  const events = readPending(env);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, rec.id);
  assert.equal(events[0].at, '2026-09-30T10:00:00.000Z');
});

test('readPending on a fresh home returns nothing', () => {
  assert.deepEqual(readPending(tmpEnv().env), []);
});

test('isDebounced only within the window for the same Session', () => {
  const events = [{ sessionId: 's1', at: '2026-09-30T10:00:00.000Z' }];
  assert.equal(isDebounced(events, 's1', new Date('2026-09-30T10:01:00Z')), true);
  assert.equal(isDebounced(events, 's1', new Date('2026-09-30T10:03:00Z')), false);
  assert.equal(isDebounced(events, 's2', new Date('2026-09-30T10:01:00Z')), false);
});

test('updates appended during a sync survive releasing the claim', () => {
  const { env } = tmpEnv();
  appendPending({ kind: 'session-end', sessionId: 'old' }, env);
  const claim = claimPending(env);
  assert.deepEqual(claim.events.map((e) => e.sessionId), ['old']);
  appendPending({ kind: 'turn', sessionId: 'new' }, env);
  releaseClaims(claim.claimFiles);
  assert.deepEqual(readPending(env).map((e) => e.sessionId), ['new']);
  assert.deepEqual(claimPending(env).events.map((e) => e.sessionId), ['new']);
});

test('an unreleased claim is picked up again by the next claim', () => {
  const { env } = tmpEnv();
  appendPending({ kind: 'turn', sessionId: 'a' }, env);
  claimPending(env);
  appendPending({ kind: 'turn', sessionId: 'b' }, env);
  const again = claimPending(env);
  assert.deepEqual(again.events.map((e) => e.sessionId).sort(), ['a', 'b']);
  assert.equal(again.claimFiles.length, 2);
});

test('claimPending with no home directory returns an empty claim', () => {
  assert.deepEqual(claimPending(tmpEnv().env), { claimFiles: [], events: [] });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/pending.test.mjs`
Expected: FAIL with `Cannot find module '.../lib/pending.mjs'`.

- [ ] **Step 3: Implement** — `lib/pending.mjs`

```js
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pendingFile, worklogHome } from './paths.mjs';

const CLAIM_SUFFIX = '.claimed.jsonl';

function readEventsFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

export function appendPending(event, env = process.env, now = new Date()) {
  const file = pendingFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = { id: crypto.randomUUID(), at: now.toISOString(), ...event };
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
  return record;
}

export const readPending = (env = process.env) => readEventsFile(pendingFile(env));

export function isDebounced(events, sessionId, now = new Date(), windowMs = 120_000) {
  return events.some((e) => e.sessionId === sessionId && now.getTime() - Date.parse(e.at) < windowMs);
}

export function claimPending(env = process.env, now = new Date()) {
  const home = worklogHome(env);
  const file = pendingFile(env);
  if (fs.existsSync(file)) fs.renameSync(file, path.join(home, `pending-${now.getTime()}-${process.pid}${CLAIM_SUFFIX}`));
  let names;
  try {
    names = fs.readdirSync(home);
  } catch {
    return { claimFiles: [], events: [] };
  }
  const claimFiles = names.filter((n) => n.endsWith(CLAIM_SUFFIX)).sort().map((n) => path.join(home, n));
  const seen = new Set();
  const events = [];
  for (const claimFile of claimFiles) {
    for (const event of readEventsFile(claimFile)) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      events.push(event);
    }
  }
  return { claimFiles, events };
}

export function releaseClaims(claimFiles) {
  for (const file of claimFiles) fs.rmSync(file, { force: true });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/pending.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/pending.mjs test/pending.test.mjs
git commit -m "feat: store Pending Updates with claim-by-rename" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: External lookups (Orca, git, gh)

**Files:**
- Create: `lib/external.mjs`
- Test: `test/external.test.mjs`

**Interfaces:**
- Consumes: `normalizeBranch`, `parseGithubRemote` from Task 3.
- Produces: `defaultExec(cmd, args, { cwd, timeout }) → stdout string` (throws on failure), `listOrcaWorktrees(exec?) → [{ path, branch, displayName, isArchived }]`, `findWorktree(worktrees, cwd) → worktree | null`, `prState(prUrl, exec?) → 'OPEN' | 'MERGED' | 'CLOSED' | null`, `githubRepoFor(cwd, exec?) → 'owner/repo' | null`, `currentBranch(cwd, exec?) → string`. Every lookup returns its empty value when the command fails, so a missing `orca` or `gh` never breaks a sync.

Facts: `orca worktree list --json` returns `{ result: { worktrees: [{ path, branch: "refs/heads/…", displayName, isArchived, linkedPR: <number|null>, … }] } }`. `linkedPR` is a number, not a URL, so PR URLs come from transcript `pr-link` lines instead.

- [ ] **Step 1: Write the failing test** — `test/external.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listOrcaWorktrees, findWorktree, prState, githubRepoFor, currentBranch } from '../lib/external.mjs';

const fakeExec = (answers) => (cmd, args) => {
  const key = [cmd, ...args].join(' ');
  if (!(key in answers)) throw new Error(`unexpected: ${key}`);
  return answers[key];
};
const failing = () => { throw new Error('command not found'); };

test('listOrcaWorktrees normalizes Orca JSON and survives failure', () => {
  const exec = fakeExec({ 'orca worktree list --json': JSON.stringify({ result: { worktrees: [{ path: '/w/a', branch: 'refs/heads/feature/a', displayName: 'a', isArchived: false }] } }) });
  assert.deepEqual(listOrcaWorktrees(exec), [{ path: '/w/a', branch: 'feature/a', displayName: 'a', isArchived: false }]);
  assert.deepEqual(listOrcaWorktrees(failing), []);
  assert.deepEqual(listOrcaWorktrees(fakeExec({ 'orca worktree list --json': 'garbage' })), []);
});

test('findWorktree picks the deepest worktree containing cwd', () => {
  const wts = [{ path: '/w' }, { path: '/w/a' }, { path: '/w/ab' }];
  assert.equal(findWorktree(wts, '/w/a/src').path, '/w/a');
  assert.equal(findWorktree(wts, '/w/a').path, '/w/a');
  assert.equal(findWorktree(wts, '/elsewhere'), null);
});

test('prState reads gh and rejects unknown output', () => {
  const url = 'https://github.com/o/r/pull/1';
  assert.equal(prState(url, fakeExec({ [`gh pr view ${url} --json state -q .state`]: 'MERGED\n' })), 'MERGED');
  assert.equal(prState(url, fakeExec({ [`gh pr view ${url} --json state -q .state`]: 'weird' })), null);
  assert.equal(prState(url, failing), null);
  assert.equal(prState(null, failing), null);
});

test('githubRepoFor and currentBranch use git in the given directory', () => {
  const exec = fakeExec({
    'git -C /w remote get-url origin': 'git@github.com:o/r.git\n',
    'git -C /w rev-parse --abbrev-ref HEAD': 'feature/a\n',
  });
  assert.equal(githubRepoFor('/w', exec), 'o/r');
  assert.equal(currentBranch('/w', exec), 'feature/a');
  assert.equal(currentBranch('/w', failing), '');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/external.test.mjs`
Expected: FAIL with `Cannot find module '.../lib/external.mjs'`.

- [ ] **Step 3: Implement** — `lib/external.mjs`

```js
import { execFileSync } from 'node:child_process';
import { normalizeBranch, parseGithubRemote } from './workitem.mjs';

export function defaultExec(cmd, args, { cwd, timeout = 8000 } = {}) {
  return execFileSync(cmd, args, { cwd, timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function tryExec(exec, cmd, args) {
  try {
    return exec(cmd, args);
  } catch {
    return null;
  }
}

export function listOrcaWorktrees(exec = defaultExec) {
  const out = tryExec(exec, 'orca', ['worktree', 'list', '--json']);
  if (!out) return [];
  try {
    return (JSON.parse(out).result?.worktrees ?? []).map((w) => ({
      path: w.path,
      branch: normalizeBranch(w.branch),
      displayName: w.displayName ?? null,
      isArchived: Boolean(w.isArchived),
    }));
  } catch {
    return [];
  }
}

export function findWorktree(worktrees, cwd) {
  let best = null;
  for (const w of worktrees) {
    if (!w.path || (cwd !== w.path && !cwd.startsWith(w.path + '/'))) continue;
    if (!best || w.path.length > best.path.length) best = w;
  }
  return best;
}

export function prState(prUrl, exec = defaultExec) {
  if (!prUrl) return null;
  const state = tryExec(exec, 'gh', ['pr', 'view', prUrl, '--json', 'state', '-q', '.state'])?.trim();
  return ['OPEN', 'MERGED', 'CLOSED'].includes(state) ? state : null;
}

export function githubRepoFor(cwd, exec = defaultExec) {
  return parseGithubRemote(tryExec(exec, 'git', ['-C', cwd, 'remote', 'get-url', 'origin'])?.trim());
}

export function currentBranch(cwd, exec = defaultExec) {
  const out = tryExec(exec, 'git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
  return out ? normalizeBranch(out.trim()) : '';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/external.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/external.mjs test/external.test.mjs
git commit -m "feat: look up Orca worktrees, PR state and branches" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Archived Transcripts

**Files:**
- Create: `lib/archive.mjs`
- Test: `test/archive.test.mjs`

**Interfaces:**
- Consumes: `userText` (Task 2), `normalizeBranch` (Task 3), `transcriptsDir(env)` (Task 1).
- Produces: `renderTranscriptMarkdown(lines, { title, sessionId }) → string`, `archiveSlug(branch, cwd) → string`, `archiveWorkItem({ title, branch, cwd, sessionFiles, now?, env? }) → dirPath`.

- [ ] **Step 1: Write the failing test** — `test/archive.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderTranscriptMarkdown, archiveSlug, archiveWorkItem } from '../lib/archive.mjs';
import { transcriptsDir } from '../lib/paths.mjs';
import { tmpEnv, sessionLines, writeSession } from './helpers.mjs';

test('markdown shows prompts and replies, collapses tools, merges consecutive replies', () => {
  const lines = sessionLines({ sessionId: 's1', cwd: '/w', prompts: ['first ask'] });
  lines.push(JSON.stringify({ type: 'assistant', sessionId: 's1', message: { content: [{ type: 'text', text: 'more' }] } }));
  lines.push(JSON.stringify({ type: 'user', sessionId: 's1', message: { content: [{ type: 'tool_result', content: 'SECRET OUTPUT' }] } }));
  const md = renderTranscriptMarkdown(lines, { title: 'Worklog plugin', sessionId: 's1' });
  assert.match(md, /^# Worklog plugin/);
  assert.match(md, /## You/);
  assert.match(md, /first ask/);
  assert.match(md, /> 🔧 Bash/);
  assert.equal(md.match(/## Claude/g).length, 1);
  assert.doesNotMatch(md, /SECRET OUTPUT/);
});

test('archiveSlug comes from the branch, else the folder', () => {
  assert.equal(archiveSlug('feature/NYP-3322/reviewer-assignment', '/w'), 'feature-nyp-3322-reviewer-assignment');
  assert.equal(archiveSlug('', '/Users/me/notes'), 'notes');
});

test('archiveWorkItem writes markdown and raw jsonl per Session', () => {
  const { env } = tmpEnv();
  const file = writeSession(env, '/w/a', 's9', sessionLines({ sessionId: 's9', cwd: '/w/a' }));
  const dir = archiveWorkItem({ title: 'A', branch: 'fix/a', cwd: '/w/a', sessionFiles: [file], now: new Date('2026-10-01T12:00:00Z'), env });
  assert.equal(dir, path.join(transcriptsDir(env), '2026-10-01-fix-a'));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['s9.jsonl', 's9.md']);
  assert.equal(fs.readFileSync(path.join(dir, 's9.jsonl'), 'utf8'), fs.readFileSync(file, 'utf8'));
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/archive.test.mjs`
Expected: FAIL with `Cannot find module '.../lib/archive.mjs'`.

- [ ] **Step 3: Implement** — `lib/archive.mjs`

```js
import fs from 'node:fs';
import path from 'node:path';
import { userText } from './transcript.mjs';
import { normalizeBranch } from './workitem.mjs';
import { transcriptsDir } from './paths.mjs';

export function renderTranscriptMarkdown(lines, { title, sessionId }) {
  const out = [`# ${title}`, '', `Session \`${sessionId}\``, ''];
  let lastRole = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.isSidechain || entry.isMeta) continue;
    if (entry.type === 'user') {
      const text = userText(entry.message);
      if (!text) continue;
      out.push(`## You${entry.timestamp ? ` · ${entry.timestamp}` : ''}`, '', text, '');
      lastRole = 'user';
    } else if (entry.type === 'assistant') {
      const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
      const texts = content.filter((p) => p?.type === 'text').map((p) => p.text);
      const tools = content.filter((p) => p?.type === 'tool_use').map((p) => `> 🔧 ${p.name}`);
      if (!texts.length && !tools.length) continue;
      if (lastRole !== 'assistant') out.push('## Claude', '');
      if (texts.length) out.push(texts.join('\n'), '');
      if (tools.length) out.push(...tools, '');
      lastRole = 'assistant';
    }
  }
  return out.join('\n');
}

export function archiveSlug(branch, cwd) {
  const base = normalizeBranch(branch) || path.basename(cwd) || 'home';
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function archiveWorkItem({ title, branch, cwd, sessionFiles, now = new Date(), env = process.env }) {
  const dir = path.join(transcriptsDir(env), `${now.toISOString().slice(0, 10)}-${archiveSlug(branch, cwd)}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of sessionFiles) {
    const sessionId = path.basename(file, '.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    fs.writeFileSync(path.join(dir, `${sessionId}.md`), renderTranscriptMarkdown(lines, { title, sessionId }));
    fs.copyFileSync(file, path.join(dir, `${sessionId}.jsonl`));
  }
  return dir;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/archive.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/archive.mjs test/archive.test.mjs
git commit -m "feat: archive finished Work Item transcripts as markdown and jsonl" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Collect drafts

**Files:**
- Create: `lib/collect.mjs`
- Test: `test/collect.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–6 (`projectDirFor`, `claudeProjectsDir`, `configFile`, `readJson`, `readSessionFile`, `groupSessions`, `deriveTitle`, `ticketUrl`, `resumeCommand`, `inferStatus`, `claimPending`, `listOrcaWorktrees`, `findWorktree`, `prState`, `githubRepoFor`).
- Produces: `parseDuration(text) → ms` (`'30d'`, `'12h'`, `'all'` → `Infinity`; anything else throws), `listSessionFiles(dir) → string[]` (top-level `*.jsonl` only, so subagent transcripts are excluded), `collectDrafts({ mode, sinceMs?, cwd?, recheckCwds?, env?, exec? }) → { claimFiles, drafts: Draft[] }`. `mode` is `'pending' | 'since' | 'cwd'`.

Directory rule: a Pending Update with `transcriptPath` points at its project directory. Otherwise its `cwd` maps through `projectDirFor`. Every Session in that directory is read, so the Sessions count is complete.

- [ ] **Step 1: Write the failing test** — `test/collect.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseDuration, listSessionFiles, collectDrafts } from '../lib/collect.mjs';
import { appendPending } from '../lib/pending.mjs';
import { writeJson, configFile } from '../lib/paths.mjs';
import { workItemId } from '../lib/workitem.mjs';
import { tmpEnv, sessionLines, writeSession } from './helpers.mjs';

const exec = (answers = {}) => (cmd, args) => {
  const key = [cmd, ...args].join(' ');
  if (key in answers) return answers[key];
  throw new Error(`no answer for ${key}`);
};

test('parseDuration', () => {
  assert.equal(parseDuration('30d'), 30 * 86_400_000);
  assert.equal(parseDuration('12h'), 12 * 3_600_000);
  assert.equal(parseDuration('all'), Infinity);
  assert.throws(() => parseDuration('soon'), /window/);
});

test('listSessionFiles ignores subagent folders and non-jsonl files', () => {
  const { env, root } = tmpEnv();
  const file = writeSession(env, '/w/a', 's1', sessionLines({ sessionId: 's1', cwd: '/w/a' }));
  const dir = path.dirname(file);
  fs.mkdirSync(path.join(dir, 's1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 's1', 'subagents', 'agent-1.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'notes.txt'), '');
  assert.deepEqual(listSessionFiles(dir), [file]);
  assert.deepEqual(listSessionFiles(path.join(root, 'missing')), []);
});

test('pending mode builds one draft per Work Item with every Session of it', () => {
  const { env, root } = tmpEnv();
  const cwd = path.join(root, 'wt');
  fs.mkdirSync(cwd);
  const pr = 'https://github.com/o/r/pull/7';
  writeSession(env, cwd, 's1', sessionLines({ sessionId: 's1', cwd, branch: 'feature/NYP-1/thing', start: '2026-09-28T10:00:00.000Z' }));
  const f2 = writeSession(env, cwd, 's2', sessionLines({ sessionId: 's2', cwd, branch: 'feature/NYP-1/thing', start: '2026-09-29T10:00:00.000Z', aiTitle: 'Thing', prUrl: pr }));
  appendPending({ kind: 'session-end', sessionId: 's2', cwd, transcriptPath: f2 }, env);
  writeJson(configFile(env), { jiraBaseUrl: 'https://x.atlassian.net' });

  const { claimFiles, drafts } = collectDrafts({
    mode: 'pending', env,
    exec: exec({
      'orca worktree list --json': JSON.stringify({ result: { worktrees: [{ path: cwd, branch: 'refs/heads/feature/NYP-1/thing', displayName: 'thing' }] } }),
      [`gh pr view ${pr} --json state -q .state`]: 'OPEN',
    }),
  });
  assert.equal(claimFiles.length, 1);
  assert.equal(drafts.length, 1);
  const d = drafts[0];
  assert.equal(d.id, workItemId(cwd, 'feature/NYP-1/thing'));
  assert.equal(d.title, 'Thing');
  assert.equal(d.ticket, 'NYP-1');
  assert.equal(d.ticketUrl, 'https://x.atlassian.net/browse/NYP-1');
  assert.deepEqual(d.sessions.map((s) => s.id), ['s1', 's2']);
  assert.equal(d.sessionFiles.length, 2);
  assert.equal(d.prUrl, pr);
  assert.equal(d.inferredStatus, 'awaiting review');
  assert.equal(d.where.displayName, 'thing');
  assert.match(d.where.resumeCommand, /claude --resume s2$/);
  assert.equal(d.digest.aiTitle, 'Thing');
  assert.ok(Array.isArray(d.digest.recentPrompts));
});

test('a removed worktree reads as done; lookups failing never throw', () => {
  const { env, root } = tmpEnv();
  const cwd = path.join(root, 'gone');
  writeSession(env, cwd, 's1', sessionLines({ sessionId: 's1', cwd, branch: 'fix/gone' }));
  const { drafts } = collectDrafts({ mode: 'cwd', cwd, env, exec: exec() });
  assert.equal(drafts[0].inferredStatus, 'done');
  assert.equal(drafts[0].where.displayName, null);
});

test('since mode keeps only Work Items active inside the window', () => {
  const { env, root } = tmpEnv();
  const cwd = path.join(root, 'w');
  fs.mkdirSync(cwd);
  writeSession(env, cwd, 'old', sessionLines({ sessionId: 'old', cwd, branch: 'feature/old', start: '2026-01-01T00:00:00.000Z' }));
  writeSession(env, cwd, 'new', sessionLines({ sessionId: 'new', cwd, branch: 'feature/new', start: '2026-09-30T00:00:00.000Z' }));
  const { drafts } = collectDrafts({ mode: 'since', sinceMs: Date.parse('2026-09-01T00:00:00Z'), env, exec: exec() });
  assert.deepEqual(drafts.map((d) => d.branch), ['feature/new']);
});

test('recheckCwds re-reads open Work Items with no Pending Update', () => {
  const { env, root } = tmpEnv();
  const cwd = path.join(root, 'quiet');
  fs.mkdirSync(cwd);
  writeSession(env, cwd, 's1', sessionLines({ sessionId: 's1', cwd, branch: 'feature/quiet' }));
  const { drafts } = collectDrafts({ mode: 'pending', recheckCwds: [cwd], env, exec: exec() });
  assert.equal(drafts.length, 1);
});

test('unknown mode is rejected', () => {
  assert.throws(() => collectDrafts({ mode: 'everything', env: tmpEnv().env, exec: exec() }), /mode/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/collect.test.mjs`
Expected: FAIL with `Cannot find module '.../lib/collect.mjs'`.

- [ ] **Step 3: Implement** — `lib/collect.mjs`

```js
import fs from 'node:fs';
import path from 'node:path';
import { claudeProjectsDir, configFile, projectDirFor, readJson } from './paths.mjs';
import { readSessionFile } from './transcript.mjs';
import { deriveTitle, groupSessions, resumeCommand, ticketUrl } from './workitem.mjs';
import { inferStatus } from './status.mjs';
import { claimPending } from './pending.mjs';
import { defaultExec, findWorktree, githubRepoFor, listOrcaWorktrees, prState } from './external.mjs';

const UNITS = { d: 86_400_000, h: 3_600_000 };

export function parseDuration(text) {
  if (text === 'all') return Infinity;
  const match = /^(\d+)([dh])$/.exec(String(text ?? ''));
  if (!match) throw new Error(`invalid window "${text}": use e.g. 30d, 12h or all`);
  return Number(match[1]) * UNITS[match[2]];
}

export function listSessionFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

function allProjectDirs(env) {
  const root = claudeProjectsDir(env);
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name));
  } catch {
    return [];
  }
}

function buildDraft(group, { worktrees, config, exec }) {
  const latest = group.sessions[group.sessions.length - 1];
  const prUrl = group.sessions.flatMap((s) => s.prUrls).at(-1) ?? null;
  const { title, ticket } = deriveTitle(group.branch, group.cwd);
  const githubRepo = ticket && /^\d+$/.test(ticket) ? githubRepoFor(group.cwd, exec) : null;
  const worktree = findWorktree(worktrees, group.cwd);
  return {
    id: group.id,
    title,
    ticket,
    ticketUrl: ticketUrl(ticket, { jiraBaseUrl: config.jiraBaseUrl ?? null, githubRepo }),
    branch: group.branch,
    cwd: group.cwd,
    firstActiveAt: group.sessions[0].firstAt,
    lastActiveAt: latest.lastAt,
    sessions: group.sessions.map((s) => ({ id: s.sessionId, lastAt: s.lastAt, aiTitle: s.aiTitle })),
    sessionFiles: group.sessions.map((s) => s.file),
    prUrl,
    inferredStatus: inferStatus({ prState: prState(prUrl, exec), worktreeExists: fs.existsSync(group.cwd) }),
    where: { displayName: worktree?.displayName ?? null, path: group.cwd, resumeCommand: resumeCommand(group.cwd, latest.sessionId) },
    digest: { aiTitle: latest.aiTitle, lastPrompt: latest.lastPrompt, recentPrompts: latest.recentPrompts, lastAssistantText: latest.lastAssistantText },
  };
}

export function collectDrafts({ mode, sinceMs = -Infinity, cwd = null, recheckCwds = [], env = process.env, exec = defaultExec } = {}) {
  let claimFiles = [];
  const dirs = new Set();
  if (mode === 'pending') {
    const claim = claimPending(env);
    claimFiles = claim.claimFiles;
    for (const event of claim.events) {
      if (event.transcriptPath) dirs.add(path.dirname(event.transcriptPath));
      else if (event.cwd) dirs.add(projectDirFor(event.cwd, env));
    }
  } else if (mode === 'since') {
    for (const dir of allProjectDirs(env)) dirs.add(dir);
  } else if (mode === 'cwd') {
    dirs.add(projectDirFor(cwd, env));
  } else {
    throw new Error(`unknown collect mode: ${mode}`);
  }
  for (const c of recheckCwds) dirs.add(projectDirFor(c, env));

  const sessions = [...dirs].flatMap(listSessionFiles).map(readSessionFile).filter(Boolean);
  const context = { worktrees: listOrcaWorktrees(exec), config: readJson(configFile(env), {}), exec };
  let drafts = [...groupSessions(sessions).values()].map((group) => buildDraft(group, context));
  if (mode === 'since') drafts = drafts.filter((d) => Date.parse(d.lastActiveAt) >= sinceMs);
  drafts.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  return { claimFiles, drafts };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/collect.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/collect.mjs test/collect.test.mjs
git commit -m "feat: collect Work Item drafts from transcripts and lookups" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Merge drafts into rows

**Files:**
- Create: `lib/merge.mjs`
- Test: `test/merge.test.mjs`

**Interfaces:**
- Consumes: `effectiveStatus`, `isFinished` (Task 4); `Draft` (Task 8).
- Produces: `mergeRow(draft, existing | null, phrase | undefined, now?) → Row | null` (null when `existing.deleted`), `mergeAll({ drafts, rows, phrases, overrides, archive, now }) → { writes: [{ docId, data: Row }], skipped: string[] }`, `buildStateCache(writes, previous) → { [id]: { title, phrase, status } }`. `rows` is an array of `{ id, ...rowFields }`. `overrides` is `{ [id]: { statusOverride?, titleOverride? } }`. `archive(draft, row) → dirPath`.

- [ ] **Step 1: Write the failing test** — `test/merge.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRow, mergeAll, buildStateCache } from '../lib/merge.mjs';

const NOW = new Date('2026-10-01T12:00:00Z');
const draft = (over = {}) => ({
  id: 'wi_1', title: 'Thing', ticket: null, ticketUrl: null, branch: 'feature/thing', cwd: '/w',
  firstActiveAt: '2026-09-28T10:00:00.000Z', lastActiveAt: '2026-09-30T10:00:00.000Z',
  sessions: [{ id: 's1', lastAt: '2026-09-30T10:00:00.000Z', aiTitle: null }], sessionFiles: ['/p/s1.jsonl'],
  prUrl: null, inferredStatus: 'in progress', where: { displayName: 'thing', path: '/w', resumeCommand: 'cd /w' },
  digest: { recentPrompts: ['secret prompt'] }, ...over,
});
const noArchive = () => { throw new Error('should not archive'); };

test('a new row takes the draft, the phrase, and never the digest', () => {
  const row = mergeRow(draft(), null, 'Building the CLI', NOW);
  assert.equal(row.status, 'in progress');
  assert.equal(row.phrase, 'Building the CLI');
  assert.equal(row.deleted, false);
  assert.equal(row.updatedAt, NOW.toISOString());
  assert.equal('digest' in row, false);
  assert.equal('sessionFiles' in row, false);
});

test('existing phrase and title override are kept when not replaced', () => {
  const row = mergeRow(draft(), { id: 'wi_1', phrase: 'Old', titleOverride: 'Mine' }, undefined, NOW);
  assert.equal(row.phrase, 'Old');
  assert.equal(row.titleOverride, 'Mine');
});

test('a deleted row stays deleted even with new Sessions', () => {
  const { writes, skipped } = mergeAll({ drafts: [draft()], rows: [{ id: 'wi_1', deleted: true }], phrases: { wi_1: 'x' }, archive: noArchive, now: NOW });
  assert.deepEqual(writes, []);
  assert.deepEqual(skipped, ['wi_1']);
});

test('a Status Override wins over a merged PR', () => {
  const { writes } = mergeAll({ drafts: [draft({ inferredStatus: 'done' })], rows: [{ id: 'wi_1', statusOverride: 'blocked' }], archive: noArchive, now: NOW });
  assert.equal(writes[0].data.status, 'blocked');
  assert.equal(writes[0].data.inferredStatus, 'done');
});

test('overrides apply and reset clears', () => {
  const set = mergeAll({ drafts: [draft()], rows: [], overrides: { wi_1: { statusOverride: 'blocked', titleOverride: 'Client wait' } }, archive: noArchive, now: NOW });
  assert.equal(set.writes[0].data.status, 'blocked');
  assert.equal(set.writes[0].data.titleOverride, 'Client wait');
  const reset = mergeAll({ drafts: [draft()], rows: [{ id: 'wi_1', statusOverride: 'blocked' }], overrides: { wi_1: { statusOverride: null } }, archive: noArchive, now: NOW });
  assert.equal(reset.writes[0].data.status, 'in progress');
});

test('a finished Work Item is archived once', () => {
  let calls = 0;
  const archive = () => { calls++; return '/a/2026-10-01-feature-thing'; };
  const first = mergeAll({ drafts: [draft({ inferredStatus: 'done' })], rows: [], archive, now: NOW });
  assert.equal(first.writes[0].data.archivePath, '/a/2026-10-01-feature-thing');
  assert.equal(first.writes[0].data.archivedAt, NOW.toISOString());
  const again = mergeAll({ drafts: [draft({ inferredStatus: 'done' })], rows: [{ id: 'wi_1', ...first.writes[0].data }], archive, now: NOW });
  assert.equal(calls, 1);
  assert.equal(again.writes[0].data.archivePath, '/a/2026-10-01-feature-thing');
});

test('work resumed after archiving is archived again', () => {
  let calls = 0;
  const archive = () => { calls++; return `/a/${calls}`; };
  const rows = [{ id: 'wi_1', statusOverride: 'done', archivePath: '/a/0', archivedAt: '2026-09-29T00:00:00.000Z' }];
  const { writes } = mergeAll({ drafts: [draft()], rows, archive, now: NOW });
  assert.equal(calls, 1);
  assert.equal(writes[0].data.archivePath, '/a/1');
});

test('buildStateCache keeps previous entries and uses the displayed title', () => {
  const cache = buildStateCache([{ docId: 'wi_1', data: { title: 'Thing', titleOverride: 'Mine', phrase: 'p', status: 'blocked' } }], { wi_0: { title: 'Old' } });
  assert.deepEqual(cache, { wi_0: { title: 'Old' }, wi_1: { title: 'Mine', phrase: 'p', status: 'blocked' } });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/merge.test.mjs`
Expected: FAIL with `Cannot find module '.../lib/merge.mjs'`.

- [ ] **Step 3: Implement** — `lib/merge.mjs`

```js
import { effectiveStatus, isFinished } from './status.mjs';

export function mergeRow(draft, existing, phrase, now = new Date()) {
  if (existing?.deleted) return null;
  const statusOverride = existing?.statusOverride ?? null;
  return {
    title: draft.title,
    titleOverride: existing?.titleOverride ?? null,
    ticket: draft.ticket,
    ticketUrl: draft.ticketUrl,
    branch: draft.branch,
    cwd: draft.cwd,
    firstActiveAt: draft.firstActiveAt,
    lastActiveAt: draft.lastActiveAt,
    sessions: draft.sessions,
    prUrl: draft.prUrl,
    where: draft.where,
    inferredStatus: draft.inferredStatus,
    statusOverride,
    status: effectiveStatus(draft.inferredStatus, statusOverride),
    phrase: phrase ?? existing?.phrase ?? '',
    archivePath: existing?.archivePath ?? null,
    archivedAt: existing?.archivedAt ?? null,
    deleted: false,
    updatedAt: now.toISOString(),
  };
}

export function mergeAll({ drafts, rows = [], phrases = {}, overrides = {}, archive, now = new Date() }) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const writes = [];
  const skipped = [];
  for (const draft of drafts) {
    const base = byId.get(draft.id) ?? null;
    const existing = overrides[draft.id] ? { ...(base ?? {}), ...overrides[draft.id] } : base;
    const row = mergeRow(draft, existing, phrases[draft.id], now);
    if (!row) {
      skipped.push(draft.id);
      continue;
    }
    const resumedAfterArchive = row.archivedAt && row.lastActiveAt > row.archivedAt;
    if (isFinished(row.status) && (!row.archivePath || resumedAfterArchive)) {
      row.archivePath = archive(draft, row);
      row.archivedAt = now.toISOString();
    }
    writes.push({ docId: draft.id, data: row });
  }
  return { writes, skipped };
}

export function buildStateCache(writes, previous = {}) {
  const cache = { ...previous };
  for (const { docId, data } of writes) {
    cache[docId] = { title: data.titleOverride || data.title, phrase: data.phrase, status: data.status };
  }
  return cache;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/merge.test.mjs`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/merge.mjs test/merge.test.mjs
git commit -m "feat: merge drafts into Worklog rows with overrides and tombstones" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Drift context

**Files:**
- Create: `lib/drift.mjs`
- Test: `test/drift.test.mjs`

**Interfaces:**
- Consumes: `DEFAULT_BRANCHES`, `deriveTitle`, `workItemId` (Task 3); `isFinished` (Task 4); the state cache shape from Task 9.
- Produces: `driftContext({ title, phrase }) → string`, `promptHookOutput({ prompt, cwd, branch, state }) → string | null` (the JSON a `UserPromptSubmit` hook prints, or null to stay silent).

Rules: stay silent for slash commands, for default-branch or branchless work (no single subject to drift from), and for finished Work Items.

- [ ] **Step 1: Write the failing test** — `test/drift.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driftContext, promptHookOutput } from '../lib/drift.mjs';
import { workItemId } from '../lib/workitem.mjs';

test('driftContext names the Work Item and both ways out', () => {
  const text = driftContext({ title: 'Worklog plugin', phrase: 'Writing the CLI' });
  assert.match(text, /"Worklog plugin"/);
  assert.match(text, /Writing the CLI/);
  assert.match(text, /\/worklog new/);
  assert.match(text, /\/worklog close/);
});

test('promptHookOutput uses the cached title and emits hook JSON', () => {
  const id = workItemId('/w', 'feature/thing');
  const out = JSON.parse(promptHookOutput({ prompt: 'fix my zshrc', cwd: '/w', branch: 'feature/thing', state: { [id]: { title: 'Mine', phrase: 'p', status: 'in progress' } } }));
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /"Mine"/);
});

test('promptHookOutput falls back to the branch-derived title', () => {
  const out = JSON.parse(promptHookOutput({ prompt: 'hello', cwd: '/w', branch: 'feature/new-thing', state: {} }));
  assert.match(out.hookSpecificOutput.additionalContext, /"New thing"/);
});

test('promptHookOutput stays silent where Drift does not apply', () => {
  const id = workItemId('/w', 'feature/x');
  assert.equal(promptHookOutput({ prompt: '/worklog', cwd: '/w', branch: 'feature/x', state: {} }), null);
  assert.equal(promptHookOutput({ prompt: 'hi', cwd: '/w', branch: 'main', state: {} }), null);
  assert.equal(promptHookOutput({ prompt: 'hi', cwd: '/w', branch: '', state: {} }), null);
  assert.equal(promptHookOutput({ prompt: 'hi', cwd: '/w', branch: 'feature/x', state: { [id]: { title: 'X', status: 'done' } } }), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/drift.test.mjs`
Expected: FAIL with `Cannot find module '.../lib/drift.mjs'`.

- [ ] **Step 3: Implement** — `lib/drift.mjs`

```js
import { DEFAULT_BRANCHES, deriveTitle, workItemId } from './workitem.mjs';
import { isFinished } from './status.mjs';

export function driftContext({ title, phrase }) {
  const state = phrase ? ` (last known state: ${phrase})` : '';
  return [
    `[worklog] This Session belongs to the open Work Item "${title}"${state}.`,
    `If the user's prompt pursues a clearly different subject, do not start on it yet. Reply with one short line offering:`,
    `\`/worklog new\` (start a new Worktree and Session for it, carrying this prompt over),`,
    `\`/worklog close\` (finish "${title}" and reuse this Worktree with a new branch),`,
    `or continuing here. If the prompt is related, ignore this note and do not mention it.`,
  ].join(' ');
}

export function promptHookOutput({ prompt, cwd, branch, state }) {
  if (prompt.trim().startsWith('/')) return null;
  if (!branch || DEFAULT_BRANCHES.has(branch)) return null;
  const cached = state?.[workItemId(cwd, branch)];
  if (cached && isFinished(cached.status)) return null;
  const title = cached?.title ?? deriveTitle(branch, cwd).title;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: driftContext({ title, phrase: cached?.phrase }) },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/drift.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/drift.mjs test/drift.test.mjs
git commit -m "feat: add Drift context for the prompt hook" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: CLI and hook wiring

**Files:**
- Create: `bin/worklog.mjs`, `hooks/hooks.json`
- Test: `test/cli.test.mjs`

**Interfaces:**
- Consumes: everything from Tasks 1–10.
- Produces the CLI that the skill (Task 13) calls:
  - `worklog hook <session-end|stop|compact|prompt>`: reads hook JSON on stdin; always exits 0.
  - `worklog collect (--pending | --since <window> | --cwd <path>) [--recheck <rows.json>]`: prints `{ claimFiles, drafts }`.
  - `worklog merge --drafts <file> [--rows <file>] [--phrases <file>] [--override <json>]`: archives as needed, updates `state.json`, prints `{ writes, skipped }`.
  - `worklog ack --drafts <file>`: releases the claim recorded in a drafts file.
  - `worklog current [--cwd <path>]`: prints `{ id, cwd, branch, title, ticket }`.
  - `worklog config [--set key=value ...]`: prints `config.json`, patching it first.

`WorktreeRemove` is deliberately **not** registered. In Claude Code, `WorktreeCreate`/`WorktreeRemove` hooks *replace* the built-in worktree handling, and Orca's own `orca worktree rm` never fires them anyway. A removed Worktree is detected at sync time instead, through `--recheck` plus `fs.existsSync` (Task 8).

- [ ] **Step 1: Write the failing test** — `test/cli.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readPending } from '../lib/pending.mjs';
import { stateFile, readJson } from '../lib/paths.mjs';
import { tmpEnv, sessionLines, writeSession } from './helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'worklog.mjs');
const run = (env, args, input = '') => spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', env: { ...process.env, ...env, PATH: '/usr/bin:/bin' } });

test('hooks exit 0 silently on empty, malformed or unknown input', () => {
  const { env } = tmpEnv();
  for (const args of [['hook', 'session-end'], ['hook', 'stop'], ['hook', 'prompt'], ['hook', 'nonsense'], ['hook']]) {
    for (const input of ['', '{bad', '[]', 'null']) {
      const r = run(env, args, input);
      assert.equal(r.status, 0, `${args.join(' ')} with ${JSON.stringify(input)}`);
      assert.equal(r.stderr, '');
    }
  }
});

test('session-end records a Pending Update; stop is debounced', () => {
  const { env } = tmpEnv();
  const payload = JSON.stringify({ session_id: 's1', cwd: '/w', transcript_path: '/p/s1.jsonl', reason: 'clear' });
  run(env, ['hook', 'session-end'], payload);
  run(env, ['hook', 'stop'], payload);
  run(env, ['hook', 'stop'], payload);
  const events = readPending(env);
  assert.deepEqual(events.map((e) => e.kind), ['session-end']);
  assert.equal(events[0].reason, 'clear');
  assert.equal(events[0].transcriptPath, '/p/s1.jsonl');
});

test('collect, merge and ack round-trip', () => {
  const { env, root } = tmpEnv();
  const cwd = path.join(root, 'wt');
  fs.mkdirSync(cwd);
  const file = writeSession(env, cwd, 's1', sessionLines({ sessionId: 's1', cwd, branch: 'feature/round-trip' }));
  run(env, ['hook', 'session-end'], JSON.stringify({ session_id: 's1', cwd, transcript_path: file }));

  const collected = run(env, ['collect', '--pending']);
  assert.equal(collected.status, 0, collected.stderr);
  const draftsFile = path.join(root, 'drafts.json');
  fs.writeFileSync(draftsFile, collected.stdout);
  const { drafts } = JSON.parse(collected.stdout);
  assert.equal(drafts.length, 1);

  const phrasesFile = path.join(root, 'phrases.json');
  fs.writeFileSync(phrasesFile, JSON.stringify({ [drafts[0].id]: 'Testing the round trip' }));
  const merged = run(env, ['merge', '--drafts', draftsFile, '--phrases', phrasesFile, '--override', JSON.stringify({ [drafts[0].id]: { statusOverride: 'blocked' } })]);
  assert.equal(merged.status, 0, merged.stderr);
  const { writes } = JSON.parse(merged.stdout);
  assert.equal(writes[0].data.status, 'blocked');
  assert.equal(readJson(stateFile(env), {})[drafts[0].id].phrase, 'Testing the round trip');

  assert.equal(run(env, ['ack', '--drafts', draftsFile]).status, 0);
  assert.equal(JSON.parse(run(env, ['collect', '--pending']).stdout).drafts.length, 0);
});

test('config --set patches and prints; bad commands fail loudly', () => {
  const { env } = tmpEnv();
  const r = run(env, ['config', '--set', 'artifactUrl=https://claude.ai/artifact/x', '--set', 'jiraBaseUrl=https://j']);
  assert.deepEqual(JSON.parse(r.stdout), { artifactUrl: 'https://claude.ai/artifact/x', jiraBaseUrl: 'https://j' });
  assert.notEqual(run(env, ['collect']).status, 0);
  assert.notEqual(run(env, ['frobnicate']).status, 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/cli.test.mjs`
Expected: FAIL, because `bin/worklog.mjs` doesn't exist and every spawn exits non-zero.

- [ ] **Step 3: Implement** — `bin/worklog.mjs`

```js
#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { appendPending, isDebounced, readPending, releaseClaims } from '../lib/pending.mjs';
import { collectDrafts, parseDuration } from '../lib/collect.mjs';
import { buildStateCache, mergeAll } from '../lib/merge.mjs';
import { archiveWorkItem } from '../lib/archive.mjs';
import { promptHookOutput } from '../lib/drift.mjs';
import { currentBranch } from '../lib/external.mjs';
import { deriveTitle, workItemId } from '../lib/workitem.mjs';
import { isFinished } from '../lib/status.mjs';
import { configFile, readJson, stateFile, writeJson } from '../lib/paths.mjs';

const print = (data) => process.stdout.write(JSON.stringify(data, null, 2) + '\n');

function fail(message) {
  process.stderr.write(`worklog: ${message}\n`);
  process.exit(1);
}

function readStdinJson() {
  try {
    const parsed = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function runHook(event) {
  const input = readStdinJson();
  const base = { sessionId: input.session_id ?? null, cwd: input.cwd ?? null, transcriptPath: input.transcript_path ?? null };
  switch (event) {
    case 'session-end':
      appendPending({ kind: 'session-end', ...base, reason: input.reason ?? null });
      break;
    case 'stop':
      if (base.sessionId && !isDebounced(readPending(), base.sessionId)) appendPending({ kind: 'turn', ...base });
      break;
    case 'compact':
      appendPending({ kind: 'compact', ...base });
      break;
    case 'prompt': {
      if (!base.cwd || typeof input.prompt !== 'string') break;
      const out = promptHookOutput({ prompt: input.prompt, cwd: base.cwd, branch: currentBranch(base.cwd), state: readJson(stateFile(), {}) });
      if (out) process.stdout.write(out);
      break;
    }
  }
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'hook': {
    // A failing hook would surface as an error inside the user's unrelated Session.
    try {
      runHook(args[0]);
    } catch {}
    process.exit(0);
  }
  case 'collect': {
    const { values } = parseArgs({ args, options: { pending: { type: 'boolean' }, since: { type: 'string' }, cwd: { type: 'string' }, recheck: { type: 'string' } } });
    const mode = values.pending ? 'pending' : values.since ? 'since' : values.cwd ? 'cwd' : null;
    if (!mode) fail('collect needs --pending, --since <window> or --cwd <path>');
    const rows = values.recheck ? readJson(values.recheck, []) : [];
    const recheckCwds = rows.filter((r) => !r.deleted && !isFinished(r.status) && r.cwd).map((r) => r.cwd);
    const sinceMs = values.since ? Date.now() - parseDuration(values.since) : undefined;
    print(collectDrafts({ mode, sinceMs, cwd: values.cwd, recheckCwds }));
    break;
  }
  case 'merge': {
    const { values } = parseArgs({ args, options: { drafts: { type: 'string' }, rows: { type: 'string' }, phrases: { type: 'string' }, override: { type: 'string' } } });
    if (!values.drafts) fail('merge needs --drafts <file>');
    const { drafts = [] } = readJson(values.drafts, {});
    const result = mergeAll({
      drafts,
      rows: values.rows ? readJson(values.rows, []) : [],
      phrases: values.phrases ? readJson(values.phrases, {}) : {},
      overrides: values.override ? JSON.parse(values.override) : {},
      archive: (draft, row) => archiveWorkItem({ title: row.titleOverride || row.title, branch: draft.branch, cwd: draft.cwd, sessionFiles: draft.sessionFiles }),
    });
    writeJson(stateFile(), buildStateCache(result.writes, readJson(stateFile(), {})));
    print(result);
    break;
  }
  case 'ack': {
    const { values } = parseArgs({ args, options: { drafts: { type: 'string' } } });
    if (!values.drafts) fail('ack needs --drafts <file>');
    const { claimFiles = [] } = readJson(values.drafts, {});
    releaseClaims(claimFiles);
    print({ released: claimFiles.length });
    break;
  }
  case 'current': {
    const { values } = parseArgs({ args, options: { cwd: { type: 'string' } } });
    const cwd = values.cwd ?? process.cwd();
    const branch = currentBranch(cwd);
    print({ id: workItemId(cwd, branch), cwd, branch, ...deriveTitle(branch, cwd) });
    break;
  }
  case 'config': {
    const { values } = parseArgs({ args, options: { set: { type: 'string', multiple: true } } });
    const config = readJson(configFile(), {});
    for (const pair of values.set ?? []) {
      const at = pair.indexOf('=');
      if (at < 1) fail(`--set expects key=value, got "${pair}"`);
      config[pair.slice(0, at)] = pair.slice(at + 1);
    }
    if (values.set?.length) writeJson(configFile(), config);
    print(config);
    break;
  }
  default:
    fail(`unknown command "${command ?? ''}". Use hook, collect, merge, ack, current or config.`);
}
```

- [ ] **Step 4: Write** `hooks/hooks.json`

```json
{
  "hooks": {
    "SessionEnd": [
      { "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/bin/worklog.mjs\" hook session-end", "timeout": 5 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/bin/worklog.mjs\" hook stop", "timeout": 5 }] }
    ],
    "PostCompact": [
      { "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/bin/worklog.mjs\" hook compact", "timeout": 5 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/bin/worklog.mjs\" hook prompt", "timeout": 5 }] }
    ]
  }
}
```

- [ ] **Step 5: Run the whole suite**

Run: `chmod +x bin/worklog.mjs && npm test`
Expected: PASS, all test files.

- [ ] **Step 6: Check hook latency against the 1.5 s budget**

Run: `time (echo '{"session_id":"t","cwd":"/tmp","transcript_path":"/tmp/t.jsonl"}' | WORKLOG_HOME=$(mktemp -d) node bin/worklog.mjs hook session-end)`
Expected: `real` well under 0.5 s.

- [ ] **Step 7: Commit**

```bash
git add bin/worklog.mjs hooks/hooks.json test/cli.test.mjs
git commit -m "feat: add worklog CLI and register Pending Update and Drift hooks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The Worklog page

**Files:**
- Create: `page/view-model.mjs`, `page/index.html`
- Test: `test/view-model.test.mjs`

**Interfaces:**
- Consumes: the Row shape from Task 9, read live from the artifact database collection `workItems`.
- Produces: `tierOf(lastActiveAt, now) → 'week' | 'month' | 'older'`, `displayTitle(row)`, `matches(row, query)`, `whereOf(row) → { kind: 'archive', path } | { kind: 'live', displayName, path, resumeCommand, prUrl }`, `buildView(rows, { query, now }) → { week, month, older, total, shown }`.

Before writing `page/index.html`, **load the `artifact-design` skill** and apply its page contract (title, `:root` tokens with a dark-mode block, explicit `body` background, phone-width layout). Database API facts (runtime contract 0.2.66): `const db = await claude.use('db')` resolves to `null` when unavailable; `db.collection('workItems').onSnapshot(snap => …, err => …)`, with `snap.docs[i].id` and `snap.docs[i].data()` (frozen, so clone before editing); `db.doc('workItems/' + id).update({...})`. Subscribe once, never inside render.

- [ ] **Step 1: Write the failing test** — `test/view-model.test.mjs`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierOf, displayTitle, matches, whereOf, buildView } from '../page/view-model.mjs';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();
const row = (over) => ({ id: 'wi', title: 'T', titleOverride: null, branch: 'feature/t', ticket: null, phrase: '', status: 'in progress', cwd: '/w', sessions: [], where: { displayName: null, path: '/w', resumeCommand: 'cd /w' }, prUrl: null, archivePath: null, deleted: false, lastActiveAt: daysAgo(1), ...over });

test('tiers: this week, last 30 days, all time', () => {
  assert.equal(tierOf(daysAgo(0), NOW), 'week');
  assert.equal(tierOf(daysAgo(7), NOW), 'week');
  assert.equal(tierOf(daysAgo(8), NOW), 'month');
  assert.equal(tierOf(daysAgo(30), NOW), 'month');
  assert.equal(tierOf(daysAgo(31), NOW), 'older');
});

test('title override wins', () => {
  assert.equal(displayTitle(row({ titleOverride: 'Mine' })), 'Mine');
  assert.equal(displayTitle(row({})), 'T');
});

test('search matches every word across title, branch, ticket, phrase, status and Session IDs', () => {
  const r = row({ title: 'Reviewer assignment', ticket: 'NYP-3322', phrase: 'PR open', sessions: [{ id: 'abc123' }] });
  assert.equal(matches(r, 'reviewer nyp-3322'), true);
  assert.equal(matches(r, 'abc123'), true);
  assert.equal(matches(r, 'reviewer zebra'), false);
  assert.equal(matches(r, '   '), true);
});

test('where shows the archive once finished, else the live location', () => {
  assert.deepEqual(whereOf(row({ status: 'done', archivePath: '/a' })), { kind: 'archive', path: '/a' });
  assert.equal(whereOf(row({ status: 'done', archivePath: null })).kind, 'live');
  assert.equal(whereOf(row({ prUrl: 'https://x' })).prUrl, 'https://x');
});

test('buildView hides deleted rows, filters, sorts newest first, and tiers', () => {
  const rows = [
    row({ id: 'a', lastActiveAt: daysAgo(2) }),
    row({ id: 'b', lastActiveAt: daysAgo(1) }),
    row({ id: 'c', lastActiveAt: daysAgo(10) }),
    row({ id: 'd', lastActiveAt: daysAgo(100), title: 'Ancient' }),
    row({ id: 'e', deleted: true }),
  ];
  const all = buildView(rows, { query: '', now: NOW });
  assert.deepEqual(all.week.map((r) => r.id), ['b', 'a']);
  assert.deepEqual(all.month.map((r) => r.id), ['c']);
  assert.deepEqual(all.older.map((r) => r.id), ['d']);
  assert.equal(all.total, 4);
  const found = buildView(rows, { query: 'ancient', now: NOW });
  assert.equal(found.shown, 1);
  assert.deepEqual(found.older.map((r) => r.id), ['d']);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/view-model.test.mjs`
Expected: FAIL with `Cannot find module '.../page/view-model.mjs'`.

- [ ] **Step 3: Implement** — `page/view-model.mjs`

```js
const DAY = 86_400_000;
const FINISHED = new Set(['done', 'abandoned']);

export function tierOf(lastActiveAt, now) {
  const age = now - Date.parse(lastActiveAt);
  if (age <= 7 * DAY) return 'week';
  if (age <= 30 * DAY) return 'month';
  return 'older';
}

export const displayTitle = (row) => row.titleOverride || row.title;

export function matches(row, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = [
    displayTitle(row), row.branch, row.ticket, row.phrase, row.status, row.cwd,
    row.where?.displayName, ...(row.sessions ?? []).map((s) => s.id),
  ].filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => haystack.includes(w));
}

export function whereOf(row) {
  if (FINISHED.has(row.status) && row.archivePath) return { kind: 'archive', path: row.archivePath };
  return { kind: 'live', displayName: row.where?.displayName ?? null, path: row.where?.path ?? row.cwd, resumeCommand: row.where?.resumeCommand ?? null, prUrl: row.prUrl ?? null };
}

export function buildView(rows, { query = '', now = Date.now() } = {}) {
  const live = rows.filter((r) => !r.deleted);
  const shown = live.filter((r) => matches(r, query)).sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  const view = { week: [], month: [], older: [], total: live.length, shown: shown.length };
  for (const r of shown) view[tierOf(r.lastActiveAt, now)].push(r);
  return view;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/view-model.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Load `artifact-design`, then write** `page/index.html`

Structure and behaviour (adapt the styling to the skill's contract; keep the script as written):

```html
<title>Worklog</title>
<style>
  :root { --bg:#fbfaf8; --fg:#1d1c1a; --muted:#6b6862; --line:#e6e2db; --chip:#efece6; --accent:#3b5bdb;
          --s-progress:#3b5bdb; --s-blocked:#c92a2a; --s-review:#e67700; --s-done:#2b8a3e; --s-abandoned:#868e96; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#161513; --fg:#ece9e4; --muted:#a19d96; --line:#2c2a27; --chip:#24221f; --accent:#7c9bff; } }
  :root[data-theme="dark"] { --bg:#161513; --fg:#ece9e4; --muted:#a19d96; --line:#2c2a27; --chip:#24221f; --accent:#7c9bff; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.45 system-ui, sans-serif; }
  main { max-width:1100px; margin:0 auto; padding:24px 16px 64px; }
  header { display:flex; flex-wrap:wrap; gap:12px; align-items:baseline; justify-content:space-between; }
  input[type=search] { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--chip); color:var(--fg); margin:16px 0; }
  details { border-top:1px solid var(--line); padding:8px 0; }
  summary { cursor:pointer; font-weight:600; padding:6px 0; }
  .rows { display:grid; gap:8px; margin-top:8px; }
  .row { display:grid; grid-template-columns: 2fr auto 3fr auto 2fr auto; gap:12px; align-items:start; padding:10px 0; border-bottom:1px solid var(--line); }
  @media (max-width: 720px) { .row { grid-template-columns: 1fr auto; } .row > .phrase, .row > .where { grid-column: 1 / -1; } }
  .branch, .meta { color:var(--muted); font-size:12px; }
  .chip { font-size:12px; padding:2px 8px; border-radius:999px; background:var(--chip); white-space:nowrap; }
  .chip[data-s="in progress"] { color:var(--s-progress); } .chip[data-s="blocked"] { color:var(--s-blocked); }
  .chip[data-s="awaiting review"] { color:var(--s-review); } .chip[data-s="done"] { color:var(--s-done); } .chip[data-s="abandoned"] { color:var(--s-abandoned); }
  button { font:inherit; font-size:12px; border:1px solid var(--line); background:transparent; color:var(--fg); border-radius:6px; padding:2px 8px; cursor:pointer; }
  a { color:var(--accent); } code { font-size:12px; word-break:break-all; }
  .notice { color:var(--muted); padding:24px 0; }
</style>
<main>
  <header><h1>Worklog</h1><span class="meta" id="count"></span></header>
  <input type="search" id="q" placeholder="Search Work Items, branches, tickets, Session IDs…" aria-label="Search the Worklog">
  <div id="notice" class="notice">Loading your Worklog…</div>
  <details id="week" open><summary>This week</summary><div class="rows"></div></details>
  <details id="month"><summary>Last 30 days</summary><div class="rows"></div></details>
  <details id="older"><summary>All time</summary><div class="rows"></div></details>
</main>
<script type="module">
  import { buildView, displayTitle, whereOf } from './view-model.mjs';

  let rows = [];
  let db = null;
  const q = document.getElementById('q');
  const notice = document.getElementById('notice');
  const el = (tag, attrs = {}, ...kids) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) k === 'text' ? (node.textContent = v) : node.setAttribute(k, v);
    node.append(...kids.filter(Boolean));
    return node;
  };
  const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  function rowNode(r) {
    const where = whereOf(r);
    const title = el('div', {}, el('div', { text: displayTitle(r) }),
      el('div', { class: 'branch' }, r.branch || '', r.ticket ? ' · ' : '',
        r.ticket ? (r.ticketUrl ? el('a', { href: r.ticketUrl, target: '_blank', rel: 'noopener', text: r.ticket }) : r.ticket) : ''));
    const sessions = el('details', { class: 'meta' }, el('summary', { text: `Sessions: ${r.sessions?.length ?? 0}` }),
      ...(r.sessions ?? []).map((s) => el('div', {}, el('code', { text: s.id }))));
    let whereNode;
    if (where.kind === 'archive') {
      whereNode = el('div', { class: 'where' }, el('div', { class: 'meta', text: 'Archived Transcript' }), el('code', { text: where.path }));
    } else {
      const copy = el('button', { type: 'button', text: 'Copy resume' });
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(where.resumeCommand); copy.textContent = 'Copied'; }
        catch { copy.textContent = 'Copy failed'; }
        setTimeout(() => (copy.textContent = 'Copy resume'), 1500);
      });
      whereNode = el('div', { class: 'where' }, el('div', { text: where.displayName || '' }), el('code', { text: where.path }),
        el('div', {}, where.resumeCommand ? copy : null, where.prUrl ? el('a', { href: where.prUrl, target: '_blank', rel: 'noopener', text: ' PR' }) : null));
    }
    const del = el('button', { type: 'button', text: 'Delete', 'aria-label': `Delete ${displayTitle(r)} from the Worklog` });
    del.addEventListener('click', async () => {
      if (!db || !confirm(`Delete "${displayTitle(r)}" from the Worklog? Its Archived Transcript stays on disk.`)) return;
      try { await db.doc(`workItems/${r.id}`).update({ deleted: true, deletedAt: new Date().toISOString() }); }
      catch (e) { alert(`Could not delete: ${e?.code ?? 'unknown error'}`); }
    });
    return el('div', { class: 'row' }, title, el('span', { class: 'chip', 'data-s': r.status, text: r.status }),
      el('div', { class: 'phrase', text: r.phrase || '' }), el('div', { class: 'meta', text: when(r.lastActiveAt) }),
      whereNode, el('div', {}, sessions, db ? del : null));
  }

  function render() {
    const query = q.value.trim();
    const view = buildView(rows, { query, now: Date.now() });
    document.getElementById('count').textContent = query ? `${view.shown} of ${view.total} Work Items` : `${view.total} Work Items`;
    for (const tier of ['week', 'month', 'older']) {
      const section = document.getElementById(tier);
      section.querySelector('.rows').replaceChildren(...view[tier].map(rowNode));
      section.querySelector('summary').dataset.count = view[tier].length;
      if (query) section.open = view[tier].length > 0;
    }
    notice.hidden = rows.length > 0;
    if (!rows.length && db) notice.textContent = 'No Work Items yet. Run /worklog in Claude Code.';
  }

  q.addEventListener('input', render);
  render();

  claude.use('db').then((handle) => {
    db = handle;
    if (!db) { notice.textContent = 'Open this page in claude.ai, signed in, to load your Worklog.'; return; }
    db.collection('workItems').onSnapshot(
      (snap) => { rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })); render(); },
      (err) => { notice.hidden = false; notice.textContent = `Could not load the Worklog (${err?.code ?? 'error'}).`; },
    );
  });
</script>
```

- [ ] **Step 6: Commit**

```bash
git add page/view-model.mjs page/index.html test/view-model.test.mjs
git commit -m "feat: add the Worklog artifact page" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: The `/worklog` skill, install, and first run

**Files:**
- Create: `skills/worklog/SKILL.md`, `README.md`

**Interfaces:**
- Consumes: the CLI from Task 11, the page from Task 12, the `Artifact` and `ArtifactData` tools, and `orca`.
- Produces: the user-facing `/worklog` behaviour.

- [ ] **Step 1: Write** `skills/worklog/SKILL.md`

````markdown
---
name: worklog
description: Keeps the user's private Worklog artifact up to date — one row per Work Item with its Status, State Phrase and where it lives. Use for /worklog and its arguments (a status, reset, title:, new, close, backfill), when the Keeper loop fires, or when the user asks to log, close, or split off work.
---

# Worklog

Vocabulary is fixed: Worklog, Work Item, Worktree, Session, Title, Status, State Phrase, Status Override, Pending Update, Keeper, Archived Transcript, Closing, Drift. Use these words with the user.

`CLI` below means `node "<this skill's base directory>/../../bin/worklog.mjs"`. `$S` means this session's scratchpad directory. Load `ArtifactData` with ToolSearch before its first use.

## Route the arguments

| Arguments | Do |
|---|---|
| none | **Sync** |
| a Status (`in progress`, `blocked`, `awaiting review`, `done`, `abandoned`; hyphens allowed) | **Override** with `{"statusOverride":"<status>"}` |
| `reset` | **Override** with `{"statusOverride":null}` |
| `title: <text>` | **Override** with `{"titleOverride":"<text>"}` |
| `new [description]` | **New** |
| `close [done\|abandoned]` | **Close** |
| `backfill <window>` | **Sync**, with `collect --since <window>` in step 3 |
| anything else | Show this table in one line and stop |

## Sync

1. Run `CLI config`. If there is no `artifactUrl`, do **First run** and stop.
2. `ArtifactData` `list` collection `workItems` on `artifactUrl`, paging until done. Write `$S/rows.json` as a JSON array whose elements are each document's fields plus `"id": <doc_id>`.
3. Run `CLI collect --pending --recheck $S/rows.json > $S/drafts.json`.
4. If `drafts` is empty, run `CLI ack --drafts $S/drafts.json`, say "Worklog is up to date", and stop.
5. For every draft whose row isn't `deleted`, write one **State Phrase** from its `digest` plus `inferredStatus` and `prUrl`. Rules: at most 15 words; says where the work stands now, not what was said; no quotes from the transcript; no secrets, credentials, or client details beyond what the Title already shows. Write `$S/phrases.json` as `{ "<id>": "<phrase>" }`.
6. Run `CLI merge --drafts $S/drafts.json --rows $S/rows.json --phrases $S/phrases.json > $S/writes.json`.
7. `ArtifactData` `batch` on `artifactUrl`: one `set` per entry in `writes`, collection `workItems`, `doc_id` = `docId`, data = `data`. Send at most 50 per batch.
8. Run `CLI ack --drafts $S/drafts.json` only after every batch has succeeded. If a batch fails, don't ack; the Pending Updates stay claimed and the next Sync retries them.
9. Reply in one line: how many Work Items were updated and archived, plus the Worklog link.

## Override

1. Run `CLI current` to get `id`, `cwd`, `branch`.
2. Follow **Sync** steps 1–2. Then run `CLI collect --cwd <cwd> > $S/drafts.json` and write a fresh phrase only for `id`.
3. Run `CLI merge --drafts $S/drafts.json --rows $S/rows.json --phrases $S/phrases.json --override '{"<id>": <override>}' > $S/writes.json`, then do **Sync** step 7. No ack is needed: `--cwd` claims nothing.
4. Confirm in one line, e.g. "Status Override set: blocked. `/worklog reset` returns to the inferred Status."

## New

1. Description: use the argument, or the prompt that triggered the Drift offer, word for word.
2. Ask once: "Ticket number for this?" Accept an answer or a skip, and never ask again.
3. Branch name: `feature/` for new behaviour, `fix/` for correcting existing behaviour. Add `<TICKET>/` if a ticket was given, then a short lowercase hyphenated description of the change. Never a username, never a placeholder.
4. Run `orca worktree create --name <branch> --agent claude --prompt "<description>" --activate --json`. If `claude` isn't an accepted agent id, read `orca agent-context --json` for the right one.
5. Read the new worktree's `branch` from the JSON (or `orca worktree show --worktree name:<branch> --json`). If it isn't `<branch>`, run `git -C <path> branch -m <branch>`.
6. Tell the user in one line that the new Session is running in that Worktree, and continue the current Work Item here.

## Close

1. Status = the argument (`done` or `abandoned`), default `done`.
2. If `git status --porcelain` shows uncommitted changes, stop and ask the user to commit or stash them first.
3. Do **Override** with `{"statusOverride":"<status>"}`. Merge archives the Work Item.
4. Ask what the next Work Item in this Worktree is, and its ticket (once, skippable). Build the branch name as in **New** step 3.
5. Find the base with `git symbolic-ref --short refs/remotes/origin/HEAD` (fall back to `origin/main`), then run `git fetch origin` and `git switch -c <branch> <base>`.
6. Tell the user: "Closed <Title>. Run `/clear` to start the next Session on `<branch>`."

## First run

1. Read `page/index.html` and `page/view-model.mjs` (plugin root = this skill's base directory + `/../..`).
2. Publish with the `Artifact` tool: `file_path` = `page/index.html`, `files` = `{"view-model.mjs": "<root>/page/view-model.mjs"}`, `capabilities` = `{"db": {}, "user": {}}`, `icon` = `list`, `description` = "Every Work Item done with Claude, where it stands, and where to find it."
3. Run `CLI config --set artifactUrl=<url>`.
4. If the Atlassian connector is available, call `getAccessibleAtlassianResources` and run `CLI config --set jiraBaseUrl=<site url>` for the user's site. Skip this if the connector isn't available.
5. Do **Sync** with `collect --since 30d` in step 3.
6. Tell the user the link, and suggest starting the Keeper (below).

## Keeper

The Keeper is one long-running Session in its own Orca terminal, outside any Worktree (for example in `~`), running:

```
/loop 30m /worklog
```

Each pass is a **Sync**. `/worklog` in any Session does the same thing immediately.
````

- [ ] **Step 2: Write** `README.md`

````markdown
# worklog

A Claude Code plugin that keeps a private Worklog artifact: one row per Work Item, with its Status, a one-phrase State, and where to find it. Vocabulary: `CONTEXT.md`. Design: `docs/superpowers/specs/2026-10-01-worklog-design.md`.

## Install (user scope)

```bash
claude plugin marketplace add /Users/moraleida/orca/workspaces/general/work-tracking-skill
claude plugin install worklog@worklog-local --scope user
```

## Start

1. In any Session: `/worklog`. The first run publishes the page and imports the last 30 days.
2. Start the Keeper in its own Orca terminal outside any Worktree: `/loop 30m /worklog`.

## Local files

`~/worklog/` (override with `WORKLOG_HOME`): `pending.jsonl` (Pending Updates), `state.json` (cache for the Drift hook), `config.json` (artifact URL, Jira base URL), `transcripts/` (Archived Transcripts).

## Develop

```bash
npm test
```
````

- [ ] **Step 3: Validate and install the plugin**

Run: `claude plugin validate . 2>&1 || true`, then the two install commands from the README.
Expected: validation reports no errors (if `validate` isn't a subcommand in this version, skip it), and `worklog@worklog-local` installs.

- [ ] **Step 4: Verify the hooks fire**

Open a new Session in this Worktree, send one prompt, then exit it.
Run: `tail -n 3 ~/worklog/pending.jsonl`
Expected: a `turn` and a `session-end` record carrying that Session's ID and `transcriptPath`.

- [ ] **Step 5: Verify the command name**

In a new Session, type `/worklog`. If the skill only resolves as `/worklog:worklog`, note that in the README's Start section rather than renaming anything.

- [ ] **Step 6: First run, end to end**

Run `/worklog`.
Expected:
- the page is published;
- `~/worklog/config.json` has `artifactUrl`;
- `ArtifactData` `list` of `workItems` shows rows from the last 30 days, none of them containing a `digest` field or prompt text;
- the page shows them in "This week" and "Last 30 days".

- [ ] **Step 7: Functional checks on the page**

- Delete one row on the page. Run `/worklog` again and confirm with `ArtifactData` `get` that the row still has `deleted: true`.
- In this Worktree, run `/worklog blocked` and check the chip. Then run `/worklog reset` and check it returns to the inferred Status.
- In a feature-branch Worktree, send an unrelated prompt ("fix the typo in my zshrc") and confirm Claude offers `/worklog new` or `/worklog close` instead of starting on it.

- [ ] **Step 8: Commit**

```bash
git add skills/worklog/SKILL.md README.md
git commit -m "feat: add /worklog skill, Keeper instructions and install guide" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
