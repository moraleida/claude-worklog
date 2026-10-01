import fs from 'node:fs';
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
