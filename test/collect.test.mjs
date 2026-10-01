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
