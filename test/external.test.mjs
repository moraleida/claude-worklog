import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listOrcaWorktrees, findWorktree, prState, githubRepoFor, currentBranch, describeCheckout, branchExists, orcaAvailable } from '../lib/external.mjs';
import { tmpEnv, hasGit, git, gitRepo } from './helpers.mjs';

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

test('currentBranch gives git a short timeout for the prompt hook', () => {
  let opts;
  currentBranch('/w', (cmd, args, o) => { opts = o; return 'main\n'; });
  assert.ok(opts.timeout <= 1500);
});

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
