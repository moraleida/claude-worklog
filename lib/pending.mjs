import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pendingFile, worklogHome } from './paths.mjs';

const CLAIM_SUFFIX = '.claimed.jsonl';

function readEventsFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

export function appendPending(event, env = process.env, now = new Date()) {
  const file = pendingFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = { id: crypto.randomUUID(), at: now.toISOString(), ...event };
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
  return record;
}

export const readPending = (env = process.env) => readEventsFile(pendingFile(env));

export function isDebounced(events, sessionId, now = new Date(), windowMs = 120_000) {
  return events.some((e) => e.sessionId === sessionId && now.getTime() - Date.parse(e.at) < windowMs);
}

export function claimPending(env = process.env, now = new Date()) {
  const home = worklogHome(env);
  const file = pendingFile(env);
  try {
    let targetPath = path.join(home, `pending-${now.getTime()}-${process.pid}${CLAIM_SUFFIX}`);
    let counter = 0;
    while (fs.existsSync(targetPath)) {
      targetPath = path.join(home, `pending-${now.getTime()}-${process.pid}-${counter}${CLAIM_SUFFIX}`);
      counter++;
    }
    fs.renameSync(file, targetPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  let names;
  try {
    names = fs.readdirSync(home);
  } catch {
    return { claimFiles: [], events: [] };
  }
  const claimFiles = names.filter((n) => n.endsWith(CLAIM_SUFFIX)).sort().map((n) => path.join(home, n));
  const seen = new Set();
  const events = [];
  for (const claimFile of claimFiles) {
    for (const event of readEventsFile(claimFile)) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      events.push(event);
    }
  }
  return { claimFiles, events };
}

export function releaseClaims(claimFiles) {
  for (const file of claimFiles) fs.rmSync(file, { force: true });
}
