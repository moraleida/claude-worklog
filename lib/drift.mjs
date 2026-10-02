import { DEFAULT_BRANCHES, deriveTitle, workItemId } from './workitem.mjs';
import { isFinished } from './status.mjs';

export function driftContext({ title, phrase }) {
  const state = phrase ? ` (last known state: ${phrase})` : '';
  return [
    `[worklog] Drift check. This Session belongs to the open Work Item "${title}"${state}.`,
    `Before answering, decide whether the user's prompt is part of that Work Item.`,
    `If it is not — a different subject, even a quick or harmless question — do not answer it.`,
    `Reply only with one short line saying it looks like a different subject, and offer:`,
    `\`/worklog new\` (start a new Work Item and Session for it, carrying this prompt over),`,
    `\`/worklog close\` (finish "${title}" and start a new branch here),`,
    `or "continue here" (answer it in this Session anyway).`,
    `If it is part of the Work Item, answer normally and never mention this note.`,
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
