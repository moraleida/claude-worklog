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

test('resumeCommand can switch to the Work Item branch first, quoted', () => {
  assert.equal(resumeCommand('/w', 's1', { switchTo: "fix/it's" }), "cd '/w' && git switch 'fix/it'\\''s' && claude --resume s1");
  assert.equal(resumeCommand('/w', 's1'), "cd '/w' && claude --resume s1");
});
