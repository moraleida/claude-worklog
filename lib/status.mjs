export const STATUSES = ['in progress', 'blocked', 'awaiting review', 'done', 'abandoned'];

export function inferStatus({ prState = null, worktreeExists = true } = {}) {
  if (prState === 'MERGED' || !worktreeExists) return 'done';
  if (prState === 'OPEN') return 'awaiting review';
  return 'in progress';
}

export const effectiveStatus = (inferred, override) => override ?? inferred;

export const isFinished = (status) => status === 'done' || status === 'abandoned';

export function parseStatusArg(arg) {
  const normalized = String(arg ?? '').trim().toLowerCase().replace(/[-_]+/g, ' ');
  return STATUSES.includes(normalized) ? normalized : null;
}
