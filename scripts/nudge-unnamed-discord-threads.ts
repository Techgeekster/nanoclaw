/**
 * One-off maintenance: find Discord threads still carrying the vendor
 * @chat-adapter/discord package's default "Thread <timestamp>" name (see
 * its createDiscordThread — hardcoded, no override hook at creation time)
 * and nudge each owning agent, via a normal inbound message into its
 * existing session, to review the conversation and call the rename_thread
 * MCP tool. Only covers threads with an active NanoClaw session — a thread
 * with no session was never actually engaged and has nothing to nudge.
 *
 * Requires the service to be running: the nudge is delivered as an inbound
 * message through the CLI channel's admin transport (`data/cli.sock`),
 * the same mechanism scripts/init-first-agent.ts uses for its welcome
 * hand-off, so the session-DB write happens inside the running host
 * process — the sole writer for those files.
 *
 * Usage:
 *   pnpm exec tsx scripts/nudge-unnamed-discord-threads.ts [--dry-run]
 */
import net from 'node:net';
import path from 'node:path';

import { CENTRAL_DB_PATH, DATA_DIR } from '../src/config.js';
import { closeDb, initDb } from '../src/db/connection.js';
import { readEnvFile } from '../src/env.js';

const dryRun = process.argv.includes('--dry-run');

interface Candidate {
  threadId: string; // full encoded id: discord:<guildId>:<channelId>:<discordThreadId>
  guildId: string;
  channelId: string;
  discordThreadId: string;
  instance: string;
  agentGroupId: string;
  agentGroupName: string;
}

/** Mirrors src/channels/discord-instances.ts — must match how bot tokens are keyed. */
function envKeySuffixForInstance(instance: string): string {
  if (instance === 'discord') return '';
  const name = instance.replace(/^discord-/, '');
  return `_${name.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * The nudge must be sent as a sender the access gate already recognizes, or
 * every single one trips `unknown_sender_policy: request_approval` and pages
 * an admin for a made-up identity that will never be approved into anything
 * real (canAccessAgentGroup's first check is `getUser(userId)` — a sender
 * absent from the `users` table fails closed regardless of role). A global
 * owner passes canAccessAgentGroup for every agent group unconditionally, so
 * sending as the owner is both correct (an operator asked for this
 * maintenance) and side-effect-free (no new membership or approval rows).
 */
async function findGlobalOwnerId(db: Awaited<ReturnType<typeof initDb>>): Promise<string> {
  const rows = await db.all<{ user_id: string }>(
    `select user_id from user_roles where role = 'owner' and (agent_group_id is null or agent_group_id = '')`,
  );
  if (rows.length === 0) throw new Error('No global owner found in user_roles — cannot send an already-trusted nudge.');
  return rows[0].user_id;
}

async function findCandidates(): Promise<{ candidates: Candidate[]; ownerId: string }> {
  const db = await initDb(CENTRAL_DB_PATH, { role: 'tool' });
  try {
    const ownerId = await findGlobalOwnerId(db);
    const rows = await db.all<{ thread_id: string; instance: string; agent_group_id: string; name: string }>(
      `select s.thread_id, mg.instance, s.agent_group_id, ag.name
       from sessions s
       join messaging_groups mg on mg.id = s.messaging_group_id
       join agent_groups ag on ag.id = s.agent_group_id
       where mg.channel_type = 'discord' and s.thread_id like 'discord:%:%:%'`,
    );
    const seen = new Set<string>();
    const candidates: Candidate[] = [];
    for (const row of rows) {
      if (seen.has(row.thread_id)) continue;
      seen.add(row.thread_id);
      const parts = row.thread_id.split(':');
      if (parts.length !== 4 || parts[0] !== 'discord') continue;
      const [, guildId, channelId, discordThreadId] = parts;
      candidates.push({
        threadId: row.thread_id,
        guildId,
        channelId,
        discordThreadId,
        instance: row.instance,
        agentGroupId: row.agent_group_id,
        agentGroupName: row.name,
      });
    }
    return { candidates, ownerId };
  } finally {
    await closeDb();
  }
}

/** The vendor default is `Thread ${new Date().toLocaleString()}` — locale-dependent, so
 *  check shape (starts with "Thread ", rest parses as a date) rather than an exact format. */
function looksLikeDefaultName(name: string): boolean {
  return name.startsWith('Thread ') && !isNaN(Date.parse(name.slice('Thread '.length)));
}

async function fetchThreadName(botToken: string, discordThreadId: string): Promise<string | null> {
  const res = await fetch(`https://discord.com/api/v10/channels/${discordThreadId}`, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  if (!res.ok) {
    console.warn(`  ! could not fetch channel ${discordThreadId}: ${res.status} ${await res.text()}`);
    return null;
  }
  const body = (await res.json()) as { name?: string };
  return body.name ?? null;
}

async function nudgeSession(candidate: Candidate, ownerId: string): Promise<void> {
  const sockPath = path.join(DATA_DIR, 'cli.sock');
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(sockPath);
    let settled = false;
    const settle = (err: Error | null) => {
      if (settled) return;
      settled = true;
      try {
        socket.end();
      } catch {
        /* noop */
      }
      if (err) reject(err);
      else resolve();
    };
    socket.once('error', (err) =>
      settle(new Error(`CLI socket at ${sockPath} not reachable: ${err.message}. Is the NanoClaw service running?`)),
    );
    socket.once('connect', () => {
      const payload =
        JSON.stringify({
          text:
            'System instruction: this thread still has Discord’s default auto-generated name ' +
            '("Thread <timestamp>"). Review the conversation above and call rename_thread with a ' +
            'short, specific name for it.',
          // Sent as the global owner (see findGlobalOwnerId) — a made-up
          // sender identity fails canAccessAgentGroup's very first check
          // (getUser) and pages an admin for approval that can never
          // meaningfully resolve.
          senderId: ownerId,
          sender: 'Tia (automated maintenance)',
          to: {
            channelType: 'discord',
            platformId: `discord:${candidate.guildId}:${candidate.channelId}`,
            threadId: candidate.threadId,
            instance: candidate.instance,
          },
        }) + '\n';
      socket.write(payload, (err) => {
        if (err) {
          settle(err);
          return;
        }
        setTimeout(() => settle(null), 50);
      });
    });
  });
}

async function main(): Promise<void> {
  const { candidates, ownerId } = await findCandidates();
  console.log(`Found ${candidates.length} Discord thread(s) with an active session.`);

  let renamed = 0;
  for (const candidate of candidates) {
    const suffix = envKeySuffixForInstance(candidate.instance);
    const tokenKey = `DISCORD_BOT_TOKEN${suffix}`;
    const botToken = readEnvFile([tokenKey])[tokenKey];
    if (!botToken) {
      console.warn(`  ! no ${tokenKey} in .env — skipping ${candidate.threadId}`);
      continue;
    }

    const name = await fetchThreadName(botToken, candidate.discordThreadId);
    if (name === null) continue;
    if (!looksLikeDefaultName(name)) continue;

    console.log(`  - "${name}" (${candidate.agentGroupName}, ${candidate.instance}) → nudging for rename`);
    if (!dryRun) {
      await nudgeSession(candidate, ownerId);
    }
    renamed++;
  }

  console.log(
    dryRun
      ? `\nDry run: would nudge ${renamed} thread(s). Re-run without --dry-run to send.`
      : `\nNudged ${renamed} thread(s).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
