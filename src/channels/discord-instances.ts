/**
 * Additional Discord bot identities — a local companion to the registry-owned
 * `discord.ts` (installed by the `add-discord` skill).
 *
 * Deliberately NOT part of that skill: `add-discord`'s `nc:copy
 * from-branch:channels` directive overwrites `discord.ts` byte-for-byte from
 * the `channels` branch on every `update-nanoclaw` run, with no local-override
 * hook. Anything hand-added to that file is silently reverted on the next
 * update. This module lives outside the skill's file list and is wired in
 * from `src/index.ts` (not `src/channels/index.ts` — that barrel is scanned
 * by `detectInstalledSkills` in scripts/update-skills.ts, which would treat a
 * bare `import './discord-instances.js'` there as an uninstalled
 * `add-discord-instances` skill and fail every future skill refresh). It
 * duplicates the small amount of Discord-specific plumbing (defaults, reply
 * extraction, forward unwrapping) rather than importing it from `discord.ts`,
 * so it has zero dependency on that file's shape and survives regardless of
 * what a future skill refresh does to it.
 *
 * Set DISCORD_INSTANCES=<name>[,<name>…] plus a per-instance credential set
 * (DISCORD_BOT_TOKEN_<NAME> / DISCORD_APPLICATION_ID_<NAME> /
 * DISCORD_PUBLIC_KEY_<NAME>; name uppercased, dashes → underscores). Each
 * name registers under the `discord-<name>` instance key. channelType stays
 * 'discord', so user ids, formatting, and container config are shared with
 * the default Discord app — instance is a host-side routing key only.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../env.js';
import type { ChannelAdapter, ChannelDefaults } from './adapter.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

/** Same declaration as the default app's — instances share wiring-default behavior. */
const DISCORD_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

/** Same forward-snapshot unwrap as the default app — see discord.ts for the rationale. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrapForwardedSnapshot(data: Record<string, any>): void {
  if (data.message_reference?.type !== 1) return;
  const snaps = (data.message_snapshots ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((s: any) => s?.message)
    .filter(Boolean);
  if (snaps.length === 0) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const text = snaps
    .map((m: any) => m.content)
    .filter(Boolean)
    .join('\n');
  const label = '[Forwarded message]';
  data.content = text ? `${label}\n${text}` : data.content || label;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fwdAttachments = snaps.flatMap((m: any) => m.attachments ?? []);
  if (fwdAttachments.length > 0) {
    data.attachments = [...(data.attachments ?? []), ...fwdAttachments];
  }
}

function unwrapForwards(adapter: ReturnType<typeof createDiscordAdapter>): void {
  const a = adapter as unknown as {
    handleForwardedMessage: (data: Record<string, unknown>, options?: unknown) => Promise<void>;
  };
  const orig = a.handleForwardedMessage.bind(adapter);
  a.handleForwardedMessage = async (data, options) => {
    unwrapForwardedSnapshot(data);
    return orig(data, options);
  };
}

/** Env-key suffix for a named instance: uppercased, dashes → underscores. */
export function instanceEnvKeySuffix(name: string): string {
  return name.toUpperCase().replace(/-/g, '_');
}

/**
 * Build one named instance's bridge from its per-instance credential set.
 * Returns null when the bot token is missing so the registry surfaces its
 * normal "credentials missing, skipping" warning. Exported so a test can
 * drive the real factory against a credential set.
 */
export function discordInstanceBridgeFactory(name: string): ChannelAdapter | null {
  const suffix = `_${instanceEnvKeySuffix(name)}`;
  const keys = {
    botToken: `DISCORD_BOT_TOKEN${suffix}`,
    publicKey: `DISCORD_PUBLIC_KEY${suffix}`,
    applicationId: `DISCORD_APPLICATION_ID${suffix}`,
  };
  const env = readEnvFile([keys.botToken, keys.publicKey, keys.applicationId]);
  const botToken = env[keys.botToken];
  if (!botToken) return null;
  const discordAdapter = createDiscordAdapter({
    botToken,
    publicKey: env[keys.publicKey],
    applicationId: env[keys.applicationId],
  });
  unwrapForwards(discordAdapter);
  return createChatSdkBridge({
    adapter: discordAdapter,
    instance: `discord-${name}`,
    concurrency: 'concurrent',
    botToken,
    extractReplyContext,
    supportsThreads: true,
    defaults: DISCORD_DEFAULTS,
    // Discord rejects messages over 2000 chars; without this the bridge
    // would let long agent replies fail instead of splitting them.
    maxTextLength: 2000,
  });
}

// Registration is unconditional for every listed name so a missing
// credential set surfaces as the registry's "credentials missing, skipping"
// warning at boot rather than a silently absent bot.
for (const raw of (readEnvFile(['DISCORD_INSTANCES']).DISCORD_INSTANCES ?? '').split(',')) {
  const name = raw.trim();
  if (!name) continue;
  registerChannelAdapter(`discord-${name}`, {
    factory: () => discordInstanceBridgeFactory(name),
    defaults: DISCORD_DEFAULTS,
  });
}
