import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function worklogHome(env = process.env) {
  return env.WORKLOG_HOME || path.join(os.homedir(), 'worklog');
}

export function claudeProjectsDir(env = process.env) {
  return env.WORKLOG_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
}

export const pendingFile = (env = process.env) => path.join(worklogHome(env), 'pending.jsonl');
export const stateFile = (env = process.env) => path.join(worklogHome(env), 'state.json');
export const configFile = (env = process.env) => path.join(worklogHome(env), 'config.json');
export const transcriptsDir = (env = process.env) => path.join(worklogHome(env), 'transcripts');

export function projectDirFor(cwd, env = process.env) {
  return path.join(claudeProjectsDir(env), cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
