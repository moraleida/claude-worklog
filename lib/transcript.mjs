import fs from 'node:fs';

const PROMPT_LIMIT = 300;
const ASSISTANT_LIMIT = 600;
const RECENT_PROMPTS = 5;

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function textParts(content) {
  if (!Array.isArray(content)) return null;
  const texts = content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text);
  return texts.length ? texts.join('\n').trim() || null : null;
}

export function userText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.trim() || null;
  return textParts(content);
}

export function parseSessionLines(lines) {
  const info = {
    file: null, sessionId: null, cwd: null, gitBranch: '', firstAt: null, lastAt: null,
    aiTitle: null, lastPrompt: null, prUrls: [], userPromptCount: 0, recentPrompts: [], lastAssistantText: null,
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.sessionId && !info.sessionId) info.sessionId = entry.sessionId;
    if (entry.type === 'ai-title' && entry.aiTitle) info.aiTitle = entry.aiTitle;
    if (entry.type === 'last-prompt' && entry.lastPrompt) info.lastPrompt = entry.lastPrompt;
    if (entry.type === 'pr-link' && entry.prUrl && !info.prUrls.includes(entry.prUrl)) info.prUrls.push(entry.prUrl);
    if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isSidechain) continue;
    if (entry.cwd) info.cwd = entry.cwd;
    if (entry.gitBranch) info.gitBranch = entry.gitBranch;
    if (entry.timestamp) {
      info.firstAt ??= entry.timestamp;
      info.lastAt = entry.timestamp;
    }
    if (entry.type === 'user' && !entry.isMeta) {
      const text = userText(entry.message);
      if (!text) continue;
      info.userPromptCount++;
      info.recentPrompts.push(clip(text, PROMPT_LIMIT));
      if (info.recentPrompts.length > RECENT_PROMPTS) info.recentPrompts.shift();
    } else if (entry.type === 'assistant') {
      const text = textParts(entry.message?.content);
      if (text) info.lastAssistantText = clip(text, ASSISTANT_LIMIT);
    }
  }
  if (!info.sessionId || !info.cwd || !info.firstAt) return null;
  return info;
}

export function readSessionFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const info = parseSessionLines(text.split('\n'));
  if (info) info.file = file;
  return info;
}
