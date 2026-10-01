import fs from 'node:fs';
import path from 'node:path';
import { claudeProjectsDir, configFile, projectDirFor, readJson } from './paths.mjs';
import { readSessionFile } from './transcript.mjs';
import { deriveTitle, groupSessions, resumeCommand, ticketUrl } from './workitem.mjs';
import { inferStatus } from './status.mjs';
import { claimPending } from './pending.mjs';
import { defaultExec, findWorktree, githubRepoFor, listOrcaWorktrees, prState } from './external.mjs';

const UNITS = { d: 86_400_000, h: 3_600_000 };

export function parseDuration(text) {
  if (text === 'all') return Infinity;
  const match = /^(\d+)([dh])$/.exec(String(text ?? ''));
  if (!match) throw new Error(`invalid window "${text}": use e.g. 30d, 12h or all`);
  return Number(match[1]) * UNITS[match[2]];
}

export function listSessionFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

function allProjectDirs(env) {
  const root = claudeProjectsDir(env);
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name));
  } catch {
    return [];
  }
}

function buildDraft(group, { worktrees, config, exec }) {
  const latest = group.sessions[group.sessions.length - 1];
  const prUrl = group.sessions.flatMap((s) => s.prUrls).at(-1) ?? null;
  const { title, ticket } = deriveTitle(group.branch, group.cwd);
  const githubRepo = ticket && /^\d+$/.test(ticket) ? githubRepoFor(group.cwd, exec) : null;
  const worktree = findWorktree(worktrees, group.cwd);
  return {
    id: group.id,
    title,
    ticket,
    ticketUrl: ticketUrl(ticket, { jiraBaseUrl: config.jiraBaseUrl ?? null, githubRepo }),
    branch: group.branch,
    cwd: group.cwd,
    firstActiveAt: group.sessions[0].firstAt,
    lastActiveAt: latest.lastAt,
    sessions: group.sessions.map((s) => ({ id: s.sessionId, lastAt: s.lastAt, aiTitle: s.aiTitle })),
    sessionFiles: group.sessions.map((s) => s.file),
    prUrl,
    inferredStatus: inferStatus({ prState: prState(prUrl, exec), worktreeExists: fs.existsSync(group.cwd) }),
    where: { displayName: worktree?.displayName ?? null, path: group.cwd, resumeCommand: resumeCommand(group.cwd, latest.sessionId) },
    digest: { aiTitle: latest.aiTitle, lastPrompt: latest.lastPrompt, recentPrompts: latest.recentPrompts, lastAssistantText: latest.lastAssistantText },
  };
}

export function collectDrafts({ mode, sinceMs = -Infinity, cwd = null, recheckCwds = [], env = process.env, exec = defaultExec } = {}) {
  let claimFiles = [];
  const dirs = new Set();
  if (mode === 'pending') {
    const claim = claimPending(env);
    claimFiles = claim.claimFiles;
    for (const event of claim.events) {
      if (event.transcriptPath) dirs.add(path.dirname(event.transcriptPath));
      else if (event.cwd) dirs.add(projectDirFor(event.cwd, env));
    }
  } else if (mode === 'since') {
    for (const dir of allProjectDirs(env)) dirs.add(dir);
  } else if (mode === 'cwd') {
    dirs.add(projectDirFor(cwd, env));
  } else {
    throw new Error(`unknown collect mode: ${mode}`);
  }
  for (const c of recheckCwds) dirs.add(projectDirFor(c, env));

  const sessions = [...dirs].flatMap(listSessionFiles).map(readSessionFile).filter(Boolean);
  const context = { worktrees: listOrcaWorktrees(exec), config: readJson(configFile(env), {}), exec };
  let drafts = [...groupSessions(sessions).values()].map((group) => buildDraft(group, context));
  if (mode === 'since') drafts = drafts.filter((d) => Date.parse(d.lastActiveAt) >= sinceMs);
  drafts.sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  return { claimFiles, drafts };
}
