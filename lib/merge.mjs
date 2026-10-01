import { effectiveStatus, isFinished } from './status.mjs';

export function mergeRow(draft, existing, phrase, now = new Date()) {
  if (existing?.deleted) return null;
  const statusOverride = existing?.statusOverride ?? null;
  return {
    title: draft.title,
    titleOverride: existing?.titleOverride ?? null,
    ticket: draft.ticket,
    ticketUrl: draft.ticketUrl,
    branch: draft.branch,
    cwd: draft.cwd,
    firstActiveAt: draft.firstActiveAt,
    lastActiveAt: draft.lastActiveAt,
    sessions: draft.sessions.map((s) => ({ id: s.id, lastAt: s.lastAt })),
    prUrl: draft.prUrl,
    where: { displayName: draft.where.displayName, path: draft.where.path, resumeCommand: draft.where.resumeCommand },
    inferredStatus: draft.inferredStatus,
    statusOverride,
    status: effectiveStatus(draft.inferredStatus, statusOverride),
    phrase: phrase ?? existing?.phrase ?? '',
    archivePath: existing?.archivePath ?? null,
    archivedAt: existing?.archivedAt ?? null,
    deleted: false,
    updatedAt: now.toISOString(),
  };
}

export function mergeAll({ drafts, rows = [], phrases = {}, overrides = {}, archive, now = new Date() }) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const writes = [];
  const skipped = [];
  for (const draft of drafts) {
    const base = byId.get(draft.id) ?? null;
    const existing = overrides[draft.id] ? { ...(base ?? {}), ...overrides[draft.id] } : base;
    const row = mergeRow(draft, existing, phrases[draft.id], now);
    if (!row) {
      skipped.push(draft.id);
      continue;
    }
    const resumedAfterArchive = row.archivedAt && row.lastActiveAt > row.archivedAt;
    if (isFinished(row.status) && (!row.archivePath || resumedAfterArchive)) {
      row.archivePath = archive(draft, row);
      row.archivedAt = now.toISOString();
    }
    writes.push({ docId: draft.id, data: row });
  }
  return { writes, skipped };
}

export function buildStateCache(writes, previous = {}) {
  const cache = { ...previous };
  for (const { docId, data } of writes) {
    cache[docId] = { title: data.titleOverride || data.title, phrase: data.phrase, status: data.status };
  }
  return cache;
}
