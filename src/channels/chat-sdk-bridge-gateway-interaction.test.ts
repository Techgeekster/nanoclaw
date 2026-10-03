/**
 * Gateway-forwarded button clicks in the Chat SDK bridge (Discord path).
 *
 * When the Discord Gateway listener runs in webhook-forwarding mode, button
 * clicks arrive as `GATEWAY_INTERACTION_CREATE` events that `handleForwardedEvent`
 * handles directly (the adapter's own webhook path is bypassed). The Discord
 * adapter encodes the component `custom_id` as `${button.id}\n${button.value}`
 * (see `encodeDiscordCustomId` in `@chat-adapter/discord`). The bridge must
 * strip that `\n`-delimited value suffix before parsing the `ncq:` button id,
 * otherwise the option index never resolves and downstream sees a garbage
 * value like `"0\n0"` — which is exactly what broke channel registration.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Adapter } from 'chat';

import type { ChannelSetup } from './adapter.js';
import { handleForwardedEvent } from './chat-sdk-bridge.js';
import { registerQuestionRenderResolver } from './question-render-registry.js';

const QUESTION_ID = 'mg-1788212581235-qxm56c';
const CONNECT_VALUE = 'connect:ag-1788211813242-nmfcqh';

registerQuestionRenderResolver((id) =>
  id === QUESTION_ID
    ? {
        title: '📣 Bot mentioned in new channel',
        question: 'How would you like to handle this channel?',
        options: [
          { label: 'Connect to Home Assistant Manager', value: CONNECT_VALUE, selectedLabel: '✅ Connected' },
          { label: 'Connect new agent', value: 'new_agent', selectedLabel: '🆕' },
          { label: 'Reject', value: 'reject', selectedLabel: '🙅' },
        ],
      }
    : undefined,
);

const stubAdapter = { name: 'discord', initialize: async () => {} } as unknown as Adapter;

function interactionBody(customId: string): string {
  return JSON.stringify({
    type: 'GATEWAY_INTERACTION_CREATE',
    data: {
      id: 'interaction-1',
      token: 'tok-1',
      type: 3,
      data: { custom_id: customId },
      user: { id: '667781444113924146', username: 'tia' },
      message: { embeds: [{ title: 't', description: 'd' }] },
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleForwardedEvent — gateway button clicks', () => {
  it('resolves the option index when custom_id carries the adapter \\n-delimited value suffix', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const onAction = vi.fn();
    const setup = { onAction } as unknown as ChannelSetup;

    // The Discord adapter produces `${button.id}\n${button.value}` — here
    // button.id = `ncq:<questionId>:0`, button.value = "0".
    await handleForwardedEvent(interactionBody(`ncq:${QUESTION_ID}:0\n0`), stubAdapter, setup);

    expect(onAction).toHaveBeenCalledWith(QUESTION_ID, CONNECT_VALUE, '667781444113924146', {
      messageId: undefined,
      platformId: undefined,
    });
  });

  it('still resolves a plain custom_id with no value suffix', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
    const onAction = vi.fn();
    const setup = { onAction } as unknown as ChannelSetup;

    await handleForwardedEvent(interactionBody(`ncq:${QUESTION_ID}:2`), stubAdapter, setup);

    expect(onAction).toHaveBeenCalledWith(QUESTION_ID, 'reject', '667781444113924146', {
      messageId: undefined,
      platformId: undefined,
    });
  });
});
