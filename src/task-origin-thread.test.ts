import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-task-origin-thread',
    GROUPS_DIR: '/tmp/nanoclaw-test-task-origin-thread/groups',
    TIMEZONE: 'UTC',
  };
});

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const TEST_DIR = '/tmp/nanoclaw-test-task-origin-thread';
const CHANNEL = 'discord';
const PLATFORM = 'discord:g1:c1';
const THREAD = 'discord:g1:c1:t1';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from './db/index.js';
import { createMessagingGroup } from './db/messaging-groups.js';
import { createSession, getSessionsByAgentGroup } from './db/sessions.js';
import { dispatch } from './cli/dispatch.js';
import type { CallerContext } from './cli/frame.js';
import { initSessionFolder } from './session-manager.js';
import { resolveTaskOriginThread } from './task-origin-thread.js';
import './cli/resources/tasks.js';

const now = () => new Date().toISOString();

async function chatSession(id: string, mg: string | null, thread: string | null): Promise<void> {
  await createSession({
    id,
    agent_group_id: 'ag-1',
    messaging_group_id: mg,
    thread_id: thread,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  });
  initSessionFolder('ag-1', id);
}

const ctx = (sessionId: string): CallerContext => ({
  caller: 'agent',
  agentGroupId: 'ag-1',
  sessionId,
  messagingGroupId: 'mg-1',
});

async function taskSessionFor(originSession: string) {
  const resp = await dispatch(
    { id: 'r', command: 'tasks-create', args: { prompt: 'ping', process_after: '2999-01-01T00:00:00Z' } },
    ctx(originSession),
  );
  if (!resp.ok) throw new Error('tasks-create failed');
  const { session_id } = resp.data as { session_id: string };
  return (await getSessionsByAgentGroup('ag-1')).find((s) => s.id === session_id)!;
}

describe('resolveTaskOriginThread', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await runMigrations(await initTestDb());
    await createAgentGroup({ id: 'ag-1', name: 'ag-1', folder: 'ag-1', agent_provider: null, created_at: now() });
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: CHANNEL,
      platform_id: PLATFORM,
      name: null,
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('returns the thread of the session that created the task', async () => {
    await chatSession('origin', 'mg-1', THREAD);
    const task = await taskSessionFor('origin');
    expect(await resolveTaskOriginThread(task, CHANNEL, PLATFORM)).toBe(THREAD);
  });

  it('returns null when the post targets a different chat than the origin session', async () => {
    await chatSession('origin', 'mg-1', THREAD);
    const task = await taskSessionFor('origin');
    expect(await resolveTaskOriginThread(task, CHANNEL, 'discord:g1:other')).toBeNull();
  });

  it('returns null when the origin session has no thread', async () => {
    await chatSession('origin', 'mg-1', null);
    const task = await taskSessionFor('origin');
    expect(await resolveTaskOriginThread(task, CHANNEL, PLATFORM)).toBeNull();
  });

  it('returns null for a non-task session', async () => {
    await chatSession('origin', 'mg-1', THREAD);
    const [origin] = (await getSessionsByAgentGroup('ag-1')).filter((s) => s.id === 'origin');
    expect(await resolveTaskOriginThread(origin, CHANNEL, PLATFORM)).toBeNull();
  });
});
