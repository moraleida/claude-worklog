import { execFileSync } from 'node:child_process';
import path from 'node:path';
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

export const orcaAvailable = (exec = defaultExec) => tryExec(exec, 'orca', ['worktree', 'list', '--json']) != null;

// A bare repository's common dir is <name>.git; a normal one is <name>/.git.
function repoNameFromCommonDir(commonDir) {
  const base = path.basename(commonDir);
  return base === '.git' ? path.basename(path.dirname(commonDir)) : base.replace(/\.git$/, '');
}

export function describeCheckout(cwd, worktrees = [], exec = defaultExec) {
  const orca = Boolean(findWorktree(worktrees, cwd));
  const out = tryExec(exec, 'git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']);
  const [root, gitDir, commonDir] = out?.trim().split('\n') ?? [];
  if (!commonDir) return { kind: orca ? 'orca' : 'folder', root: null, repo: null, githubRepo: null };
  const githubRepo = githubRepoFor(cwd, exec);
  const kind = orca ? 'orca' : gitDir !== commonDir ? 'worktree' : 'clone';
  return { kind, root, repo: githubRepo?.split('/')[1] ?? repoNameFromCommonDir(commonDir), githubRepo };
}

// for-each-ref lists nothing for an unborn branch, so the checked-out branch is asked about first.
export function branchExists(cwd, branch, exec = defaultExec) {
  if (!branch) return null;
  const head = tryExec(exec, 'git', ['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'])?.trim();
  if (head === branch) return true;
  const out = tryExec(exec, 'git', ['-C', cwd, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`]);
  if (out == null) return null;
  return out.split('\n').includes(`refs/heads/${branch}`);
}
