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
