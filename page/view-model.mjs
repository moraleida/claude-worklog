const DAY = 86_400_000;
const FINISHED = new Set(['done', 'abandoned']);

export function tierOf(lastActiveAt, now) {
  const age = now - Date.parse(lastActiveAt);
  if (age <= 7 * DAY) return 'week';
  if (age <= 30 * DAY) return 'month';
  return 'older';
}

export const displayTitle = (row) => row.titleOverride || row.title;

export function matches(row, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = [
    displayTitle(row), row.branch, row.ticket, row.phrase, row.status, row.cwd,
    row.where?.displayName, ...(row.sessions ?? []).map((s) => s.id),
  ].filter(Boolean).join(' ').toLowerCase();
  return words.every((w) => haystack.includes(w));
}

export function whereOf(row) {
  if (FINISHED.has(row.status) && row.archivePath) return { kind: 'archive', path: row.archivePath };
  return { kind: 'live', displayName: row.where?.displayName ?? null, path: row.where?.path ?? row.cwd, resumeCommand: row.where?.resumeCommand ?? null, prUrl: row.prUrl ?? null };
}

export function buildView(rows, { query = '', now = Date.now() } = {}) {
  const live = rows.filter((r) => !r.deleted);
  const shown = live.filter((r) => matches(r, query)).sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  const view = { week: [], month: [], older: [], total: live.length, shown: shown.length };
  for (const r of shown) view[tierOf(r.lastActiveAt, now)].push(r);
  return view;
}
