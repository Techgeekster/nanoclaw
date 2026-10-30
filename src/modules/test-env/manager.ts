/**
 * Test-environment lifecycle: up → (reset)* → down, plus the TTL reaper.
 *
 * Every CLI call that touches Docker runs here, on the host, in the
 * background — `ncl` requests time out at 30s and a cold `supabase start`
 * takes minutes, so verbs return the row immediately and the agent polls
 * `ncl test-envs get`. One operation per env at a time: the row's transient
 * status (`starting` / `resetting` / `stopping`) is the lock.
 */
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { readEnvFile } from '../../env.js';
import { resolveGroupFolderPath } from '../../group-folder.js';
import { log } from '../../log.js';
import {
  defaultCliRunner,
  excludedServices,
  parseStatus,
  patchConfigToml,
  slotPorts,
  stackConfigPatch,
  syncSql,
  WITH_ALIASES,
  type CliRunner,
} from './supabase.js';
import { deleteTestEnv, getTestEnv, insertTestEnv, listTestEnvs, updateTestEnv, type TestEnvRow } from './store.js';

/** Where the agent group folder is mounted inside every agent container. */
export const CONTAINER_AGENT_DIR = '/workspace/agent';

const START_TIMEOUT_MS = 15 * 60_000;
const RESET_TIMEOUT_MS = 5 * 60_000;
const STOP_TIMEOUT_MS = 3 * 60_000;
/** A failed env keeps its row (and error) this long so the agent can read why. */
const FAILED_RETENTION_MS = 15 * 60_000;

const ENV_KEYS = [
  'NANOCLAW_TESTENV_MAX',
  'NANOCLAW_TESTENV_MAX_PER_GROUP',
  'NANOCLAW_TESTENV_PORT_BASE',
  'NANOCLAW_TESTENV_HOST_ALIAS',
];

export interface TestEnvSettings {
  maxStacks: number;
  maxPerGroup: number;
  portBase: number;
  hostAlias: string;
  defaultTtlMinutes: number;
  maxTtlMinutes: number;
}

export function readSettings(): TestEnvSettings {
  const file = readEnvFile(ENV_KEYS);
  const val = (k: string) => process.env[k] || file[k];
  const int = (k: string, d: number) => {
    const n = Number.parseInt(val(k) ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    maxStacks: int('NANOCLAW_TESTENV_MAX', 3),
    maxPerGroup: int('NANOCLAW_TESTENV_MAX_PER_GROUP', 3),
    portBase: int('NANOCLAW_TESTENV_PORT_BASE', 55200),
    hostAlias: val('NANOCLAW_TESTENV_HOST_ALIAS') || 'host.docker.internal',
    defaultTtlMinutes: 120,
    maxTtlMinutes: 480,
  };
}

let runner: CliRunner = defaultCliRunner;
let settingsFn: () => TestEnvSettings = readSettings;
let workRoot = path.join(DATA_DIR, 'test-envs');
/** Background operations in flight — awaited by tests and by shutdown. */
const inflight = new Set<Promise<void>>();

/** Test seam. */
export function _setTestEnvDeps(deps: {
  runner?: CliRunner;
  settings?: () => TestEnvSettings;
  workRoot?: string;
}): void {
  if (deps.runner) runner = deps.runner;
  if (deps.settings) settingsFn = deps.settings;
  if (deps.workRoot) workRoot = deps.workRoot;
}

export async function _drainTestEnvOps(): Promise<void> {
  while (inflight.size > 0) await Promise.all([...inflight]);
}

function background(id: string, what: string, fn: () => Promise<void>): void {
  const p = fn()
    .catch((err) => log.error('Test env background op crashed', { id, what, err }))
    .finally(() => inflight.delete(p));
  inflight.add(p);
}

function workdirFor(id: string): string {
  return path.join(workRoot, id);
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 4000);
}

/**
 * Resolve `--repo` to a host path inside the agent group's folder.
 * Agents pass a container path (`/workspace/agent/clones/x`) or one relative
 * to `/workspace/agent`; the result must stay inside the group folder after
 * symlinks resolve. Host callers may also pass an absolute host path.
 */
export async function resolveSourceRepo(repo: string, agentGroupId: string, caller: 'host' | 'agent'): Promise<string> {
  const group = await getAgentGroup(agentGroupId);
  if (!group) throw new Error(`agent group not found: ${agentGroupId}`);
  const groupDir = fs.realpathSync(resolveGroupFolderPath(group.folder));

  let candidate: string;
  if (repo === CONTAINER_AGENT_DIR || repo.startsWith(`${CONTAINER_AGENT_DIR}/`)) {
    candidate = path.join(groupDir, repo.slice(CONTAINER_AGENT_DIR.length));
  } else if (path.isAbsolute(repo)) {
    if (caller !== 'host') {
      throw new Error(`--repo must be under ${CONTAINER_AGENT_DIR} (your agent folder) or relative to it`);
    }
    candidate = repo;
  } else {
    candidate = path.join(groupDir, repo);
  }

  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch (err) {
    throw new Error(`--repo not found: ${repo}`, { cause: err });
  }
  const rel = path.relative(groupDir, real);
  if (caller === 'agent' && (rel.startsWith('..') || path.isAbsolute(rel))) {
    throw new Error(`--repo must stay inside ${CONTAINER_AGENT_DIR}`);
  }

  const migrations = path.join(real, 'supabase', 'migrations');
  if (!fs.statSync(migrations, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`no supabase/migrations directory in ${repo}`);
  }
  return real;
}

