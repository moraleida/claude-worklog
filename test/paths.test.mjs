import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { worklogHome, claudeProjectsDir, pendingFile, projectDirFor, readJson, writeJson } from '../lib/paths.mjs';

test('roots honour env overrides', () => {
  const env = { WORKLOG_HOME: '/tmp/wl', WORKLOG_CLAUDE_PROJECTS: '/tmp/projects' };
  assert.equal(worklogHome(env), '/tmp/wl');
  assert.equal(claudeProjectsDir(env), '/tmp/projects');
  assert.equal(pendingFile(env), '/tmp/wl/pending.jsonl');
});

test('roots default under the home directory', () => {
  assert.equal(worklogHome({}), path.join(os.homedir(), 'worklog'));
  assert.equal(claudeProjectsDir({}), path.join(os.homedir(), '.claude', 'projects'));
});

test('projectDirFor matches Claude Code project directory naming', () => {
  const env = { WORKLOG_CLAUDE_PROJECTS: '/p' };
  assert.equal(
    projectDirFor('/Users/moraleida/orca/workspaces/general/work-tracking-skill', env),
    '/p/-Users-moraleida-orca-workspaces-general-work-tracking-skill',
  );
});

test('readJson falls back on missing or corrupt files; writeJson creates parents', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-paths-'));
  const file = path.join(dir, 'nested', 'x.json');
  assert.deepEqual(readJson(file, { a: 1 }), { a: 1 });
  writeJson(file, { b: 2 });
  assert.deepEqual(readJson(file, null), { b: 2 });
  fs.writeFileSync(file, '{nope');
  assert.deepEqual(readJson(file, []), []);
});
