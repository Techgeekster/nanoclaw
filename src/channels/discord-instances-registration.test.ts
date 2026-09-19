/**
 * Guard for the native DISCORD_INSTANCES registrations (discord.ts).
 *
 * Integration points under guard:
 *  1. The barrel reach-in — `import './discord.js';` in src/channels/index.ts.
 *     Importing the real barrel must run discord.ts's top-level
 *     DISCORD_INSTANCES loop; if the import line is deleted, or the barrel
 *     fails to evaluate (e.g. @chat-adapter/discord uninstalled), the
 *     instance keys are absent and this goes red.
 *  2. The shared declaration — every `discord-<name>` registration must carry
 *     the same DISCORD_DEFAULTS declaration as the default Discord app
 *     (declared defaults, not the core fallback). hasDeclaredChannelDefaults()
 *     distinguishes a declared entry from fallbackChannelDefaults().
 *  3. The shared factory — the per-name factory delegates to
 *     createDiscordBridge, whose credential path is driven for real here:
 *     with no DISCORD_BOT_TOKEN_<NAME> in .env the factory returns null (the
 *     registry's "credentials missing, skipping" path).
 *
 * DISCORD_INSTANCES is read from `.env` at module import (readEnvFile reads
 * process.cwd()/.env, never process.env), so the test chdirs into a temp dir
 * carrying a crafted .env BEFORE dynamically importing the barrel. Vitest's
 * per-file process isolation keeps the chdir and the module cache local to
 * this file.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { getChannelDefaults, getRegisteredChannelNames, hasDeclaredChannelDefaults } from './channel-registry.js';

const originalCwd = process.cwd();

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'discord-instances-'));
  writeFileSync(join(dir, '.env'), 'DISCORD_INSTANCES=ha,gh-bot\n');
  process.chdir(dir);
  await import('./index.js'); // the real barrel — triggers every channel's self-registration
});

afterAll(() => {
  process.chdir(originalCwd);
});

describe('discord multi-instance registration', () => {
  it('registers a discord-<name> adapter per DISCORD_INSTANCES entry via the channel barrel', () => {
    const names = getRegisteredChannelNames();
    expect(names).toContain('discord-ha');
    expect(names).toContain('discord-gh-bot');
    // The default app's registration is untouched.
    expect(names).toContain('discord');
  });

  it("every instance registration declares the default app's DISCORD_DEFAULTS (not the core fallback)", () => {
    for (const key of ['discord-ha', 'discord-gh-bot']) {
      expect(hasDeclaredChannelDefaults(key)).toBe(true);
      expect(getChannelDefaults(key)).toEqual(getChannelDefaults('discord'));
      const defaults = getChannelDefaults(key);
      expect(defaults.group.engageMode).toBe('mention-sticky');
      expect(defaults.dm).toMatchObject({ engageMode: 'pattern', engagePattern: '.', threads: false });
      expect(defaults.mentions).toBe('platform');
    }
  });
});

describe('instance factory (via the shared createDiscordBridge)', () => {
  it('returns null when the instance credential set is absent — the registry "credentials missing" path', async () => {
    const { discordInstanceBridgeFactory } = await import('./discord.js');
    expect(discordInstanceBridgeFactory('ha')).toBeNull();
  });

  it('maps an instance name to its env-key suffix (uppercased, dashes → underscores)', async () => {
    const { instanceEnvKeySuffix } = await import('./discord.js');
    expect(instanceEnvKeySuffix('gh-bot')).toBe('GH_BOT');
    expect(instanceEnvKeySuffix('dana')).toBe('DANA');
  });
});
