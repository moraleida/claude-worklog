import { DEFAULT_BRANCHES, deriveTitle, workItemId } from './workitem.mjs';
import { isFinished } from './status.mjs';

export function driftContext({ title, phrase }) {
  const state = phrase ? ` (last known state: ${phrase})` : '';
  return [
    `[worklog] This Session belongs to the open Work Item "${title}"${state}.`,
    `If the user's prompt pursues a clearly different subject, do not start on it yet. Reply with one short line offering:`,
    `\`/worklog new\` (start a new Worktree and Session for it, carrying this prompt over),`,
    `\`/worklog close\` (finish "${title}" and reuse this Worktree with a new branch),`,
    `or continuing here. If the prompt is related, ignore this note and do not mention it.`,
  ].join(' ');
}

export function promptHookOutput({ prompt, cwd, branch, state }) {
  if (prompt.trim().startsWith('/')) return null;
  if (!branch || DEFAULT_BRANCHES.has(branch)) return null;
  const cached = state?.[workItemId(cwd, branch)];
  if (cached && isFinished(cached.status)) return null;
  const title = cached?.title ?? deriveTitle(branch, cwd).title;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: driftContext({ title, phrase: cached?.phrase }) },
  });
}