export interface UpInput {
  agentGroupId: string;
  sessionId: string | null;
  repo: string;
  caller: 'host' | 'agent';
  ttlMinutes?: number;
  with?: string[];
}

export async function upTestEnv(input: UpInput): Promise<TestEnvRow> {
  const settings = settingsFn();
  const withList = [...new Set(input.with ?? [])];
  for (const w of withList) {
    if (!WITH_ALIASES[w]) {
      throw new Error(`unknown --with "${w}" (choose from: ${Object.keys(WITH_ALIASES).join(', ')})`);
    }
  }
  const ttl = clampTtl(input.ttlMinutes ?? settings.defaultTtlMinutes, settings);
  const sourcePath = await resolveSourceRepo(input.repo, input.agentGroupId, input.caller);

  const existing = await listTestEnvs();
  if (existing.filter((e) => e.agent_group_id === input.agentGroupId).length >= settings.maxPerGroup) {
    throw new Error(
      `this agent group already has ${settings.maxPerGroup} test envs — tear one down first (ncl test-envs down <id>)`,
    );
  }
  if (existing.length >= settings.maxStacks) {
    throw new Error(`host limit reached: ${settings.maxStacks} test envs are running. Try again later.`);
  }

  const used = new Set(existing.map((e) => e.slot));
  const slot = [...Array(settings.maxStacks).keys()].find((s) => !used.has(s));
  if (slot === undefined) throw new Error('no free test-env slot');

  const id = `te-${randomBytes(4).toString('hex')}`;
  const now = new Date();
  const row: TestEnvRow = {
    id,
    agent_group_id: input.agentGroupId,
    session_id: input.sessionId,
    kind: 'supabase',
    status: 'starting',
    slot,
    project_id: `ncl-${id}`,
    source_path: sourcePath,
    services: JSON.stringify(withList),
    connection: null,
    error: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl * 60_000).toISOString(),
  };
  // The slot UNIQUE index rejects a concurrent claim of the same slot.
  await insertTestEnv(row);
  log.info('Test env starting', { id, agentGroupId: input.agentGroupId, slot, sourcePath });

  background(id, 'start', () => runStart(row, withList, settings));
  return row;
}

async function runStart(row: TestEnvRow, withList: string[], settings: TestEnvSettings): Promise<void> {
  const workdir = workdirFor(row.id);
  try {
    fs.rmSync(workdir, { recursive: true, force: true });
    fs.mkdirSync(workdir, { recursive: true });
    await runner(['init', '--yes'], workdir, 60_000);
    const configPath = path.join(workdir, 'supabase', 'config.toml');
    const ports = slotPorts(settings.portBase, row.slot);
    fs.writeFileSync(
      configPath,
      patchConfigToml(fs.readFileSync(configPath, 'utf8'), stackConfigPatch(row.project_id, ports)),
    );
    syncSql(row.source_path, workdir);

    const excluded = excludedServices(withList);
    await runner(['start', ...(excluded.length ? ['-x', excluded.join(',')] : [])], workdir, START_TIMEOUT_MS);
    const connection = await readConnection(workdir, settings);
    await updateTestEnv(row.id, { status: 'running', connection: JSON.stringify(connection), error: null });
    log.info('Test env running', { id: row.id });
    // eslint-disable-next-line no-catch-all/no-catch-all -- any start failure is recorded on the row for the agent
  } catch (err) {
    log.warn('Test env failed to start', { id: row.id, err });
    await updateTestEnv(row.id, {
      status: 'failed',
      error: errText(err),
      expires_at: new Date(Date.now() + FAILED_RETENTION_MS).toISOString(),
    });
    // Half-started containers must not linger holding ports.
    await runner(['stop', '--no-backup'], workdir, STOP_TIMEOUT_MS).catch(() => undefined);
  }
}

export interface TestEnvConnection {
  /** Env vars for code running inside an agent container. */
  env: Record<string, string>;
  /** The same endpoints as seen from the host. */
  host: { api_url: string; db_url: string };
}

async function readConnection(workdir: string, settings: TestEnvSettings): Promise<TestEnvConnection> {
  const status = parseStatus(await runner(['status', '-o', 'json'], workdir, 60_000));
  const toAgent = (url: string) => url.replace(/(?<=\/\/|@)(127\.0\.0\.1|localhost)(?=[:/])/, settings.hostAlias);
  const env: Record<string, string> = {
    SUPABASE_URL: toAgent(status.API_URL),
    SUPABASE_ANON_KEY: status.ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    SUPABASE_JWT_SECRET: status.JWT_SECRET,
    DATABASE_URL: toAgent(status.DB_URL),
    // The credential gateway is the container's HTTP(S) proxy; the stack is
    // on the host, so traffic to it must go direct.
    NO_PROXY: `${settings.hostAlias},localhost,127.0.0.1`,
  };
  if (status.PUBLISHABLE_KEY) env.SUPABASE_PUBLISHABLE_KEY = status.PUBLISHABLE_KEY;
  if (status.SECRET_KEY) env.SUPABASE_SECRET_KEY = status.SECRET_KEY;
  return { env, host: { api_url: status.API_URL, db_url: status.DB_URL } };
}

