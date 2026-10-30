/**
 * `ncl test-envs` — disposable local Supabase stacks for agents.
 *
 * The host runs the stack; the agent only gets connection details. All verbs
 * are self-scoped: an agent caller only ever sees and acts on its own agent
 * group's envs, whatever its cli_scope.
 */
import { registerResource } from '../../cli/crud.js';
import type { CallerContext } from '../../cli/frame.js';
import {
  downTestEnv,
  extendTestEnv,
  getOwnedTestEnv,
  resetTestEnv,
  upTestEnv,
  type TestEnvConnection,
} from './manager.js';
import { WITH_ALIASES } from './supabase.js';
import { listTestEnvs, type TestEnvRow } from './store.js';

function ownerOf(ctx: CallerContext): string | null {
  return ctx.caller === 'agent' ? ctx.agentGroupId : null;
}

function connectionOf(row: TestEnvRow): TestEnvConnection | null {
  return row.connection ? (JSON.parse(row.connection) as TestEnvConnection) : null;
}

/** Agent-facing view: parsed connection, no host filesystem paths. */
function view(row: TestEnvRow) {
  return {
    id: row.id,
    agent_group_id: row.agent_group_id,
    status: row.status,
    services: JSON.parse(row.services) as string[],
    expires_at: row.expires_at,
    error: row.error,
    connection: connectionOf(row),
  };
}

type View = ReturnType<typeof view>;

function formatView(data: unknown): string {
  const v = data as View;
  const lines = [`${v.id}  ${v.status}  expires ${v.expires_at}`];
  if (v.status === 'starting') lines.push('Starting in the background (first run pulls images: ~3 min, later ~30s).');
  if (v.status === 'starting' || v.status === 'resetting') lines.push(`Poll: ncl test-envs get ${v.id}`);
  if (v.error) lines.push(`error: ${v.error}`);
  if (v.connection) lines.push(`Load env: eval "$(ncl test-envs env ${v.id})"`);
  return lines.join('\n');
}

const idArg = { name: 'id', type: 'string' as const, description: 'Test env id (te-…).', required: true };

