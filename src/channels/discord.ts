/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Additional bot identities: set DISCORD_INSTANCES=<name>[,<name>…] plus a
 * per-instance credential set (DISCORD_BOT_TOKEN_<NAME> /
 * DISCORD_APPLICATION_ID_<NAME> / DISCORD_PUBLIC_KEY_<NAME>; name uppercased,
 * dashes → underscores). Each name registers under the `discord-<name>`
 * instance key through the same createDiscordBridge factory as the default
 * app — no mirrored construction. channelType stays 'discord' either way, so
 * user ids, formatting, container config, and the wiring-defaults declaration
 * are shared across instances.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../env.js';
import type { ChannelAdapter, ChannelDefaults } from './adapter.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

/**
 * Dedicated bot app on a threaded platform. group threads:true matches the
 * declared supportsThreads (the skill-installed install-style knob) so
 * mention-sticky engagement stays bounded per-thread. dm.threads:false —
 * DM replies land top-level, one session per DM.
 */
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

/**
 * Discord message forwards carry their content in `message_snapshots`, not
 * `content` (`message_reference.type === 1` means FORWARD; 0 is a normal
 * reply). The adapter only reads `content`/`attachments`, so without this the
 * agent sees an empty message. Unwrap the snapshot back into the payload so
 * text, attachment download, and formatting all ride the existing path.
 * Note: snapshots contain no author, so the original sender is unavailable.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrapForwardedSnapshot(data: Record<string, any>): void {
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

/** Construction knobs for one Discord bot identity. */
export interface DiscordBridgeOptions {
  /**
   * Uppercased/underscored instance suffix appended to each credential env
   * key after an underscore — 'HA' reads DISCORD_BOT_TOKEN_HA /
   * DISCORD_APPLICATION_ID_HA / DISCORD_PUBLIC_KEY_HA. Omit (or pass '') for
   * the default app's unsuffixed keys.
   */
  envKeySuffix?: string;
  /**
   * Registry/bridge instance key (e.g. 'discord-ha'). Omit for the default
   * instance, keyed by channelType. channelType stays 'discord' either way —
   * instance is a host-side routing key only, so user ids, formatting,
   * container config, and the wiring-defaults declaration are shared with the
   * default Discord app.
   */
  instanceKey?: string;
}

/**
 * Build one Discord bot identity's bridge from its credential set. The
 * default app is the zero-suffix call (used by the registration below); named
 * instances pass a suffix + instance key and get the exact same construction.
 * Returns null when the bot token is missing so the registry surfaces its
 * normal "credentials missing, skipping" warning.
 */
export function createDiscordBridge(options: DiscordBridgeOptions = {}): ChannelAdapter | null {
  const suffix = options.envKeySuffix ? `_${options.envKeySuffix}` : '';
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
    instance: options.instanceKey, // undefined ⇒ default instance (keyed by channelType)
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

/** Env-key suffix for a named instance: uppercased, dashes → underscores. */
export function instanceEnvKeySuffix(name: string): string {
  return name.toUpperCase().replace(/-/g, '_');
}

/**
 * Build one named instance's bridge from its per-instance credential set,
 * through the shared factory. Returns null when the bot token is missing so
 * the registry surfaces its "credentials missing, skipping" warning.
 * Exported so a test can drive the real factory against a credential set.
 */
export function discordInstanceBridgeFactory(name: string): ChannelAdapter | null {
  return createDiscordBridge({
    envKeySuffix: instanceEnvKeySuffix(name),
    instanceKey: `discord-${name}`,
  });
}

registerChannelAdapter('discord', {
  factory: () => createDiscordBridge(),
  defaults: DISCORD_DEFAULTS,
});

// Named instances — registration is unconditional for every listed name so a
// missing credential set surfaces as the registry's "credentials missing,
// skipping" warning at boot rather than a silently absent bot. Every
// registration carries the same DISCORD_DEFAULTS declaration as the default
// app, so offline creation paths (setup, ncl) resolve declared wiring defaults
// for named instances too.
for (const raw of (readEnvFile(['DISCORD_INSTANCES']).DISCORD_INSTANCES ?? '').split(',')) {
  const name = raw.trim();
  if (!name) continue;
  registerChannelAdapter(`discord-${name}`, {
    factory: () => discordInstanceBridgeFactory(name),
    defaults: DISCORD_DEFAULTS,
  });
}
