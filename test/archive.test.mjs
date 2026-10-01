import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderTranscriptMarkdown, archiveSlug, archiveWorkItem } from '../lib/archive.mjs';
import { transcriptsDir } from '../lib/paths.mjs';
import { tmpEnv, sessionLines, writeSession } from './helpers.mjs';

test('markdown shows prompts and replies, collapses tools, merges consecutive replies', () => {
  const lines = sessionLines({ sessionId: 's1', cwd: '/w', prompts: ['first ask'] });
  lines.push(JSON.stringify({ type: 'assistant', sessionId: 's1', message: { content: [{ type: 'text', text: 'more' }] } }));
  lines.push(JSON.stringify({ type: 'user', sessionId: 's1', message: { content: [{ type: 'tool_result', content: 'SECRET OUTPUT' }] } }));
  const md = renderTranscriptMarkdown(lines, { title: 'Worklog plugin', sessionId: 's1' });
  assert.match(md, /^# Worklog plugin/);
  assert.match(md, /## You/);
  assert.match(md, /first ask/);
  assert.match(md, /> 🔧 Bash/);
  assert.equal(md.match(/## Claude/g).length, 1);
  assert.doesNotMatch(md, /SECRET OUTPUT/);
});

test('archiveSlug comes from the branch, else the folder', () => {
  assert.equal(archiveSlug('feature/NYP-3322/reviewer-assignment', '/w'), 'feature-nyp-3322-reviewer-assignment');
  assert.equal(archiveSlug('', '/Users/me/notes'), 'notes');
});

test('archiveWorkItem writes markdown and raw jsonl per Session', () => {
  const { env } = tmpEnv();
  const file = writeSession(env, '/w/a', 's9', sessionLines({ sessionId: 's9', cwd: '/w/a' }));
  const dir = archiveWorkItem({ title: 'A', branch: 'fix/a', cwd: '/w/a', sessionFiles: [file], now: new Date('2026-10-01T12:00:00Z'), env });
  assert.equal(dir, path.join(transcriptsDir(env), '2026-10-01-fix-a'));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['s9.jsonl', 's9.md']);
  assert.equal(fs.readFileSync(path.join(dir, 's9.jsonl'), 'utf8'), fs.readFileSync(file, 'utf8'));
});

test('markdown rendering skips JSON lines that are not objects', () => {
  const lines = ['null', '42', ...sessionLines({ sessionId: 's1', cwd: '/w', prompts: ['hello'] })];
  assert.match(renderTranscriptMarkdown(lines, { title: 'T', sessionId: 's1' }), /hello/);
});
