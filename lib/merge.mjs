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
    repo: draft.repo ?? null,
    firstActiveAt: draft.firstActiveAt,
    lastActiveAt: draft.lastActiveAt,
    sessions: draft.sessions.map((s) => ({ id: s.id, lastAt: s.lastAt })),
    prUrl: draft.prUrl,
    where: { kind: draft.where.kind ?? null, displayName: draft.where.displayName, path: draft.where.path, resumeCommand: draft.where.resumeCommand },
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
  const archiveErrors = [];
  const unchanged = [];
  for (const draft of drafts) {
    const base = byId.get(draft.id) ?? null;
    const existing = overrides[draft.id] ? { ...(base ?? {}), ...overrides[draft.id] } : base;
    const row = mergeRow(draft, existing, phrases[draft.id], now);
    if (!row) {
      skipped.push(draft.id);
      continue;
    }
    let archived = false;
    const resumedAfterArchive = row.archivedAt && row.lastActiveAt > row.archivedAt;
    if (isFinished(row.status) && (!row.archivePath || resumedAfterArchive)) {
      try {
        row.archivePath = archive(draft, row);
        row.archivedAt = now.toISOString();
        archived = true;
      } catch (e) {
        archiveErrors.push({ id: draft.id, message: e?.message ?? String(e) });
      }
    }
    if (draft.changed === false && !overrides[draft.id] && !archived) {
      unchanged.push(draft.id);
      continue;
    }
    writes.push({ docId: draft.id, ifVersion: base?.version ?? null, data: row });
  }
  return { writes, skipped, unchanged, archiveErrors };
}

export function buildStateCache(writes, previous = {}) {
  const cache = { ...previous };
  for (const { docId, data } of writes) {
    cache[docId] = { title: data.titleOverride || data.title, phrase: data.phrase, status: data.status };
  }
  return cache;
}
