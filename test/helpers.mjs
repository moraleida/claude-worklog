import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { projectDirFor } from '../lib/paths.mjs';

export function tmpEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-test-'));
  return {
    root,
    env: { WORKLOG_HOME: path.join(root, 'home'), WORKLOG_CLAUDE_PROJECTS: path.join(root, 'projects') },
  };
}

export function sessionLines({ sessionId, cwd, branch = 'feature/x', prompts = ['do the thing'], start = '2026-09-28T10:00:00.000Z', aiTitle = null, prUrl = null }) {
  const lines = [];
  let t = Date.parse(start);
  const at = () => new Date((t += 60_000)).toISOString();
  for (const prompt of prompts) {
    lines.push(JSON.stringify({ type: 'user', sessionId, cwd, gitBranch: branch, timestamp: at(), isSidechain: false, message: { role: 'user', content: prompt } }));
    lines.push(JSON.stringify({ type: 'assistant', sessionId, cwd, gitBranch: branch, timestamp: at(), isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: `done: ${prompt}` }, { type: 'tool_use', name: 'Bash', input: {} }] } }));
  }
  if (aiTitle) lines.push(JSON.stringify({ type: 'ai-title', aiTitle, sessionId }));
  if (prUrl) lines.push(JSON.stringify({ type: 'pr-link', sessionId, prNumber: 1, prUrl, timestamp: at() }));
  return lines;
}

export function writeSession(env, cwd, sessionId, lines) {
  const dir = projectDirFor(cwd, env);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

export const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

export const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });

export function gitRepo(dir, { branch = 'main', commit = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', branch, dir]);
  if (commit) git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return fs.realpathSync(dir);
}
