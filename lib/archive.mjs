import fs from 'node:fs';
import path from 'node:path';
import { userText } from './transcript.mjs';
import { normalizeBranch } from './workitem.mjs';
import { transcriptsDir } from './paths.mjs';

export function renderTranscriptMarkdown(lines, { title, sessionId }) {
  const out = [`# ${title}`, '', `Session \`${sessionId}\``, ''];
  let lastRole = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (entry.isSidechain || entry.isMeta) continue;
    if (entry.type === 'user') {
      const text = userText(entry.message);
      if (!text) continue;
      out.push(`## You${entry.timestamp ? ` · ${entry.timestamp}` : ''}`, '', text, '');
      lastRole = 'user';
    } else if (entry.type === 'assistant') {
      const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
      const texts = content.filter((p) => p?.type === 'text').map((p) => p.text);
      const tools = content.filter((p) => p?.type === 'tool_use').map((p) => `> 🔧 ${p.name}`);
      if (!texts.length && !tools.length) continue;
      if (lastRole !== 'assistant') out.push('## Claude', '');
      if (texts.length) out.push(texts.join('\n'), '');
      if (tools.length) out.push(...tools, '');
      lastRole = 'assistant';
    }
  }
  return out.join('\n');
}

export function archiveSlug(branch, cwd) {
  const base = normalizeBranch(branch) || path.basename(cwd) || 'home';
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function archiveWorkItem({ title, branch, cwd, sessionFiles, now = new Date(), env = process.env }) {
  const dir = path.join(transcriptsDir(env), `${now.toISOString().slice(0, 10)}-${archiveSlug(branch, cwd)}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of sessionFiles) {
    const sessionId = path.basename(file, '.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    fs.writeFileSync(path.join(dir, `${sessionId}.md`), renderTranscriptMarkdown(lines, { title, sessionId }));
    fs.copyFileSync(file, path.join(dir, `${sessionId}.jsonl`));
  }
  return dir;
}
