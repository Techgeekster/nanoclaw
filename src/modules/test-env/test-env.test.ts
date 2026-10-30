/**
 * Test envs: config generation, repo-path confinement, group scoping, and the
 * up → running → reset → down lifecycle against a fake Supabase CLI.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'test-env-'));
const groupsRoot = path.join(tmpRoot, 'groups');

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../../group-folder.js', () => ({
  resolveGroupFolderPath: (folder: string) => path.join(groupsRoot, folder),
}));

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import type { CallerContext } from '../../cli/frame.js';
import { dispatch } from '../../cli/dispatch.js';
import { _drainTestEnvOps, _setTestEnvDeps, reapExpiredTestEnvs, type TestEnvSettings } from './manager.js';
import { getTestEnv, listTestEnvs, updateTestEnv } from './store.js';
import { excludedServices, parseStatus, patchConfigToml, slotPorts } from './supabase.js';
import './index.js';

const A = 'ag-a';
const B = 'ag-b';
const agentA: CallerContext = { caller: 'agent', agentGroupId: A, sessionId: 'sess-a', messagingGroupId: 'mg-a' };
const agentB: CallerContext = { caller: 'agent', agentGroupId: B, sessionId: 'sess-b', messagingGroupId: 'mg-b' };

const TEMPLATE = [
  'project_id = "x"',
  '[api]',
  'port = 54321',
  '[db]',
  'port = 54322',
  'shadow_port = 54320',
  '[db.pooler]',
  'port = 54329',
  '[studio]',
  'port = 54323',
  '[analytics]',
  'port = 54327',
].join('\n');

const STATUS = JSON.stringify({
  API_URL: 'http://127.0.0.1:55200',
  DB_URL: 'postgresql://postgres:postgres@127.0.0.1:55201/postgres',
  ANON_KEY: 'anon',
  SERVICE_ROLE_KEY: 'service',
  JWT_SECRET: 'jwt',
  PUBLISHABLE_KEY: 'pub',
});

let calls: { args: string[]; cwd: string }[];
let failOn: string | null;

const settings = (): TestEnvSettings => ({
  maxStacks: 3,
  maxPerGroup: 2,
  portBase: 55200,
  hostAlias: 'host.docker.internal',
  defaultTtlMinutes: 120,
  maxTtlMinutes: 480,
});

function makeRepo(group: string, rel: string): string {
  const dir = path.join(groupsRoot, group, rel, 'supabase', 'migrations');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '001_init.sql'), 'create table t (id int);');
  return path.join(groupsRoot, group, rel);
}

async function run(command: string, args: Record<string, unknown>, ctx: CallerContext) {
  return dispatch({ id: 'r1', command, args }, ctx);
}

beforeEach(async () => {
  fs.rmSync(groupsRoot, { recursive: true, force: true });
  calls = [];
  failOn = null;
  _setTestEnvDeps({
    settings,
    workRoot: path.join(tmpRoot, 'work'),
    runner: async (args, cwd) => {
      calls.push({ args, cwd });
      if (failOn && args[0] === failOn) throw new Error(`boom: ${failOn}`);
      if (args[0] === 'init') {
        fs.mkdirSync(path.join(cwd, 'supabase'), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'supabase', 'config.toml'), TEMPLATE);
      }
      return args[0] === 'status' ? `notice\n${STATUS}\nnotice` : '';
    },
  });
  await runMigrations(await initTestDb());
  const now = new Date().toISOString();
  await createAgentGroup({ id: A, name: 'a', folder: 'a', agent_provider: null, created_at: now });
  await createAgentGroup({ id: B, name: 'b', folder: 'b', agent_provider: null, created_at: now });
});

afterEach(async () => {
  await _drainTestEnvOps();
  await closeDb();
});

describe('supabase helpers', () => {
  it('patches keys per section without touching same-named keys elsewhere', () => {
    const out = patchConfigToml(TEMPLATE, { '': { project_id: 'p' }, db: { port: 1 }, api: { port: 2 } });
    expect(out).toContain('project_id = "p"');
    expect(out).toMatch(/\[api\]\nport = 2/);
    expect(out).toMatch(/\[db\]\nport = 1\nshadow_port = 54320/);
    expect(out).toMatch(/\[db\.pooler\]\nport = 54329/);
  });

  it('gives each slot a disjoint port block', () => {
    expect(slotPorts(55200, 0).api).toBe(55200);
    expect(slotPorts(55200, 1).api).toBe(55210);
    expect(Math.max(...Object.values(slotPorts(55200, 0)))).toBeLessThan(55210);
  });

  it('excludes every optional service unless --with enables it', () => {
    expect(excludedServices([])).toContain('storage-api');
    expect(excludedServices(['storage'])).not.toContain('storage-api');
    expect(excludedServices(['storage'])).not.toContain('imgproxy');
  });

  it('parses status JSON wrapped in CLI notices', () => {
    expect(parseStatus(`update available\n${STATUS}\n`).ANON_KEY).toBe('anon');
    expect(() => parseStatus('{}')).toThrow(/API_URL/);
  });
});

describe('ncl test-envs', () => {
  it('brings a stack up from the agent folder and exposes container-reachable env', async () => {
    makeRepo('a', 'clones/app');
    const up = await run('test-envs-up', { repo: '/workspace/agent/clones/app' }, agentA);
    expect(up.ok).toBe(true);
    const id = (up as { data: { id: string; status: string } }).data.id;
    expect((up as { data: { status: string } }).data.status).toBe('starting');

    await _drainTestEnvOps();
    const row = (await getTestEnv(id))!;
    expect(row.status).toBe('running');

    const start = calls.find((c) => c.args[0] === 'start')!;
    expect(start.args).toEqual(['start', '-x', expect.stringContaining('storage-api')]);
    const config = fs.readFileSync(path.join(start.cwd, 'supabase', 'config.toml'), 'utf8');
    expect(config).toContain(`project_id = "ncl-${id}"`);
    expect(config).toMatch(/\[api\]\nport = 55200/);
    expect(fs.existsSync(path.join(start.cwd, 'supabase', 'migrations', '001_init.sql'))).toBe(true);

    const env = await run(`test-envs-env-${id}`, {}, agentA);
    expect(env.ok).toBe(true);
    const human = (env as { human?: string }).human!;
    expect(human).toContain("export SUPABASE_URL='http://host.docker.internal:55200'");
    expect(human).toContain("export DATABASE_URL='postgresql://postgres:postgres@host.docker.internal:55201/postgres'");
    expect(human).toContain('NO_PROXY=');
  });

  it('confines --repo to the agent folder', async () => {
    makeRepo('b', 'secret');
    fs.mkdirSync(path.join(groupsRoot, 'a'), { recursive: true });
    fs.symlinkSync(path.join(groupsRoot, 'b', 'secret'), path.join(groupsRoot, 'a', 'link'));

    for (const repo of ['../b/secret', 'link', path.join(groupsRoot, 'b', 'secret')]) {
      const res = await run('test-envs-up', { repo }, agentA);
      expect(res.ok, repo).toBe(false);
    }
    expect(await listTestEnvs()).toHaveLength(0);
  });

  it('skips symlinked migration files so a host file cannot be pulled in', async () => {
    const repo = makeRepo('a', 'app');
    fs.writeFileSync(path.join(tmpRoot, 'host-secret.sql'), 'secret');
    fs.symlinkSync(path.join(tmpRoot, 'host-secret.sql'), path.join(repo, 'supabase', 'migrations', '002_x.sql'));
    await run('test-envs-up', { repo: 'app' }, agentA);
    await _drainTestEnvOps();
    const cwd = calls.find((c) => c.args[0] === 'start')!.cwd;
    expect(fs.readdirSync(path.join(cwd, 'supabase', 'migrations'))).toEqual(['001_init.sql']);
  });

  it("hides another group's envs", async () => {
    makeRepo('a', 'app');
    const up = await run('test-envs-up', { repo: 'app' }, agentA);
    const id = (up as { data: { id: string } }).data.id;
    await _drainTestEnvOps();

    expect((await run(`test-envs-get-${id}`, {}, agentB)).ok).toBe(false);
    expect((await run(`test-envs-down-${id}`, {}, agentB)).ok).toBe(false);
    const list = await run('test-envs-list', {}, agentB);
    expect((list as { data: unknown[] }).data).toHaveLength(0);
    expect((await getTestEnv(id))!.status).toBe('running');
  });

  it('enforces the per-group limit', async () => {
    makeRepo('a', 'app');
    expect((await run('test-envs-up', { repo: 'app' }, agentA)).ok).toBe(true);
    expect((await run('test-envs-up', { repo: 'app' }, agentA)).ok).toBe(true);
    const third = await run('test-envs-up', { repo: 'app' }, agentA);
    expect(third.ok).toBe(false);
    const slots = (await listTestEnvs()).map((r) => r.slot).sort();
    expect(slots).toEqual([0, 1]);
  });

  it('records a failed start and stops the half-started stack', async () => {
    makeRepo('a', 'app');
    failOn = 'start';
    const up = await run('test-envs-up', { repo: 'app' }, agentA);
    const id = (up as { data: { id: string } }).data.id;
    await _drainTestEnvOps();
    const row = (await getTestEnv(id))!;
    expect(row.status).toBe('failed');
    expect(row.error).toContain('boom: start');
    expect(calls.map((c) => c.args[0])).toContain('stop');
  });

  it('resets migrations and tears down on down', async () => {
    const repo = makeRepo('a', 'app');
    const up = await run('test-envs-up', { repo: 'app' }, agentA);
    const id = (up as { data: { id: string } }).data.id;
    await _drainTestEnvOps();

    fs.writeFileSync(path.join(repo, 'supabase', 'migrations', '002_more.sql'), 'select 1;');
    expect((await run(`test-envs-reset-${id}`, {}, agentA)).ok).toBe(true);
    await _drainTestEnvOps();
    const cwd = calls.find((c) => c.args[0] === 'start')!.cwd;
    expect(fs.readdirSync(path.join(cwd, 'supabase', 'migrations')).sort()).toEqual(['001_init.sql', '002_more.sql']);
    expect(calls.some((c) => c.args.join(' ') === 'db reset')).toBe(true);

    expect((await run(`test-envs-down-${id}`, {}, agentA)).ok).toBe(true);
    await _drainTestEnvOps();
    expect(await getTestEnv(id)).toBeUndefined();
    expect(fs.existsSync(cwd)).toBe(false);
  });

  it('reaps expired envs', async () => {
    makeRepo('a', 'app');
    const up = await run('test-envs-up', { repo: 'app' }, agentA);
    const id = (up as { data: { id: string } }).data.id;
    await _drainTestEnvOps();
    await updateTestEnv(id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    await reapExpiredTestEnvs();
    await _drainTestEnvOps();
    expect(await getTestEnv(id)).toBeUndefined();
  });

  it('requires --group from the host', async () => {
    makeRepo('a', 'app');
    expect((await run('test-envs-up', { repo: 'app' }, { caller: 'host' })).ok).toBe(false);
    expect((await run('test-envs-up', { repo: 'app', group: A }, { caller: 'host' })).ok).toBe(true);
  });
});
