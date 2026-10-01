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
