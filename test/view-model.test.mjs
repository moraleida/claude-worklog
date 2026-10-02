import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierOf, displayTitle, matches, whereOf, buildView, repoOf, repoOptions } from '../page/view-model.js';

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

test('repository comes from the Orca workspace folder, else the working directory name', () => {
  assert.equal(repoOf(row({ cwd: '/Users/me/orca/workspaces/apm/cusk' })), 'apm');
  assert.equal(repoOf(row({ cwd: '/Users/me/dev/ncu-gtf-local/' })), 'ncu-gtf-local');
  assert.equal(repoOf(row({ cwd: null, where: { path: '/Users/me/ops/apm' } })), 'apm');
  assert.equal(repoOf(row({ cwd: null, where: null })), null);
});

test('repoOptions lists each repository of live rows once, sorted', () => {
  const rows = [
    row({ cwd: '/o/orca/workspaces/zeta/a' }), row({ cwd: '/o/orca/workspaces/apm/b' }),
    row({ cwd: '/o/orca/workspaces/apm/c' }), row({ cwd: '/o/orca/workspaces/gone/d', deleted: true }),
  ];
  assert.deepEqual(repoOptions(rows), ['apm', 'zeta']);
});

test('buildView filters by status, repository and last-active date range', () => {
  const rows = [
    row({ id: 'a', status: 'done', cwd: '/o/orca/workspaces/apm/x', lastActiveAt: daysAgo(2) }),
    row({ id: 'b', status: 'in progress', cwd: '/o/orca/workspaces/apm/y', lastActiveAt: daysAgo(5) }),
    row({ id: 'c', status: 'in progress', cwd: '/o/orca/workspaces/gtf/z', lastActiveAt: daysAgo(40) }),
  ];
  const ids = (v) => [...v.week, ...v.month, ...v.older].map((r) => r.id);
  assert.deepEqual(ids(buildView(rows, { now: NOW, status: 'in progress' })), ['b', 'c']);
  assert.deepEqual(ids(buildView(rows, { now: NOW, repo: 'apm' })), ['a', 'b']);
  assert.deepEqual(ids(buildView(rows, { now: NOW, since: NOW - 3 * 86_400_000 })), ['a']);
  assert.deepEqual(ids(buildView(rows, { now: NOW, until: NOW - 3 * 86_400_000 })), ['b', 'c']);
  const both = buildView(rows, { now: NOW, status: 'in progress', repo: 'apm' });
  assert.deepEqual(ids(both), ['b']);
  assert.equal(both.shown, 1);
  assert.equal(both.total, 3);
});

test('repoOf prefers the repository recorded by Sync over the path', () => {
  assert.equal(repoOf(row({ repo: 'claude-worklog', cwd: '/o/orca/workspaces/apm/x' })), 'claude-worklog');
  assert.equal(repoOf(row({ repo: null, cwd: '/o/orca/workspaces/apm/x' })), 'apm');
});
