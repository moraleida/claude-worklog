# Work Without Orca Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Worklog plugin fully usable in a plain git Clone with no Orca and no Worktrees, while everything it does today in Orca Worktrees stays exactly as it is.

**Architecture:** Every Sync already learns the directory and branch of each Work Item from the transcripts. A new `describeCheckout` lookup classifies that directory as `orca`, `worktree`, `clone` or `folder`, and records the repository name. Only `clone` changes behaviour: a deleted local branch counts as evidence of `done`, and the resume command switches back to the branch. `/worklog new` keeps the Orca path when the `orca` CLI answers, and otherwise cuts a branch in place.

**Tech Stack:** Node ≥ 24 ESM, `node:test`, `git` and `gh` via `execFileSync`, no npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-01-worklog-design.md`. Task 7 amends it; nothing else in the spec changes.

## Global Constraints

- Node ≥ 24 (`package.json` `engines`); add no npm dependencies.
- Statuses are exactly: `in progress`, `blocked`, `awaiting review`, `done`, `abandoned`.
- When the `orca` CLI answers, or the directory is an Orca or git Worktree, every current behaviour stays as it is: same Status inference, same resume command, same `/worklog new` flow. Every existing test passes unedited.
- The `UserPromptSubmit` hook keeps its single `git` call with a timeout of at most 1500 ms. Add no new lookups to any hook.
- Branch names: `feature/` or `fix/`, optional `<TICKET>/` segment in its original case, lowercase hyphenated description, never a username or placeholder.
- Never put user text inside a shell string; write it to a file with the Write tool first.
- Vocabulary is fixed: Worklog, Work Item, Worktree, Clone (new in this plan), Session, Title, Status, State Phrase, Status Override, Pending Update, Keeper, Archived Transcript, Closing, Drift.
- Any `git` or `gh` failure, missing binary or timeout must leave the Status as it would be without the lookup. Never infer `done` from a failed lookup.

## Review Focus

1. **`git` missing, timing out, or the directory not being a repository.** `branchExists` returns `null` and the Status stays `in progress`, never `done`. Pinned in Task 1 (`branchExists` returns `null` on failure) and Task 3 (outside git the Work Item stays in progress).
2. **An unborn branch** (`git init` with no commits yet): `for-each-ref` lists nothing, but the branch is checked out, so it must count as existing. Pinned in Task 1 (real-git test on a fresh repo).
3. **An Orca or git Worktree whose branch was renamed or deleted** (the Orca flow in `/worklog new` renames branches right after creating them). It must stay `in progress`; the branch rule is for Clones only. Pinned in Task 3.
4. **A branch name containing an apostrophe** in the Clone resume command must be shell-quoted. Pinned in Task 3 (`resumeCommand` test).
5. **A Session started in a subdirectory of a Clone** (`cwd` = `<repo>/src`) still reads as a Clone of that repository, not as a folder named `src`. Pinned in Task 1 (real-git test).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `lib/external.mjs` | modify | adds `describeCheckout`, `branchExists`, `orcaAvailable` |
| `lib/status.mjs` | modify | `inferStatus` accepts `branchExists` |
| `lib/workitem.mjs` | modify | `resumeCommand` can switch to a branch first |
| `lib/collect.mjs` | modify | drafts carry `repo` and `where.kind`; Clone rules applied |
| `lib/merge.mjs` | modify | rows carry `repo` and `where.kind` |
| `lib/drift.mjs` | modify | offer wording no longer assumes a Worktree |
| `bin/worklog.mjs` | modify | `current` reports `checkout` and `orca` |
| `page/view-model.js` | modify | `repoOf` prefers the stored `repo` |
| `test/helpers.mjs` | modify | `hasGit`, `git`, `gitRepo` helpers for real-git tests |
| `test/external.test.mjs`, `test/status.test.mjs`, `test/workitem.test.mjs`, `test/collect.test.mjs`, `test/merge.test.mjs`, `test/drift.test.mjs`, `test/cli.test.mjs`, `test/view-model.test.mjs` | modify | tests per task |
| `skills/worklog/SKILL.md`, `CONTEXT.md`, `README.md`, `docs/superpowers/specs/2026-10-01-worklog-design.md` | modify | Clone vocabulary, New and Close without Orca |

---

### Task 1: Classify a directory and check a branch

**Files:**
- Modify: `lib/external.mjs`
- Modify: `test/helpers.mjs`
- Test: `test/external.test.mjs`

**Interfaces:**
- Consumes: `findWorktree(worktrees, cwd)`, `parseGithubRemote(url)` (existing).
- Produces:
  - `describeCheckout(cwd: string, worktrees?: Array<{path}>, exec?) → { kind: 'orca'|'worktree'|'clone'|'folder', root: string|null, repo: string|null, githubRepo: string|null }`
  - `branchExists(cwd: string, branch: string, exec?) → true | false | null` (`null` = unknown)
  - `orcaAvailable(exec?) → boolean`
  - test helpers `hasGit: boolean`, `git(cwd, ...args) → string`, `gitRepo(dir, { branch = 'main', commit = true }) → realpath`

- [ ] **Step 1: Add the real-git helpers to `test/helpers.mjs`**

Add `import { execFileSync } from 'node:child_process';` to the imports, then append:

```js
export const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

