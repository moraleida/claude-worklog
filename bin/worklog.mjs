#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { appendPending, isDebounced, readPending, releaseClaims } from '../lib/pending.mjs';
import { collectDrafts, parseDuration } from '../lib/collect.mjs';
import { buildStateCache, mergeAll } from '../lib/merge.mjs';
import { archiveWorkItem } from '../lib/archive.mjs';
import { promptHookOutput } from '../lib/drift.mjs';
import { currentBranch } from '../lib/external.mjs';
import { deriveTitle, workItemId } from '../lib/workitem.mjs';
import { isFinished, parseStatusArg } from '../lib/status.mjs';
import { configFile, readJson, stateFile, writeJson } from '../lib/paths.mjs';

const print = (data) => process.stdout.write(JSON.stringify(data, null, 2) + '\n');

function fail(message) {
  process.stderr.write(`worklog: ${message}\n`);
  process.exit(1);
}

function parseFlags(args, options) {
  try {
    return { values: parseArgs({ args, options }).values };
  } catch (e) {
    return fail(e.message);
  }
}

function parseJsonArg(text, label) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  return fail(`${label} must be a JSON object`);
}

function readOverrides({ override, 'override-file': overrideFile }) {
  if (overrideFile) {
    let text;
    try {
      text = fs.readFileSync(overrideFile, 'utf8');
    } catch {
      fail(`cannot read --override-file ${overrideFile}`);
    }
    return checkStatuses(parseJsonArg(text, '--override-file'));
  }
  return override ? checkStatuses(parseJsonArg(override, '--override')) : {};
}

function checkStatuses(overrides) {
  for (const value of Object.values(overrides)) {
    if (value?.statusOverride == null) continue;
    const status = parseStatusArg(value.statusOverride);
    if (!status) fail(`invalid status "${value.statusOverride}"`);
    value.statusOverride = status;
  }
  return overrides;
}

function readStdinJson() {
  try {
    const parsed = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function runHook(event) {
  const input = readStdinJson();
  const base = { sessionId: input.session_id ?? null, cwd: input.cwd ?? null, transcriptPath: input.transcript_path ?? null };
  switch (event) {
    case 'session-end':
      appendPending({ kind: 'session-end', ...base, reason: input.reason ?? null });
      break;
    case 'stop':
      if (base.sessionId && !isDebounced(readPending(), base.sessionId)) appendPending({ kind: 'turn', ...base });
      break;
    case 'compact':
      appendPending({ kind: 'compact', ...base });
      break;
    case 'prompt': {
      if (!base.cwd || typeof input.prompt !== 'string') break;
      const out = promptHookOutput({ prompt: input.prompt, cwd: base.cwd, branch: currentBranch(base.cwd), state: readJson(stateFile(), {}) });
      if (out) process.stdout.write(out);
      break;
    }
  }
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case 'hook': {
    // A failing hook would surface as an error inside the user's unrelated Session.
    try {
      runHook(args[0]);
    } catch {}
    process.exit(0);
  }
  case 'collect': {
    const { values } = parseFlags(args, { pending: { type: 'boolean' }, since: { type: 'string' }, cwd: { type: 'string' }, recheck: { type: 'string' } });
    const mode = values.pending ? 'pending' : values.since ? 'since' : values.cwd ? 'cwd' : null;
    if (!mode) fail('collect needs --pending, --since <window> or --cwd <path>');
    const rows = values.recheck ? readJson(values.recheck, []) : [];
    const recheckCwds = rows.filter((r) => !r.deleted && !isFinished(r.status) && r.cwd).map((r) => r.cwd);
    let sinceMs;
    if (values.since) {
      try {
        sinceMs = Date.now() - parseDuration(values.since);
      } catch (e) {
        fail(e.message);
      }
    }
    print(collectDrafts({ mode, sinceMs, cwd: values.cwd, recheckCwds }));
    break;
  }
  case 'merge': {
    const { values } = parseFlags(args, { drafts: { type: 'string' }, rows: { type: 'string' }, phrases: { type: 'string' }, override: { type: 'string' }, 'override-file': { type: 'string' } });
    if (!values.drafts) fail('merge needs --drafts <file>');
    const { drafts = [] } = readJson(values.drafts, {});
    const result = mergeAll({
      drafts,
      rows: values.rows ? readJson(values.rows, []) : [],
      phrases: values.phrases ? readJson(values.phrases, {}) : {},
      overrides: readOverrides(values),
      archive: (draft, row) => archiveWorkItem({ title: row.titleOverride || row.title, branch: draft.branch, cwd: draft.cwd, sessionFiles: draft.sessionFiles }),
    });
    writeJson(stateFile(), buildStateCache(result.writes, readJson(stateFile(), {})));
    print(result);
    break;
  }
  case 'ack': {
    const { values } = parseFlags(args, { drafts: { type: 'string' } });
    if (!values.drafts) fail('ack needs --drafts <file>');
    const { claimFiles = [] } = readJson(values.drafts, {});
    releaseClaims(claimFiles);
    print({ released: claimFiles.length });
    break;
  }
  case 'current': {
    const { values } = parseFlags(args, { cwd: { type: 'string' } });
    const cwd = values.cwd ?? process.cwd();
    const branch = currentBranch(cwd);
    print({ id: workItemId(cwd, branch), cwd, branch, ...deriveTitle(branch, cwd) });
    break;
  }
  case 'config': {
    const { values } = parseFlags(args, { set: { type: 'string', multiple: true } });
    const config = readJson(configFile(), {});
    for (const pair of values.set ?? []) {
      const at = pair.indexOf('=');
      if (at < 1) fail(`--set expects key=value, got "${pair}"`);
      config[pair.slice(0, at)] = pair.slice(at + 1);
    }
    if (values.set?.length) writeJson(configFile(), config);
    print(config);
    break;
  }
  default:
    fail(`unknown command "${command ?? ''}". Use hook, collect, merge, ack, current or config.`);
}
