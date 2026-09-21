/**
 * A brand-new Discord thread carries the vendor adapter's hardcoded default
 * name with no in-context signal telling the agent it's new — see the
 * session-created hook registered at the bottom of chat-sdk-bridge.ts.
 * This exercises that hook through the REAL routeInbound path (adapter
 * registry + seeded wiring), the same harness style as
 * router-session-created.test.ts, rather than calling it directly.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from '../db/index.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channel-registry.js';
import { routeInbound } from '../router.js';
import { inboundDbPath } from '../mailbox/sqlite/paths.js';
import type { ChannelAdapter, ChannelDefaults } from './adapter.js';

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-thread-name-reminder' };
});

const TEST_DIR = '/tmp/nanoclaw-test-thread-name-reminder';

function now(): string {
  return new Date().toISOString();
}

const channelDefaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

function makeAdapter(channelType: string): ChannelAdapter {
  return {
    name: channelType,
    channelType,
    supportsThreads: true,
    defaults: channelDefaults,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
  };
}

async function activate(channelType: string): Promise<void> {
  registerChannelAdapter(channelType, { factory: () => makeAdapter(channelType), defaults: channelDefaults });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
}

async function seedWiring(channelType: string): Promise<void> {
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: channelType,
    platform_id: `${channelType}:g1:c1`,
    instance: channelType,
    name: 'Test Channel',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'mention-sticky',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    threads: 1,
    created_at: now(),
  });
}

async function inbound(channelType: string, platformId: string, threadId: string | null, text: string): Promise<void> {
  await routeInbound({
    channelType,
    platformId,
    threadId,
    message: {
      id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: 'chat-sdk',
      content: JSON.stringify({ sender: 'Alex', senderId: 'U1', text }),
      timestamp: now(),
      isMention: true,
      isGroup: true,
    },
  });
  // The hook is fire-and-forget — flush the microtask queue before asserting.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function readMessagesIn(sessionId: string): Array<{ id: string; content: string }> {
  const db = new Database(inboundDbPath('ag-1', sessionId), { readonly: true });
  try {
    return db.prepare('SELECT id, content FROM messages_in ORDER BY seq').all() as Array<{
      id: string;
      content: string;
    }>;
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  // Side-effect import: registers the hook under test.
  await import('./chat-sdk-bridge.js');
});

afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('Discord thread-name reminder (session-created hook)', () => {
  it('writes a rename_thread reminder into a newly created Discord thread session', async () => {
    await activate('discord');
    await seedWiring('discord');

    await inbound('discord', 'discord:g1:c1', 'discord:g1:c1:t1', 'hey <@bot> help with this');

    const rows = readMessagesIn(
      // The session id is generated at creation time — look it up via the
      // agent group's only session folder rather than guessing the id.
      fs.readdirSync(`${TEST_DIR}/v2-sessions/ag-1`)[0],
    );

    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0].content).text).toBe('hey <@bot> help with this');
    const reminder = JSON.parse(rows[1].content);
    expect(reminder.text).toMatch(/rename_thread/);
    expect(reminder.sender).toBe('system');
  });

  it('does not fire for a non-Discord channel', async () => {
    await activate('slack');
    await seedWiring('slack');

    await inbound('slack', 'slack:g1:c1', 'slack:g1:c1:t1', 'hey <@bot> help with this');

    const sessionId = fs.readdirSync(`${TEST_DIR}/v2-sessions/ag-1`)[0];
    const rows = readMessagesIn(sessionId);
    expect(rows).toHaveLength(1);
  });

  it('does not fire without a thread id (e.g. a DM)', async () => {
    await activate('discord');
    await seedWiring('discord');

    await inbound('discord', 'discord:g1:c1', null, 'hey <@bot> help with this');

    const sessionId = fs.readdirSync(`${TEST_DIR}/v2-sessions/ag-1`)[0];
    const rows = readMessagesIn(sessionId);
    expect(rows).toHaveLength(1);
  });
});
