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