export const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });

export function gitRepo(dir, { branch = 'main', commit = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', branch, dir]);
  if (commit) git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return fs.realpathSync(dir);
}
```

- [ ] **Step 2: Write the failing tests in `test/external.test.mjs`**

Change the imports to:

```js
import fs from 'node:fs';
import path from 'node:path';
import { listOrcaWorktrees, findWorktree, prState, githubRepoFor, currentBranch, describeCheckout, branchExists, orcaAvailable } from '../lib/external.mjs';
import { tmpEnv, hasGit, git, gitRepo } from './helpers.mjs';
```

Append:

```js
const REV_PARSE = 'rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir';

test('describeCheckout names the repository after its GitHub remote, and Orca wins the kind', () => {
  const exec = fakeExec({
    [`git -C /w/a ${REV_PARSE}`]: '/w/a\n/r/.git/worktrees/a\n/r/.git\n',
    'git -C /w/a remote get-url origin': 'git@github.com:o/claude-worklog.git\n',
  });
  assert.deepEqual(describeCheckout('/w/a', [], exec), { kind: 'worktree', root: '/w/a', repo: 'claude-worklog', githubRepo: 'o/claude-worklog' });
  assert.equal(describeCheckout('/w/a', [{ path: '/w/a' }], exec).kind, 'orca');
  assert.deepEqual(describeCheckout('/w/a', [{ path: '/w/a' }], failing), { kind: 'orca', root: null, repo: null, githubRepo: null });
  assert.deepEqual(describeCheckout('/w/a', [], failing), { kind: 'folder', root: null, repo: null, githubRepo: null });
});

test('describeCheckout tells a Clone, a Worktree, an Orca Worktree and a plain folder apart', { skip: !hasGit }, () => {
  const { root } = tmpEnv();
  const main = gitRepo(path.join(root, 'proj'));
  fs.mkdirSync(path.join(main, 'src'));
  git(main, 'worktree', 'add', '-q', '-b', 'feature/wt', path.join(root, 'wt'));
  const wt = fs.realpathSync(path.join(root, 'wt'));
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);
  assert.deepEqual(describeCheckout(main), { kind: 'clone', root: main, repo: 'proj', githubRepo: null });
  assert.deepEqual(describeCheckout(path.join(main, 'src')), { kind: 'clone', root: main, repo: 'proj', githubRepo: null });
  assert.deepEqual(describeCheckout(wt), { kind: 'worktree', root: wt, repo: 'proj', githubRepo: null });
  assert.equal(describeCheckout(wt, [{ path: wt }]).kind, 'orca');
  assert.deepEqual(describeCheckout(plain), { kind: 'folder', root: null, repo: null, githubRepo: null });
});

test('branchExists sees local branches and an unborn HEAD; failure is unknown, not missing', { skip: !hasGit }, () => {
  const { root } = tmpEnv();
  const repo = gitRepo(path.join(root, 'r'));
  git(repo, 'branch', 'feature/kept');
  git(repo, 'tag', 'feature/gone');
  assert.equal(branchExists(repo, 'main'), true);
  assert.equal(branchExists(repo, 'feature/kept'), true);
  assert.equal(branchExists(repo, 'feature/gone'), false, 'a tag with the name is not the branch');
  assert.equal(branchExists(repo, 'feature'), false, 'a prefix of a branch is not the branch');
  const fresh = gitRepo(path.join(root, 'fresh'), { branch: 'feature/new', commit: false });
  assert.equal(branchExists(fresh, 'feature/new'), true);
  assert.equal(branchExists(path.join(root, 'nowhere'), 'main'), null);
  assert.equal(branchExists(repo, ''), null);
  assert.equal(branchExists(repo, 'main', failing), null);
});

