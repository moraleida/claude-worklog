import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'trunk']);
const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;
const NUMERIC = /^\d+$/;

export function normalizeBranch(branch) {
  if (!branch) return '';
  const b = branch.replace(/^refs\/heads\//, '');
  return b === 'HEAD' ? '' : b;
}

export function workItemId(cwd, branch) {
  const hash = crypto.createHash('sha1').update(`${cwd}\0${normalizeBranch(branch)}`).digest('hex');
  return `wi_${hash.slice(0, 12)}`;
}

function humanize(segment) {
  const words = segment.replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}

function placeName(cwd, home) {
  return cwd === home ? '~' : path.basename(cwd);
}

export function deriveTitle(branch, cwd, home = os.homedir()) {
  const b = normalizeBranch(branch);
  if (!b) return { title: placeName(cwd, home), ticket: null };
  if (DEFAULT_BRANCHES.has(b)) return { title: `${placeName(cwd, home)} · ${b}`, ticket: null };
  const segments = b.split('/').filter(Boolean);
  const ticket = segments.slice(0, -1).find((s) => JIRA_KEY.test(s) || NUMERIC.test(s)) ?? null;
  return { title: humanize(segments[segments.length - 1]), ticket };
}

export function ticketUrl(ticket, { jiraBaseUrl = null, githubRepo = null } = {}) {
  if (!ticket) return null;
  if (JIRA_KEY.test(ticket) && jiraBaseUrl) return `${jiraBaseUrl.replace(/\/+$/, '')}/browse/${ticket}`;
  if (NUMERIC.test(ticket) && githubRepo) return `https://github.com/${githubRepo}/issues/${ticket}`;
  return null;
}

export function parseGithubRemote(url) {
  const match = /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url ?? '');
  return match ? match[1] : null;
}

export function groupSessions(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    const branch = normalizeBranch(session.gitBranch);
    const id = workItemId(session.cwd, branch);
    if (!groups.has(id)) groups.set(id, { id, cwd: session.cwd, branch, sessions: [] });
    groups.get(id).sessions.push(session);
  }
  for (const group of groups.values()) group.sessions.sort((a, b) => a.lastAt.localeCompare(b.lastAt));
  return groups;
}

const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

export function resumeCommand(cwd, sessionId, { switchTo = null } = {}) {
  const switchStep = switchTo ? ` && git switch ${shellQuote(switchTo)}` : '';
  return `cd ${shellQuote(cwd)}${switchStep} && claude --resume ${sessionId}`;
}
