import { beforeEach, describe, expect, it, vi } from 'vitest';

const deliver = vi.fn().mockResolvedValue(undefined);
vi.mock('./delivery.js', () => ({ getDeliveryAdapter: () => ({ deliver }) }));

import { ackInboundMessage } from './inbound-ack.js';

const base = { channelType: 'discord', platformId: 'discord:g:c', threadId: 'discord:g:c:t', instance: 'discord' };
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => deliver.mockClear());

describe('ackInboundMessage', () => {
  it('reacts 👀 to the inbound platform message in its thread', async () => {
    ackInboundMessage({ ...base, kind: 'chat-sdk', content: JSON.stringify({ id: '123', text: 'hi' }) });
    await flush();
    expect(deliver).toHaveBeenCalledWith(
      'discord',
      'discord:g:c',
      'discord:g:c:t',
      'chat',
      JSON.stringify({ operation: 'reaction', messageId: '123', emoji: 'eyes' }),
      undefined,
      'discord',
    );
  });

  it('skips non-chat kinds and content without an id, and never throws', async () => {
    ackInboundMessage({ ...base, kind: 'system', content: JSON.stringify({ id: '1' }) });
    ackInboundMessage({ ...base, kind: 'chat', content: JSON.stringify({ text: 'no id' }) });
    ackInboundMessage({ ...base, kind: 'chat', content: 'not json' });
    await flush();
    expect(deliver).not.toHaveBeenCalled();
  });
});
