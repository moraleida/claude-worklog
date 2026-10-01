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
