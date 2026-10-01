import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driftContext, promptHookOutput } from '../lib/drift.mjs';
import { workItemId } from '../lib/workitem.mjs';

test('driftContext names the Work Item and both ways out', () => {
  const text = driftContext({ title: 'Worklog plugin', phrase: 'Writing the CLI' });
  assert.match(text, /"Worklog plugin"/);
  assert.match(text, /Writing the CLI/);
  assert.match(text, /\/worklog new/);
  assert.match(text, /\/worklog close/);
});

test('promptHookOutput uses the cached title and emits hook JSON', () => {
  const id = workItemId('/w', 'feature/thing');
  const out = JSON.parse(promptHookOutput({ prompt: 'fix my zshrc', cwd: '/w', branch: 'feature/thing', state: { [id]: { title: 'Mine', phrase: 'p', status: 'in progress' } } }));
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /"Mine"/);
});

test('promptHookOutput falls back to the branch-derived title', () => {
  const out = JSON.parse(promptHookOutput({ prompt: 'hello', cwd: '/w', branch: 'feature/new-thing', state: {} }));
  assert.match(out.hookSpecificOutput.additionalContext, /"New thing"/);
});

test('promptHookOutput stays silent where Drift does not apply', () => {
  const id = workItemId('/w', 'feature/x');
  assert.equal(promptHookOutput({ prompt: '/worklog', cwd: '/w', branch: 'feature/x', state: {} }), null);
  assert.equal(promptHookOutput({ prompt: 'hi', cwd: '/w', branch: 'main', state: {} }), null);
  assert.equal(promptHookOutput({ prompt: 'hi', cwd: '/w', branch: '', state: {} }), null);
  assert.equal(promptHookOutput({ prompt: 'hi', cwd: '/w', branch: 'feature/x', state: { [id]: { title: 'X', status: 'done' } } }), null);
});
