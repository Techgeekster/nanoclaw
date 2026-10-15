/**
 * Thread for a scheduled-task session's channel post.
 *
 * A task session is bound to no chat and has no inbound traffic from the
 * channel, so its `send_message` carries no thread and the post lands in the
 * channel root — outside the thread whose request created the task. The task's
 * own row records the session that created it (`originSessionId`); when a task
 * post targets that session's chat with no thread, deliver it into that
 * session's thread instead. Enforced here, not in the agent's instructions.
 */
import { getMessagingGroup } from './db/messaging-groups.js';
import { getSession, isTaskThread, TASKS_SYSTEM_THREAD_ID } from './db/sessions.js';
import { parseTaskContent } from './modules/scheduling/task-content.js';
import { withExistingMailboxSession } from './session-manager.js';
import type { Session } from './types.js';

export async function resolveTaskOriginThread(
  session: Pick<Session, 'id' | 'agent_group_id' | 'messaging_group_id' | 'thread_id'>,
  channelType: string,
  platformId: string,
): Promise<string | null> {
  if (session.messaging_group_id !== null || !session.thread_id || !isTaskThread(session.thread_id)) return null;
  const series = session.thread_id.slice(`${TASKS_SYSTEM_THREAD_ID}:`.length);
  if (!series) return null;

  const row = await withExistingMailboxSession(session.agent_group_id, session.id, (mb) => mb.getTask(series));
  if (!row) return null;
  const originId = parseTaskContent(row.content).originSessionId;
  if (!originId) return null;

  const origin = await getSession(originId);
  if (!origin || !origin.messaging_group_id || !origin.thread_id || isTaskThread(origin.thread_id)) return null;
  const mg = await getMessagingGroup(origin.messaging_group_id);
  if (!mg || mg.channel_type !== channelType || mg.platform_id !== platformId) return null;
  return origin.thread_id;
}
