import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userText, parseSessionLines, readSessionFile } from '../lib/transcript.mjs';
import { tmpEnv, sessionLines, writeSession } from './helpers.mjs';

test('userText reads strings and text parts, ignores tool results', () => {
  assert.equal(userText({ content: 'hi' }), 'hi');
  assert.equal(userText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(userText({ content: [{ type: 'tool_result', content: 'x' }] }), null);
  assert.equal(userText({ content: '   ' }), null);
});

test('parseSessionLines extracts identity, timing, titles and PR links', () => {
  const lines = sessionLines({ sessionId: 's1', cwd: '/w/a', branch: 'fix/9/bug', prompts: ['one', 'two'], aiTitle: 'Fix bug', prUrl: 'https://github.com/o/r/pull/1' });
  const info = parseSessionLines(lines);
  assert.equal(info.sessionId, 's1');
  assert.equal(info.cwd, '/w/a');
  assert.equal(info.gitBranch, 'fix/9/bug');
  assert.equal(info.userPromptCount, 2);
  assert.deepEqual(info.recentPrompts, ['one', 'two']);
  assert.equal(info.lastAssistantText, 'done: two');
  assert.equal(info.aiTitle, 'Fix bug');
  assert.deepEqual(info.prUrls, ['https://github.com/o/r/pull/1']);
  assert.ok(info.firstAt < info.lastAt);
});

test('parseSessionLines skips malformed lines, sidechains and meta lines', () => {
  const lines = [
    '{not json',
    JSON.stringify({ type: 'user', sessionId: 's2', cwd: '/w', gitBranch: 'main', timestamp: '2026-09-01T00:00:00.000Z', isSidechain: true, message: { content: 'side' } }),
    JSON.stringify({ type: 'user', sessionId: 's2', cwd: '/w', gitBranch: 'main', timestamp: '2026-09-01T00:01:00.000Z', isMeta: true, message: { content: 'meta' } }),
    JSON.stringify({ type: 'user', sessionId: 's2', cwd: '/w', gitBranch: 'main', timestamp: '2026-09-01T00:02:00.000Z', message: { content: 'real' } }),
  ];
  const info = parseSessionLines(lines);
  assert.equal(info.userPromptCount, 1);
  assert.deepEqual(info.recentPrompts, ['real']);
});

test('parseSessionLines returns null for a session with no conversation', () => {
  assert.equal(parseSessionLines([JSON.stringify({ type: 'ai-title', aiTitle: 'x', sessionId: 's' })]), null);
});

test('long prompts are clipped and only the last five kept', () => {
  const prompts = ['p1', 'p2', 'p3', 'p4', 'p5', 'x'.repeat(1000)];
  const info = parseSessionLines(sessionLines({ sessionId: 's', cwd: '/w', prompts }));
  assert.equal(info.recentPrompts.length, 5);
  assert.equal(info.recentPrompts[0], 'p2');
  assert.ok(info.recentPrompts[4].length <= 300);
});

test('readSessionFile records its path and tolerates unreadable files', () => {
  const { env } = tmpEnv();
  const file = writeSession(env, '/w/b', 's3', sessionLines({ sessionId: 's3', cwd: '/w/b' }));
  assert.equal(readSessionFile(file).file, file);
  assert.equal(readSessionFile('/nonexistent/x.jsonl'), null);
});
