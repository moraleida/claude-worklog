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