registerResource({
  name: 'test-env',
  plural: 'test-envs',
  table: 'test_envs',
  description:
    'Test env — a disposable local Supabase stack (Postgres + auth + REST) the host runs for an agent, ' +
    "loaded with a repo's supabase/migrations. No Docker access needed inside the container.",
  idColumn: 'id',
  scopeField: 'agent_group_id',
  columns: [
    { name: 'id', type: 'string', description: 'te-<hex>.', generated: true },
    { name: 'agent_group_id', type: 'string', description: 'Owning agent group.' },
    { name: 'session_id', type: 'string', description: 'Session that started it (null for host callers).' },
    { name: 'kind', type: 'string', description: 'Stack kind.', enum: ['supabase'] },
    {
      name: 'status',
      type: 'string',
      description: 'Lifecycle state.',
      enum: ['starting', 'running', 'resetting', 'stopping', 'failed'],
    },
    { name: 'slot', type: 'number', description: 'Port block index.' },
    { name: 'project_id', type: 'string', description: 'Supabase project id (Docker name suffix).' },
    { name: 'source_path', type: 'string', description: 'Host path migrations are copied from.' },
    { name: 'services', type: 'json', description: 'Optional services enabled via --with.' },
    { name: 'connection', type: 'json', description: 'Connection details once running.' },
    { name: 'error', type: 'string', description: 'Last failure, if any.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
    { name: 'updated_at', type: 'string', description: 'Auto-set.', generated: true },
    { name: 'expires_at', type: 'string', description: 'Torn down automatically after this.' },
  ],
  // list is custom (not generic) so rows go through view() like every other verb.
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description: "List test envs (an agent sees only its own group's).",
      args: [],
      handler: async (_args, ctx) => {
        const owner = ownerOf(ctx);
        return (await listTestEnvs()).filter((r) => owner === null || r.agent_group_id === owner).map(view);
      },
      formatHuman: (data) => {
        const rows = data as View[];
        return rows.length
          ? rows.map((v) => `${v.id}  ${v.status}  expires ${v.expires_at}`).join('\n')
          : 'No test envs.';
      },
    },
    up: {
      access: 'open',
      description:
        "Start a local Supabase stack loaded with a repo's supabase/migrations (+ seed.sql).\n\n" +
        'Returns immediately with status "starting"; poll `ncl test-envs get <id>` until "running" ' +
        '(first run pulls images, ~3 min; later ~30s). Then `eval "$(ncl test-envs env <id>)"` to ' +
        'export SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL, NO_PROXY. ' +
        'Each env is isolated (own DB, own ports) and torn down at expires_at. Default services: ' +
        `Postgres, auth, REST. --with adds: ${Object.keys(WITH_ALIASES).join(', ')}.`,
      examples: [
        'ncl test-envs up --repo /workspace/agent/clones/pawsavvy-240',
        'ncl test-envs up --repo clones/pawsavvy-240 --ttl-minutes 240 --with storage,realtime',
      ],
      args: [
        {
          name: 'repo',
          type: 'string',
          description: 'Checkout containing supabase/migrations — under /workspace/agent, or relative to it.',
          required: true,
        },
        { name: 'ttl_minutes', type: 'number', description: 'Lifetime in minutes (default 120, max 480).' },
        { name: 'with', type: 'string', description: 'Comma-separated optional services.' },
      ],
      handler: async (args, ctx) => {
        const agentGroupId = ctx.caller === 'agent' ? ctx.agentGroupId : (args.group as string | undefined);
        if (!agentGroupId) throw new Error('--group <agent-group-id> is required from the host');
        const row = await upTestEnv({
          agentGroupId,
          sessionId: ctx.caller === 'agent' ? ctx.sessionId : null,
          repo: args.repo as string,
          caller: ctx.caller,
          ttlMinutes: args.ttl_minutes as number | undefined,
          with: typeof args.with === 'string' && args.with ? args.with.split(',').map((s) => s.trim()) : [],
        });
        return view(row);
      },
      formatHuman: formatView,
    },
    get: {
      access: 'open',
      description: 'Show a test env: status, expiry, last error, connection details once running.',
      args: [idArg],
      handler: async (args, ctx) => view(await getOwnedTestEnv(args.id as string, ownerOf(ctx))),
      formatHuman: formatView,
    },
    env: {
      access: 'open',
      description:
        'Print `export KEY=value` lines for a running test env — `eval "$(ncl test-envs env <id>)"`.\n\n' +
        'URLs use host.docker.internal (reachable from your container). NO_PROXY is included so ' +
        'HTTP clients bypass the credential proxy for the stack.',
      args: [idArg],
      handler: async (args, ctx) => {
        const row = await getOwnedTestEnv(args.id as string, ownerOf(ctx));
        const conn = connectionOf(row);
        if (row.status !== 'running' || !conn) throw new Error(`test env ${row.id} is ${row.status}, not running`);
        return conn.env;
      },
      formatHuman: (data) =>
        Object.entries(data as Record<string, string>)
          .map(([k, v]) => `export ${k}='${v.replace(/'/g, `'\\''`)}'`)
          .join('\n'),
    },
    reset: {
      access: 'open',
      description:
        'Re-copy supabase/migrations + seed.sql from the repo and rebuild the database (`supabase db reset`).\n\n' +
        'Use after changing migrations. Runs in the background (~10–60s); poll `ncl test-envs get <id>`. ' +
        'A migration error shows in `error` and the env stays running.',
      args: [idArg],
      handler: async (args, ctx) => view(await resetTestEnv(await getOwnedTestEnv(args.id as string, ownerOf(ctx)))),
      formatHuman: formatView,
    },
    extend: {
      access: 'open',
      description: "Push a test env's expiry out to now + --ttl-minutes (max 480).",
      args: [idArg, { name: 'ttl_minutes', type: 'number', description: 'New lifetime from now.', required: true }],
      handler: async (args, ctx) =>
        view(await extendTestEnv(await getOwnedTestEnv(args.id as string, ownerOf(ctx)), args.ttl_minutes as number)),
      formatHuman: formatView,
    },
    down: {
      access: 'open',
      description: 'Tear a test env down now (containers and data are deleted). Do this when you are done.',
      args: [idArg],
      handler: async (args, ctx) => view(await downTestEnv(await getOwnedTestEnv(args.id as string, ownerOf(ctx)))),
      formatHuman: (data) => `${(data as View).id} stopping — containers and data will be removed.`,
    },
  },
});