test('orcaAvailable is true only when the orca CLI answers', () => {
  assert.equal(orcaAvailable(fakeExec({ 'orca worktree list --json': '{}' })), true);
  assert.equal(orcaAvailable(failing), false);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/external.test.mjs`
Expected: FAIL. The module does not export `describeCheckout`.

- [ ] **Step 4: Implement in `lib/external.mjs`**

Add `import path from 'node:path';` to the imports. Then append:

```js
export const orcaAvailable = (exec = defaultExec) => tryExec(exec, 'orca', ['worktree', 'list', '--json']) != null;

// A bare repository's common dir is <name>.git; a normal one is <name>/.git.
function repoNameFromCommonDir(commonDir) {
  const base = path.basename(commonDir);
  return base === '.git' ? path.basename(path.dirname(commonDir)) : base.replace(/\.git$/, '');
}

export function describeCheckout(cwd, worktrees = [], exec = defaultExec) {
  const orca = Boolean(findWorktree(worktrees, cwd));
  const out = tryExec(exec, 'git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']);
  const [root, gitDir, commonDir] = out?.trim().split('\n') ?? [];
  if (!commonDir) return { kind: orca ? 'orca' : 'folder', root: null, repo: null, githubRepo: null };
  const githubRepo = githubRepoFor(cwd, exec);
  const kind = orca ? 'orca' : gitDir !== commonDir ? 'worktree' : 'clone';
  return { kind, root, repo: githubRepo?.split('/')[1] ?? repoNameFromCommonDir(commonDir), githubRepo };
}

// for-each-ref lists nothing for an unborn branch, so the checked-out branch is asked about first.
export function branchExists(cwd, branch, exec = defaultExec) {
  if (!branch) return null;
  const head = tryExec(exec, 'git', ['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'])?.trim();
  if (head === branch) return true;
  const out = tryExec(exec, 'git', ['-C', cwd, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`]);
  if (out == null) return null;
  return out.split('\n').includes(`refs/heads/${branch}`);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, with no existing test edited.

- [ ] **Step 6: Commit**

```bash
git add lib/external.mjs test/helpers.mjs test/external.test.mjs
git commit -m "feat: tell Clones, Worktrees and plain folders apart"
```

---

### Task 2: A deleted branch is evidence of done

**Files:**
- Modify: `lib/status.mjs:3-7`
- Test: `test/status.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `inferStatus({ prState, worktreeExists, branchExists = null })`. `branchExists === false` gives `done` unless the PR is open. `null` or `true` changes nothing.

- [ ] **Step 1: Write the failing test** (append to `test/status.test.mjs`)

```js
test('a deleted branch means done, unless its PR is still open; unknown changes nothing', () => {
  assert.equal(inferStatus({ prState: null, worktreeExists: true, branchExists: false }), 'done');
  assert.equal(inferStatus({ prState: 'CLOSED', worktreeExists: true, branchExists: false }), 'done');
  assert.equal(inferStatus({ prState: 'OPEN', worktreeExists: true, branchExists: false }), 'awaiting review');
  assert.equal(inferStatus({ prState: null, worktreeExists: true, branchExists: null }), 'in progress');
  assert.equal(inferStatus({ prState: null, worktreeExists: true, branchExists: true }), 'in progress');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/status.test.mjs`
Expected: FAIL on the first assertion (`in progress` !== `done`).

- [ ] **Step 3: Implement**

Replace `inferStatus` in `lib/status.mjs`:

```js
export function inferStatus({ prState = null, worktreeExists = true, branchExists = null } = {}) {
  if (prState === 'MERGED' || !worktreeExists) return 'done';
  if (prState === 'OPEN') return 'awaiting review';
  if (branchExists === false) return 'done';
  return 'in progress';
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/status.mjs test/status.test.mjs
git commit -m "feat: count a deleted branch as evidence of done"
```

---

### Task 3: Drafts and rows learn the Clone rules

**Files:**
- Modify: `lib/workitem.mjs:64-66` (`resumeCommand`)
- Modify: `lib/collect.mjs:38-87` (`buildDraft`, `collectDrafts`)
- Modify: `lib/merge.mjs:3-25` (`mergeRow`)
- Test: `test/workitem.test.mjs`, `test/collect.test.mjs`, `test/merge.test.mjs`

**Interfaces:**
- Consumes: `describeCheckout`, `branchExists` (Task 1); `inferStatus({ branchExists })` (Task 2).
- Produces:
  - `resumeCommand(cwd, sessionId, { switchTo = null } = {})`
  - Draft gains `repo: string|null` and `where.kind: 'orca'|'worktree'|'clone'|'folder'|null` (`null` when the directory no longer exists).
  - Row (written by `mergeRow`) gains `repo` and `where.kind`, both `null` when the draft lacks them.

- [ ] **Step 1: Write the failing tests**

Append to `test/workitem.test.mjs`:

```js
test('resumeCommand can switch to the Work Item branch first, quoted', () => {
  assert.equal(resumeCommand('/w', 's1', { switchTo: "fix/it's" }), "cd '/w' && git switch 'fix/it'\\''s' && claude --resume s1");
  assert.equal(resumeCommand('/w', 's1'), "cd '/w' && claude --resume s1");
});
```

Append to `test/collect.test.mjs`:

```js
const REV_PARSE = 'rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir';
const refsAsk = (cwd, branch) => `git -C ${cwd} for-each-ref --format=%(refname) refs/heads/${branch}`;

test('in a Clone, a deleted branch reads as done and resume switches back to the branch', () => {
  const { env, root } = tmpEnv();
  const cwd = path.join(root, 'proj');
  fs.mkdirSync(cwd);
  writeSession(env, cwd, 's1', sessionLines({ sessionId: 's1', cwd, branch: 'feature/old', start: '2026-09-28T10:00:00.000Z' }));
  writeSession(env, cwd, 's2', sessionLines({ sessionId: 's2', cwd, branch: 'feature/kept', start: '2026-09-29T10:00:00.000Z' }));
  const { drafts } = collectDrafts({
    mode: 'cwd', cwd, env,
    exec: exec({
      [`git -C ${cwd} ${REV_PARSE}`]: `${cwd}\n${cwd}/.git\n${cwd}/.git\n`,
      [`git -C ${cwd} symbolic-ref --quiet --short HEAD`]: 'main\n',
      [refsAsk(cwd, 'feature/old')]: '',
      [refsAsk(cwd, 'feature/kept')]: 'refs/heads/feature/kept\n',
    }),
  });
  const byBranch = Object.fromEntries(drafts.map((d) => [d.branch, d]));
  assert.equal(byBranch['feature/old'].inferredStatus, 'done');
  assert.equal(byBranch['feature/kept'].inferredStatus, 'in progress');
  assert.equal(byBranch['feature/kept'].where.kind, 'clone');
  assert.equal(byBranch['feature/kept'].repo, 'proj');
  assert.match(byBranch['feature/kept'].where.resumeCommand, /&& git switch 'feature\/kept' && claude --resume s2$/);
});

test('in a Worktree, a missing branch never marks done and resume does not switch', () => {
  const { env, root } = tmpEnv();
  const cwd = path.join(root, 'wt');
  fs.mkdirSync(cwd);
  writeSession(env, cwd, 's1', sessionLines({ sessionId: 's1', cwd, branch: 'feature/renamed' }));
  for (const worktrees of [[{ path: cwd, branch: 'refs/heads/feature/new-name', displayName: 'wt' }], []]) {
    const { drafts } = collectDrafts({
      mode: 'cwd', cwd, env,
      exec: exec({
        'orca worktree list --json': JSON.stringify({ result: { worktrees } }),
        [`git -C ${cwd} ${REV_PARSE}`]: `${cwd}\n/r/.git/worktrees/wt\n/r/.git\n`,
        [`git -C ${cwd} symbolic-ref --quiet --short HEAD`]: 'feature/new-name\n',
        [refsAsk(cwd, 'feature/renamed')]: '',
      }),
    });
    assert.equal(drafts[0].inferredStatus, 'in progress');
    assert.equal(drafts[0].where.kind, worktrees.length ? 'orca' : 'worktree');
    assert.equal(drafts[0].repo, 'r');
    assert.doesNotMatch(drafts[0].where.resumeCommand, /git switch/);
  }
});

test('outside git, a Work Item stays in progress and resumes in place', () => {
  const { env, root } = tmpEnv();
  const cwd = path.join(root, 'notes');
  fs.mkdirSync(cwd);
  writeSession(env, cwd, 's1', sessionLines({ sessionId: 's1', cwd, branch: '' }));
  const { drafts } = collectDrafts({ mode: 'cwd', cwd, env, exec: exec() });
  assert.equal(drafts[0].inferredStatus, 'in progress');
  assert.equal(drafts[0].where.kind, 'folder');
  assert.equal(drafts[0].repo, null);
  assert.doesNotMatch(drafts[0].where.resumeCommand, /git switch/);
});
```

Append to `test/merge.test.mjs`:

```js
test('repo and checkout kind travel from draft to row', () => {
  const row = mergeRow(draft({ repo: 'proj', where: { kind: 'clone', displayName: null, path: '/w', resumeCommand: 'cd /w' } }), null, 'x', NOW);
  assert.equal(row.repo, 'proj');
  assert.equal(row.where.kind, 'clone');
  const legacy = mergeRow(draft(), null, 'x', NOW);
  assert.equal(legacy.repo, null);
  assert.equal(legacy.where.kind, null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/workitem.test.mjs test/collect.test.mjs test/merge.test.mjs`
Expected: FAIL. The new `resumeCommand` assertion fails, and the drafts have no `where.kind`.

- [ ] **Step 3: Implement `resumeCommand`** (`lib/workitem.mjs`)

```js
export function resumeCommand(cwd, sessionId, { switchTo = null } = {}) {
  const switchStep = switchTo ? ` && git switch ${shellQuote(switchTo)}` : '';
  return `cd ${shellQuote(cwd)}${switchStep} && claude --resume ${sessionId}`;
}
```

- [ ] **Step 4: Implement the draft changes** (`lib/collect.mjs`)

Change the import from `./external.mjs` to:

```js
import { branchExists, defaultExec, describeCheckout, findWorktree, listOrcaWorktrees, prState } from './external.mjs';
```

Replace `buildDraft` with:

```js
function buildDraft(group, { worktrees, config, exec, checkoutOf }) {
  const latest = group.sessions[group.sessions.length - 1];
  const prUrl = group.sessions.flatMap((s) => s.prUrls).at(-1) ?? null;
  const { title, ticket } = deriveTitle(group.branch, group.cwd);
  const exists = fs.existsSync(group.cwd);
  const checkout = exists ? checkoutOf(group.cwd) : null;
  const githubRepo = ticket && /^\d+$/.test(ticket) ? checkout?.githubRepo ?? null : null;
  const worktree = findWorktree(worktrees, group.cwd);
  // Only a Clone hosts several branches side by side; elsewhere a vanished branch is usually a rename.
  const inClone = checkout?.kind === 'clone';
  return {
    id: group.id,
    title,
    ticket,
    ticketUrl: ticketUrl(ticket, { jiraBaseUrl: config.jiraBaseUrl ?? null, githubRepo }),
    branch: group.branch,
    cwd: group.cwd,
    repo: checkout?.repo ?? null,
    firstActiveAt: group.sessions[0].firstAt,
    lastActiveAt: latest.lastAt,
    sessions: group.sessions.map((s) => ({ id: s.sessionId, lastAt: s.lastAt, aiTitle: s.aiTitle })),
    sessionFiles: group.sessions.map((s) => s.file),
    prUrl,
    inferredStatus: inferStatus({
      prState: prState(prUrl, exec),
      worktreeExists: exists,
      branchExists: inClone ? branchExists(group.cwd, group.branch, exec) : null,
    }),
    where: {
      kind: checkout?.kind ?? null,
      displayName: worktree?.displayName ?? null,
      path: group.cwd,
      resumeCommand: resumeCommand(group.cwd, latest.sessionId, { switchTo: inClone && group.branch ? group.branch : null }),
    },
    digest: { aiTitle: latest.aiTitle, lastPrompt: latest.lastPrompt, recentPrompts: latest.recentPrompts, lastAssistantText: latest.lastAssistantText },
  };
}
```

In `collectDrafts`, replace the `const context = …` line with:

```js
  const worktrees = listOrcaWorktrees(exec);
  const checkouts = new Map();
  const checkoutOf = (dir) => {
    if (!checkouts.has(dir)) checkouts.set(dir, describeCheckout(dir, worktrees, exec));
    return checkouts.get(dir);
  };
  const context = { worktrees, config: readJson(configFile(env), {}), exec, checkoutOf };
```

`githubRepoFor` is no longer imported by `collect.mjs`. It stays exported from `external.mjs`, where `describeCheckout` uses it.

- [ ] **Step 5: Implement the row changes** (`lib/merge.mjs`, inside `mergeRow`)

After `cwd: draft.cwd,` add:

```js
    repo: draft.repo ?? null,
```

Replace the `where:` line with:

```js
    where: { kind: draft.where.kind ?? null, displayName: draft.where.displayName, path: draft.where.path, resumeCommand: draft.where.resumeCommand },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, including every pre-existing collect, merge and CLI test, unedited.

- [ ] **Step 7: Commit**

```bash
git add lib/workitem.mjs lib/collect.mjs lib/merge.mjs test/workitem.test.mjs test/collect.test.mjs test/merge.test.mjs
git commit -m "feat: apply Clone rules to Status and resume, record the repository"
```

---

### Task 4: The page filters by the stored repository

**Files:**
- Modify: `page/view-model.js` (`repoOf`)
- Test: `test/view-model.test.mjs`

**Interfaces:**
- Consumes: the row field `repo` (Task 3).
- Produces: `repoOf(row)` returns `row.repo` when it is set. Otherwise it falls back to the path, so rows written before this change still filter.

- [ ] **Step 1: Write the failing test** (append to `test/view-model.test.mjs`)

```js
test('repoOf prefers the repository recorded by Sync over the path', () => {
  assert.equal(repoOf(row({ repo: 'claude-worklog', cwd: '/o/orca/workspaces/apm/x' })), 'claude-worklog');
  assert.equal(repoOf(row({ repo: null, cwd: '/o/orca/workspaces/apm/x' })), 'apm');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/view-model.test.mjs`
Expected: FAIL (`'apm' !== 'claude-worklog'`).

- [ ] **Step 3: Implement**

Replace the comment and the first line of `repoOf` in `page/view-model.js`:

```js
// Sync records the repository; rows written before it did fall back to the path. Orca Worktrees live at
// <...>/workspaces/<repo>/<worktree>, and any other directory is taken to be the repository itself.
export function repoOf(row) {
  if (row.repo) return row.repo;
  const parts = (row.cwd ?? row.where?.path ?? '').split('/').filter(Boolean);
```

The rest of the function stays as it is.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add page/view-model.js test/view-model.test.mjs
git commit -m "feat(page): filter by the repository Sync records"
```

---

### Task 5: `current` reports the checkout and Orca

**Files:**
- Modify: `bin/worklog.mjs` (`current` case, imports)
- Test: `test/cli.test.mjs`

**Interfaces:**
- Consumes: `describeCheckout`, `orcaAvailable`, `listOrcaWorktrees` (Task 1).
- Produces: `CLI current` prints `{ id, cwd, branch, title, ticket, checkout: { kind, root, repo, githubRepo }, orca: boolean }`. Task 7's SKILL.md branches on `checkout.kind` and `orca`.

- [ ] **Step 1: Write the failing test** (append to `test/cli.test.mjs`)

Add `hasGit, gitRepo` to the import from `./helpers.mjs`.

```js
test('current reports a Clone, and no Orca when the orca CLI is absent', { skip: !hasGit }, () => {
  const { env, root } = tmpEnv();
  const repo = gitRepo(path.join(root, 'proj'), { branch: 'feature/x' });
  const r = run(env, ['current', '--cwd', repo]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.branch, 'feature/x');
  assert.equal(out.checkout.kind, 'clone');
  assert.equal(out.checkout.repo, 'proj');
  assert.equal(out.orca, false);
  const plain = path.join(root, 'plain');
  fs.mkdirSync(plain);
  assert.equal(JSON.parse(run(env, ['current', '--cwd', plain]).stdout).checkout.kind, 'folder');
});
```

`run` sets `PATH=/usr/bin:/bin`, so `git` resolves and `orca` does not.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/cli.test.mjs`
Expected: FAIL (`Cannot read properties of undefined (reading 'kind')`).

- [ ] **Step 3: Implement**

Change the `external.mjs` import in `bin/worklog.mjs` to:

```js
import { currentBranch, describeCheckout, listOrcaWorktrees, orcaAvailable } from '../lib/external.mjs';
```

Replace the `current` case's `print` line with:

```js
    print({ id: workItemId(cwd, branch), cwd, branch, ...deriveTitle(branch, cwd), checkout: describeCheckout(cwd, listOrcaWorktrees()), orca: orcaAvailable() });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/worklog.mjs test/cli.test.mjs
git commit -m "feat: report the checkout kind and Orca from current"
```

---

### Task 6: Drift offers that fit any checkout

**Files:**
- Modify: `lib/drift.mjs:9-10`
- Test: `test/drift.test.mjs`

**Interfaces:**
- Consumes: nothing new. The hook still makes one `git` call (`currentBranch`).
- Produces: `driftContext` text that no longer promises a new Worktree.

- [ ] **Step 1: Write the failing test** (append to `test/drift.test.mjs`)

```js
test('driftContext does not promise a Worktree, which a Clone does not have', () => {
  const text = driftContext({ title: 'Thing', phrase: null });
  assert.doesNotMatch(text, /Worktree/);
  assert.match(text, /new branch/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/drift.test.mjs`
Expected: FAIL (the text matches `/Worktree/`).

- [ ] **Step 3: Implement**

In `driftContext`, replace the two offer lines with:

```js
    `\`/worklog new\` (start a new Work Item and Session for it, carrying this prompt over),`,
    `\`/worklog close\` (finish "${title}" and start a new branch here),`,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS. The existing test still finds `/worklog new` and `/worklog close`.

- [ ] **Step 5: Commit**

```bash
git add lib/drift.mjs test/drift.test.mjs
git commit -m "feat: word the Drift offer for Clones as well as Worktrees"
```

---

### Task 7: Skill, glossary and docs

**Files:**
- Modify: `skills/worklog/SKILL.md` (vocabulary line, **New**, **Close**, **Keeper**)
- Modify: `CONTEXT.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-10-01-worklog-design.md`

**Interfaces:**
- Consumes: `CLI current` → `checkout.kind`, `orca` (Task 5).
- Produces: user-facing instructions only.

- [ ] **Step 1: Vocabulary line in `SKILL.md`**

Replace the first paragraph with:

```markdown
Vocabulary is fixed: Worklog, Work Item, Worktree, Clone, Session, Title, Status, State Phrase, Status Override, Pending Update, Keeper, Archived Transcript, Closing, Drift. Use these words with the user.
```

- [ ] **Step 2: Replace the `## New` section in `SKILL.md`**

```markdown
## New

1. Description: use the argument, or the prompt that triggered the Drift offer, word for word.
2. Ask once: "Ticket number for this?" Accept an answer or a skip, and never ask again.
3. Branch name: `feature/` for new behaviour, `fix/` for correcting existing behaviour. Add `<TICKET>/` if a ticket was given, then a short lowercase hyphenated description of the change. Never a username, never a placeholder.
4. Write the description to `$S/prompt.txt` with the Write tool. Run `CLI current`, then:
   - `orca` is true: do **New in Orca**.
   - `checkout.kind` is `clone` or `worktree`: do **New in place**.
   - `checkout.kind` is `folder`: say this folder isn't a git repository, so its Sessions all belong to one Work Item; offer `git init` or continuing here, and stop.

### New in Orca

1. Run `orca worktree create --name <branch> --agent claude --prompt "$(cat "$S/prompt.txt")" --activate --json`. `<branch>` is safe to put in the command because **New** step 3 limits it to lowercase letters, digits, hyphens, slashes and the ticket ID. If `claude` isn't an accepted agent id, read `orca agent-context --json` for the right one.
2. Read the new worktree's `branch` from the JSON (or `orca worktree show --worktree name:<branch> --json`). If it isn't `<branch>`, run `git -C <path> branch -m <branch>`.
3. Tell the user in one line that the new Session is running in that Worktree, and continue the current Work Item here.

### New in place

1. If `git status --porcelain` shows uncommitted changes, stop and ask the user to commit or stash them first.
2. Find the base with `git symbolic-ref --short refs/remotes/origin/HEAD` (fall back to `origin/main`), then run `git fetch origin` and `git switch -c <branch> <base>`. With no `origin` remote, skip the fetch and use the current branch as the base.
3. Tell the user: the previous Work Item stays open on its branch, and its Copy resume button on the Worklog switches back to it. Then: "Run `/clear` and send this to start the new Session:" followed by the contents of `$S/prompt.txt` in a fenced block.
```

- [ ] **Step 3: Amend `## Close` in `SKILL.md`**

Insert before the current step 1, and renumber the rest:

```markdown
1. Run `CLI current`. If `checkout.kind` is `folder`, stop: this folder isn't a git repository, so it holds one Work Item and there is no branch to cut. Suggest `/worklog done` instead, and say that later Sessions here keep adding to that Work Item.
```

In the step that runs `git fetch origin`, add: "With no `origin` remote, skip the fetch and use the current branch as the base."

- [ ] **Step 4: Amend `## Keeper` in `SKILL.md`**

Replace "in its own Orca terminal, outside any Worktree" with "in its own terminal (an Orca terminal if you use Orca), outside any Worktree or Clone".

- [ ] **Step 5: `CONTEXT.md`**

Replace the **Worktree** entry and add **Clone** after it:

```markdown
**Worktree**:
An isolated working copy of a repository where Sessions run, created by Orca or by `git worktree`. Hosts a sequence of Work Items over time, at most one of them open at once.
_Avoid_: workspace (Orca's UI term for the same thing), checkout

**Clone**:
A repository's main working copy, used without Worktrees. Hosts many Work Items side by side, one per branch, any number of them open; only the checked-out one is being worked on.
_Avoid_: checkout, repo
```

Append to the **Work Item** definition: "Identified by its branch and the directory its Sessions run in."

In **Relationships**, replace the "becomes finished" line, and add two lines after the **Worktree** line:

```markdown
- A **Work Item** becomes finished either by evidence (merged PR, removed **Worktree**, deleted branch in a **Clone**) or by **Closing**
- A **Clone** hosts many **Work Items**, one per branch, any number open at once
- A directory outside any git repository holds a single **Work Item**
```

- [ ] **Step 6: `README.md`**

Replace start step 2 with: "Start the Keeper in its own terminal outside any Worktree or Clone (an Orca terminal if you use Orca): `/loop 30m /worklog`. Orca is optional; without it, `/worklog new` cuts a branch in place."

- [ ] **Step 7: Spec**

In `docs/superpowers/specs/2026-10-01-worklog-design.md`:
- **Rows**, first bullet: replace "one branch in one Orca **Worktree**" with "one branch in one directory: an Orca or git **Worktree**, a **Clone**, or (no branch) a folder outside git".
- **Status**, first bullet: append "; in a **Clone**, a deleted local branch also means `done`, unless its PR is open".
- **Freshness**, second bullet: replace "(`/loop` in Orca, about every 30 minutes)" with "(`/loop` in any terminal, about every 30 minutes)".
- **Commands** table, `new` row: "Start a new Work Item and Session: a new Orca Worktree when Orca is installed, otherwise a new branch in place".

- [ ] **Step 8: Check the wording**

Run: `grep -n -i "orca" skills/worklog/SKILL.md README.md CONTEXT.md docs/superpowers/specs/2026-10-01-worklog-design.md`
Expected: every remaining mention is either the **New in Orca** path or says Orca is optional.

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add skills/worklog/SKILL.md CONTEXT.md README.md docs/superpowers/specs/2026-10-01-worklog-design.md
git commit -m "docs: describe the Worklog in Clones and without Orca"
```

---

## Out of scope

- **Splitting Work Items in a folder outside git.** A Work Item is keyed by directory plus branch, so a folder with no branch is always one Work Item. Supporting more would need a stored close marker per folder.
- **Creating plain `git worktree`s for `/worklog new` without Orca.** Without Orca, New works in place. Existing plain Worktrees are recognised; the plugin just doesn't create them.
- **Backfilling `repo` onto finished rows.** `--recheck` only re-reads open Work Items, so older finished rows keep the path-based fallback in `repoOf`.
