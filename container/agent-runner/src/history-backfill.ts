/**
 * Fresh-start history backfill.
 *
 * A session normally resumes the provider's saved transcript. When that is gone
 * (rotated for size/age, found stale, or the provider keeps no transcript), the
 * agent wakes with no memory of a conversation the user is still having. The
 * session's own inbound/outbound DBs still hold it, so the first prompt of a
 * fresh start carries the last few exchanges as read-only context.
 *
 * Never used after /clear: that is the user asking for a blank slate, so history
 * at or before the most recent /clear is dropped.
 */
import { getAgentMailbox } from './mailbox/index.js';
import { FAILURE_NOTICE_FIELD } from './formatter.js';
import { TIMEZONE, formatLocalTime } from './timezone.js';

/** Messages carried over, counting both directions. */
export const HISTORY_BACKFILL_LIMIT = 20;
/** Per-message text cap; longer messages are head-truncated with an ellipsis. */
export const HISTORY_TEXT_MAX_CHARS = 600;

export interface HistoryEntry {
  timestamp: string;
  /** True when the agent wrote it. */
  self: boolean;
  sender: string;
  text: string;
}

interface RawRow {
  timestamp: string;
  content: string;
}

function parse(raw: string): { text: string; sender: string | null; skip: boolean } {
  try {
    const c = JSON.parse(raw) as Record<string, unknown>;
    const author = c.author as { fullName?: string; userName?: string } | undefined;
    return {
      text: typeof c.text === 'string' ? c.text.trim() : '',
      sender: typeof c.sender === 'string' ? c.sender : (author?.fullName ?? author?.userName ?? null),
      skip: c[FAILURE_NOTICE_FIELD] === true || c.sender === 'system' || c.senderId === 'system',
    };
  } catch {
    return { text: '', sender: null, skip: true };
  }
}

/** Pure: merge both directions chronologically, drop noise, and cut at the last /clear. */
export function selectHistory(inbound: RawRow[], outbound: RawRow[], limit = HISTORY_BACKFILL_LIMIT): HistoryEntry[] {
  const merged: HistoryEntry[] = [];
  for (const row of inbound) {
    const p = parse(row.content);
    if (p.skip || !p.text) continue;
    merged.push({ timestamp: row.timestamp, self: false, sender: p.sender ?? 'user', text: p.text });
  }
  for (const row of outbound) {
    const p = parse(row.content);
    if (p.skip || !p.text) continue;
    merged.push({ timestamp: row.timestamp, self: true, sender: 'you', text: p.text });
  }
  merged.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  let lastClear = -1;
  merged.forEach((entry, i) => {
    if (!entry.self && entry.text.toLowerCase().startsWith('/clear')) lastClear = i;
  });
  return merged.slice(lastClear + 1).slice(-limit);
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Pure: render entries as a context-only block, or null when there is nothing to show. */
export function renderHistory(entries: HistoryEntry[]): string | null {
  if (entries.length === 0) return null;
  const lines = entries.map((e) => {
    const text = e.text.length > HISTORY_TEXT_MAX_CHARS ? `${e.text.slice(0, HISTORY_TEXT_MAX_CHARS)}…` : e.text;
    const time = formatLocalTime(e.timestamp, TIMEZONE);
    return `<history-message sender="${escapeXml(e.sender)}" time="${escapeXml(time)}">${escapeXml(text)}</history-message>`;
  });
  return [
    '<recent-history>',
    'Your saved session was not restored, so this is the tail of the conversation from before (oldest first; "you" is you).',
    'It is context only: every message in it was already handled. Do not answer or redo anything in it.',
    ...lines,
    '</recent-history>',
  ].join('\n');
}

/** The block to prepend to a fresh session's first prompt; null when there is no history. Never throws. */
export function buildHistoryBackfill(limit = HISTORY_BACKFILL_LIMIT): string | null {
  try {
    const { inbound, outbound } = getAgentMailbox().operations.getRecentHistory(limit);
    return renderHistory(selectHistory(inbound, outbound, limit));
  } catch {
    return null;
  }
}