/** Load an env the caller may act on, or throw "not found" (no cross-group oracle). */
export async function getOwnedTestEnv(id: string, agentGroupId: string | null): Promise<TestEnvRow> {
  const row = await getTestEnv(id);
  if (!row || (agentGroupId !== null && row.agent_group_id !== agentGroupId)) {
    throw new Error(`test env not found: ${id}`);
  }
  return row;
}

function assertIdle(row: TestEnvRow, verb: string): void {
  if (row.status === 'starting' || row.status === 'resetting' || row.status === 'stopping') {
    throw new Error(`test env ${row.id} is ${row.status}; wait for it to finish before "${verb}"`);
  }
}

export async function resetTestEnv(row: TestEnvRow): Promise<TestEnvRow> {
  assertIdle(row, 'reset');
  if (row.status !== 'running') throw new Error(`test env ${row.id} is ${row.status}; only a running env can be reset`);
  await updateTestEnv(row.id, { status: 'resetting', error: null });
  background(row.id, 'reset', async () => {
    const workdir = workdirFor(row.id);
    try {
      const synced = syncSql(row.source_path, workdir);
      await runner(['db', 'reset'], workdir, RESET_TIMEOUT_MS);
      await updateTestEnv(row.id, { status: 'running' });
      log.info('Test env reset', { id: row.id, ...synced });
      // eslint-disable-next-line no-catch-all/no-catch-all -- any reset failure is recorded on the row for the agent
    } catch (err) {
      // The stack is still up; surface the migration error and stay usable.
      await updateTestEnv(row.id, { status: 'running', error: `reset failed: ${errText(err)}` });
    }
  });
  return (await getTestEnv(row.id))!;
}

export async function downTestEnv(row: TestEnvRow): Promise<TestEnvRow> {
  assertIdle(row, 'down');
  await updateTestEnv(row.id, { status: 'stopping' });
  background(row.id, 'stop', () => teardown(row.id));
  return (await getTestEnv(row.id))!;
}

async function teardown(id: string): Promise<void> {
  const workdir = workdirFor(id);
  try {
    if (fs.existsSync(path.join(workdir, 'supabase', 'config.toml'))) {
      await runner(['stop', '--no-backup'], workdir, STOP_TIMEOUT_MS);
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- any stop failure keeps the row for a reaper retry
  } catch (err) {
    // Keep the row (and its slot) so the reaper retries; a stack we failed
    // to stop still holds its ports.
    log.warn('Test env stop failed; will retry', { id, err });
    await updateTestEnv(id, {
      status: 'failed',
      error: `stop failed: ${errText(err)}`,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    return;
  }
  fs.rmSync(workdir, { recursive: true, force: true });
  await deleteTestEnv(id);
  log.info('Test env removed', { id });
}

export async function extendTestEnv(row: TestEnvRow, minutes: number): Promise<TestEnvRow> {
  if (row.status === 'failed' || row.status === 'stopping') {
    throw new Error(`test env ${row.id} is ${row.status}; nothing to extend`);
  }
  const ttl = clampTtl(minutes, settingsFn());
  await updateTestEnv(row.id, { expires_at: new Date(Date.now() + ttl * 60_000).toISOString() });
  return (await getTestEnv(row.id))!;
}

function clampTtl(minutes: number, settings: TestEnvSettings): number {
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('--ttl-minutes must be a positive number');
  return Math.min(Math.round(minutes), settings.maxTtlMinutes);
}

/** Tear down expired envs. Rows mid-operation are left to finish. */
export async function reapExpiredTestEnvs(now = new Date()): Promise<void> {
  for (const row of await listTestEnvs()) {
    if (row.expires_at > now.toISOString()) continue;
    if (row.status === 'starting' || row.status === 'resetting' || row.status === 'stopping') continue;
    log.info('Test env expired; tearing down', { id: row.id, status: row.status });
    await updateTestEnv(row.id, { status: 'stopping' });
    background(row.id, 'reap', () => teardown(row.id));
  }
}

/**
 * Host start: an op that was in flight when the previous host died never
 * finished. Tear those stacks down rather than guess at their state.
 */
export async function reconcileTestEnvsOnStart(): Promise<void> {
  for (const row of await listTestEnvs()) {
    if (row.status === 'starting' || row.status === 'resetting' || row.status === 'stopping') {
      log.warn('Test env interrupted by host restart; tearing down', { id: row.id, status: row.status });
      await updateTestEnv(row.id, { status: 'stopping' });
      background(row.id, 'reconcile', () => teardown(row.id));
    }
  }
}
