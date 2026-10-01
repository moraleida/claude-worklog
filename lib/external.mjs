import { execFileSync } from 'node:child_process';
import { normalizeBranch, parseGithubRemote } from './workitem.mjs';

export function defaultExec(cmd, args, { cwd, timeout = 8000 } = {}) {
  return execFileSync(cmd, args, { cwd, timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function tryExec(exec, cmd, args, options) {
  try {
    return exec(cmd, args, options);
  } catch {
    return null;
  }
}

export function listOrcaWorktrees(exec = defaultExec) {
  const out = tryExec(exec, 'orca', ['worktree', 'list', '--json']);
  if (!out) return [];
  try {
    return (JSON.parse(out).result?.worktrees ?? []).map((w) => ({
      path: w.path,
      branch: normalizeBranch(w.branch),
      displayName: w.displayName ?? null,
      isArchived: Boolean(w.isArchived),
    }));
  } catch {
    return [];
  }
}

export function findWorktree(worktrees, cwd) {
  let best = null;
  for (const w of worktrees) {
    if (!w.path || (cwd !== w.path && !cwd.startsWith(w.path + '/'))) continue;
    if (!best || w.path.length > best.path.length) best = w;
  }
  return best;
}

export function prState(prUrl, exec = defaultExec) {
  if (!prUrl) return null;
  const state = tryExec(exec, 'gh', ['pr', 'view', prUrl, '--json', 'state', '-q', '.state'])?.trim();
  return ['OPEN', 'MERGED', 'CLOSED'].includes(state) ? state : null;
}

export function githubRepoFor(cwd, exec = defaultExec) {
  return parseGithubRemote(tryExec(exec, 'git', ['-C', cwd, 'remote', 'get-url', 'origin'])?.trim());
}

// The prompt hook runs this on every user prompt, so it must not wait the default 8s on a hung git.
export function currentBranch(cwd, exec = defaultExec, { timeout = 1500 } = {}) {
  const out = tryExec(exec, 'git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout });
  return out ? normalizeBranch(out.trim()) : '';
}
