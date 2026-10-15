/**
 * Inbound acknowledgment — react 👀 to a message the moment it wakes an agent.
 *
 * The host does this, not the agent: a model deep in a long or failing turn
 * never answers, and the sender can't tell "working" from "dead". The reaction
 * lands before the container even spawns, so every engaged message is visibly
 * seen. Fire-and-forget and never throws; a platform that can't react just
 * logs at debug.
 */
import { getDeliveryAdapter } from './delivery.js';
import { log } from './log.js';

export const ACK_EMOJI = 'eyes';

export function ackInboundMessage(args: {
  kind: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  instance?: string;
  content: string;
}): void {
  void (async () => {
    try {
      if (args.kind !== 'chat' && args.kind !== 'chat-sdk') return;
      const adapter = getDeliveryAdapter();
      if (!adapter) return;
      const parsed = JSON.parse(args.content) as { id?: unknown };
      if (typeof parsed.id !== 'string' || !parsed.id) return;
      await adapter.deliver(
        args.channelType,
        args.platformId,
        args.threadId,
        'chat',
        JSON.stringify({ operation: 'reaction', messageId: parsed.id, emoji: ACK_EMOJI }),
        undefined,
        args.instance,
      );
    } catch (err) {
      log.debug('Inbound ack reaction failed', { err: String(err) });
    }
  })();
}
