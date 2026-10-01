import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readPending } from '../lib/pending.mjs';
import { stateFile, readJson } from '../lib/paths.mjs';
import { tmpEnv, sessionLines, writeSession } from './helpers.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'worklog.mjs');
const run = (env, args, input = '') => spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', env: { ...process.env, ...env, PATH: '/usr/bin:/bin' } });

test('hooks exit 0 silently on empty, malformed or unknown input', () => {
  const { env } = tmpEnv();
  for (const args of [['hook', 'session-end'], ['hook', 'stop'], ['hook', 'prompt'], ['hook', 'nonsense'], ['hook']]) {
    for (const input of ['', '{bad', '[]', 'null']) {
      const r = run(env, args, input);
      assert.equal(r.status, 0, `${args.join(' ')} with ${JSON.stringify(input)}`);
      assert.equal(r.stderr, '');
    }
  }
});

test('session-end records a Pending Update; stop is debounced', () => {
  const { env } = tmpEnv();
  const payload = JSON.stringify({ session_id: 's1', cwd: '/w', transcript_path: '/p/s1.jsonl', reason: 'clear' });
  run(env, ['hook', 'session-end'], payload);
  run(env, ['hook', 'stop'], payload);
  run(env, ['hook', 'stop'], payload);
  const events = readPending(env);
  assert.deepEqual(events.map((e) => e.kind), ['session-end']);
  assert.equal(events[0].reason, 'clear');
  assert.equal(events[0].transcriptPath, '/p/s1.jsonl');
});

test('collect, merge and ack round-trip', () => {
  const { env, root } = tmpEnv();
  const cwd = path.join(root, 'wt');
  fs.mkdirSync(cwd);
  const file = writeSession(env, cwd, 's1', sessionLines({ sessionId: 's1', cwd, branch: 'feature/round-trip' }));
  run(env, ['hook', 'session-end'], JSON.stringify({ session_id: 's1', cwd, transcript_path: file }));

  const collected = run(env, ['collect', '--pending']);
  assert.equal(collected.status, 0, collected.stderr);
  const draftsFile = path.join(root, 'drafts.json');
  fs.writeFileSync(draftsFile, collected.stdout);
  const { drafts } = JSON.parse(collected.stdout);
  assert.equal(drafts.length, 1);

  const phrasesFile = path.join(root, 'phrases.json');
  fs.writeFileSync(phrasesFile, JSON.stringify({ [drafts[0].id]: 'Testing the round trip' }));
  const merged = run(env, ['merge', '--drafts', draftsFile, '--phrases', phrasesFile, '--override', JSON.stringify({ [drafts[0].id]: { statusOverride: 'blocked' } })]);
  assert.equal(merged.status, 0, merged.stderr);
  const { writes } = JSON.parse(merged.stdout);
  assert.equal(writes[0].data.status, 'blocked');
  assert.equal(readJson(stateFile(env), {})[drafts[0].id].phrase, 'Testing the round trip');

  assert.equal(run(env, ['ack', '--drafts', draftsFile]).status, 0);
  assert.equal(JSON.parse(run(env, ['collect', '--pending']).stdout).drafts.length, 0);
});

test('config --set patches and prints; bad commands fail loudly', () => {
  const { env } = tmpEnv();
  const r = run(env, ['config', '--set', 'artifactUrl=https://claude.ai/artifact/x', '--set', 'jiraBaseUrl=https://j']);
  assert.deepEqual(JSON.parse(r.stdout), { artifactUrl: 'https://claude.ai/artifact/x', jiraBaseUrl: 'https://j' });
  assert.notEqual(run(env, ['collect']).status, 0);
  assert.notEqual(run(env, ['frobnicate']).status, 0);
});
