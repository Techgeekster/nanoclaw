/**
 * Thread for a scheduled-task session's channel post.
 *
 * A task session is bound to no chat and has no inbound traffic from the
 * channel, so its `send_message` carries no thread and the post lands in the
 * channel root — outside the thread whose request created the task. The task's
 * own row records the session that created it (`originSessionId`). When that
 * chain of creators (a task may be created by another task) ends in a chat
 * thread, every channel post from the task is delivered into that thread —
 * whatever destination the agent named. Enforced here, not in the agent's
 * instructions.
 */
import { getMessagingGroup } from './db/messaging-groups.js';
import { getSession, isTaskThread, TASKS_SYSTEM_THREAD_ID } from './db/sessions.js';
import { parseTaskContent } from './modules/scheduling/task-content.js';
import { withExistingMailboxSession } from './session-manager.js';
import type { Session } from './types.js';

/** Task-created-by-task hops followed before giving up (guards against cycles). */
const MAX_ORIGIN_HOPS = 10;

export interface TaskOrigin {
  channelType: string;
  platformId: string;
  threadId: string;
}

type SessionRef = Pick<Session, 'id' | 'agent_group_id' | 'messaging_group_id' | 'thread_id'>;

export async function resolveTaskOrigin(session: SessionRef): Promise<TaskOrigin | null> {
  let current: SessionRef = session;
  for (let hop = 0; hop < MAX_ORIGIN_HOPS; hop++) {
    if (current.messaging_group_id !== null || !current.thread_id || !isTaskThread(current.thread_id)) return null;
    const series = current.thread_id.slice(`${TASKS_SYSTEM_THREAD_ID}:`.length);
    if (!series) return null;

    const task = current;
    const row = await withExistingMailboxSession(task.agent_group_id, task.id, (mb) => mb.getTask(series));
    if (!row) return null;
    const originId = parseTaskContent(row.content).originSessionId;
    if (!originId) return null;

    const origin = await getSession(originId);
    if (!origin || !origin.thread_id) return null;
    if (isTaskThread(origin.thread_id)) {
      current = origin;
      continue;
    }
    if (!origin.messaging_group_id) return null;
    const mg = await getMessagingGroup(origin.messaging_group_id);
    if (!mg) return null;
    return { channelType: mg.channel_type, platformId: mg.platform_id, threadId: origin.thread_id };
  }
  return null;
}
