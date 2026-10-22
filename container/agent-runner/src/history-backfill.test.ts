import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './mailbox/sqlite/connection.js';
import { buildHistoryBackfill, renderHistory, selectHistory } from './history-backfill.js';

const row = (timestamp: string, content: object) => ({ timestamp, content: JSON.stringify(content) });

describe('selectHistory', () => {
  it('merges both directions chronologically and marks the agent as "you"', () => {
    const entries = selectHistory(
      [row('2026-10-21T10:00:00.000Z', { sender: 'Tia', text: 'deploy status?' })],
      [row('2026-10-21T10:00:05.000Z', { text: 'Green on staging.' })],
    );
    expect(entries.map((e) => [e.sender, e.text])).toEqual([
      ['Tia', 'deploy status?'],
      ['you', 'Green on staging.'],
    ]);
  });

  it('drops failure notices, system rows and empty text', () => {
    const entries = selectHistory(
      [
        row('2026-10-21T10:00:00.000Z', { sender: 'system', text: 'internal' }),
        row('2026-10-21T10:00:01.000Z', { sender: 'Tia', text: '' }),
      ],
      [row('2026-10-21T10:00:02.000Z', { text: 'oops', failureNotice: true })],
    );
    expect(entries).toEqual([]);
  });

  it('starts after the most recent /clear', () => {
    const entries = selectHistory(
      [
        row('2026-10-21T10:00:00.000Z', { sender: 'Tia', text: 'old topic' }),
        row('2026-10-21T10:01:00.000Z', { sender: 'Tia', text: '/clear' }),
        row('2026-10-21T10:02:00.000Z', { sender: 'Tia', text: 'new topic' }),
      ],
      [row('2026-10-21T10:01:01.000Z', { text: 'Session cleared.' })],
    );
    expect(entries.map((e) => e.text)).toEqual(['Session cleared.', 'new topic']);
  });

  it('keeps only the newest `limit` entries', () => {
    const inbound = Array.from({ length: 30 }, (_, i) =>
      row(`2026-10-21T10:${String(i).padStart(2, '0')}:00.000Z`, { sender: 'Tia', text: `m${i}` }),
    );
    const entries = selectHistory(inbound, [], 20);
    expect(entries).toHaveLength(20);
    expect(entries[0].text).toBe('m10');
    expect(entries[19].text).toBe('m29');
  });
});

describe('renderHistory', () => {
  it('returns null when empty', () => {
    expect(renderHistory([])).toBeNull();
  });

  it('frames the block as already-handled context, escapes and truncates', () => {
    const block = renderHistory([
      { timestamp: '2026-10-21T10:00:00.000Z', self: false, sender: 'Tia', text: '<b>' + 'x'.repeat(1000) },
    ])!;
    expect(block).toContain('<recent-history>');
    expect(block).toContain('Do not answer or redo anything in it');
    expect(block).toContain('&lt;b&gt;');
    expect(block).toContain('…');
    expect(block).not.toContain('x'.repeat(700));
  });
});

describe('buildHistoryBackfill (real session DBs)', () => {
  beforeEach(() => initTestSessionDb());
  afterEach(() => closeSessionDb());

  it('includes completed rows and excludes pending ones', () => {
    const insertIn = getInboundDb().prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, trigger, content) VALUES (?, 'chat', ?, ?, 1, ?)`,
    );
    insertIn.run(
      'done',
      '2026-10-21T10:00:00.000Z',
      'completed',
      JSON.stringify({ sender: 'Tia', text: 'handled one' }),
    );
    insertIn.run('todo', '2026-10-21T10:05:00.000Z', 'pending', JSON.stringify({ sender: 'Tia', text: 'brand new' }));
    getOutboundDb()
      .prepare(`INSERT INTO messages_out (id, kind, timestamp, content) VALUES ('o1', 'chat', ?, ?)`)
      .run('2026-10-21T10:00:03.000Z', JSON.stringify({ text: 'my reply' }));

    const block = buildHistoryBackfill()!;
    expect(block).toContain('handled one');
    expect(block).toContain('my reply');
    expect(block).not.toContain('brand new');
  });

  it('is null for a brand-new session', () => {
    expect(buildHistoryBackfill()).toBeNull();
  });
});
