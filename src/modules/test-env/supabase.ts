/**
 * Supabase CLI wrapper for test environments.
 *
 * The host — never the agent — drives `supabase start/stop/db reset`, so no
 * container ever holds the Docker socket. The workdir is host-owned
 * (`data/test-envs/<id>/`): `config.toml` is generated here from the CLI's own
 * `supabase init` template and only migration/seed SQL is copied in from the
 * agent's checkout, so an agent can't steer the CLI (bind mounts, seed globs,
 * ports) through a config file it controls.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Every optional service the CLI can start. The lean default excludes all of them. */
export const OPTIONAL_SERVICES = [
  'realtime',
  'storage-api',
  'imgproxy',
  'studio',
  'postgres-meta',
  'mailpit',
  'logflare',
  'vector',
  'supavisor',
  'edge-runtime',
] as const;

/** Friendly `--with` names → the CLI service names they enable. */
export const WITH_ALIASES: Record<string, readonly string[]> = {
  storage: ['storage-api', 'imgproxy'],
  realtime: ['realtime'],
  studio: ['studio', 'postgres-meta'],
  mail: ['mailpit'],
  functions: ['edge-runtime'],
};

/** Ports reserved per slot; offsets inside the block. */
export const PORTS_PER_SLOT = 10;
const PORT_OFFSETS = {
  api: 0,
  db: 1,
  shadow: 2,
  pooler: 3,
  studio: 4,
  smtp: 5,
  analytics: 6,
  inspector: 7,
} as const;

export type SlotPorts = Record<keyof typeof PORT_OFFSETS, number>;

export function slotPorts(base: number, slot: number): SlotPorts {
  const start = base + slot * PORTS_PER_SLOT;
  return Object.fromEntries(Object.entries(PORT_OFFSETS).map(([k, off]) => [k, start + off])) as SlotPorts;
}

/** Excluded services for `supabase start -x`, given the `--with` list. */
export function excludedServices(withList: readonly string[]): string[] {
  const enabled = new Set(withList.flatMap((w) => WITH_ALIASES[w] ?? []));
  return OPTIONAL_SERVICES.filter((s) => !enabled.has(s));
}

/**
 * Section-aware patch of the CLI's `config.toml` template: `[section] key = …`
 * lines named in `patch` get their value replaced. Keys the template doesn't
 * carry are left alone (the template is version-specific); unknown sections
 * are never invented.
 */
export function patchConfigToml(toml: string, patch: Record<string, Record<string, string | number>>): string {
  let section = '';
  return toml
    .split('\n')
    .map((line) => {
      const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
      if (header) {
        section = header[1].trim();
        return line;
      }
      const kv = line.match(/^(\s*)([A-Za-z0-9_]+)(\s*=\s*)(.*)$/);
      if (!kv) return line;
      const value = patch[section]?.[kv[2]];
      if (value === undefined) return line;
      return `${kv[1]}${kv[2]}${kv[3]}${typeof value === 'number' ? value : JSON.stringify(value)}`;
    })
    .join('\n');
}

export function stackConfigPatch(projectId: string, ports: SlotPorts): Record<string, Record<string, string | number>> {
  return {
    '': { project_id: projectId },
    api: { port: ports.api },
    db: { port: ports.db, shadow_port: ports.shadow },
    'db.pooler': { port: ports.pooler },
    studio: { port: ports.studio },
    local_smtp: { port: ports.smtp },
    inbucket: { port: ports.smtp },
    analytics: { port: ports.analytics },
    edge_runtime: { inspector_port: ports.inspector },
  };
}

/**
 * Copy `<source>/supabase/migrations/*.sql` (+ `supabase/seed.sql`) into the
 * workdir, replacing what was there. Regular files only — a symlink in the
 * agent's checkout is skipped, so it can't pull in a host file.
 */
export function syncSql(sourceRepo: string, workdir: string): { migrations: number; seed: boolean } {
  const srcMigrations = path.join(sourceRepo, 'supabase', 'migrations');
  const dstMigrations = path.join(workdir, 'supabase', 'migrations');
  fs.rmSync(dstMigrations, { recursive: true, force: true });
  fs.mkdirSync(dstMigrations, { recursive: true });

  let migrations = 0;
  for (const entry of fs.readdirSync(srcMigrations, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.sql')) continue;
    fs.copyFileSync(path.join(srcMigrations, entry.name), path.join(dstMigrations, entry.name));
    migrations++;
  }

  const srcSeed = path.join(sourceRepo, 'supabase', 'seed.sql');
  const dstSeed = path.join(workdir, 'supabase', 'seed.sql');
  fs.rmSync(dstSeed, { force: true });
  const seedStat = fs.lstatSync(srcSeed, { throwIfNoEntry: false });
  const seed = !!seedStat?.isFile();
  if (seed) fs.copyFileSync(srcSeed, dstSeed);

  return { migrations, seed };
}

export type CliRunner = (args: string[], cwd: string, timeoutMs: number) => Promise<string>;

export function resolveSupabaseBin(): string {
  const override = process.env.NANOCLAW_SUPABASE_BIN;
  if (override) return override;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'supabase');
    if (dir && fs.existsSync(candidate)) return candidate;
  }
  // The systemd/launchd unit's PATH often omits ~/.local/bin.
  const local = path.join(os.homedir(), '.local', 'bin', 'supabase');
  if (fs.existsSync(local)) return local;
  throw new Error('Supabase CLI not found. Install it on the host or set NANOCLAW_SUPABASE_BIN.');
}

export const defaultCliRunner: CliRunner = (args, cwd, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      resolveSupabaseBin(),
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '1' },
      },
      (err, stdout, stderr) => {
        if (err) {
          const tail = `${stderr}\n${stdout}`.trim().split('\n').slice(-15).join('\n');
          reject(new Error(`supabase ${args[0]} failed: ${tail || err.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });

/** Connection details from `supabase status -o json`. */
export interface StackStatus {
  API_URL: string;
  DB_URL: string;
  ANON_KEY: string;
  SERVICE_ROLE_KEY: string;
  JWT_SECRET: string;
  PUBLISHABLE_KEY?: string;
  SECRET_KEY?: string;
}

export function parseStatus(stdout: string): StackStatus {
  // The CLI can print update notices around the JSON — take the object.
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('supabase status returned no JSON');
  const parsed = JSON.parse(stdout.slice(start, end + 1)) as Partial<StackStatus>;
  for (const key of ['API_URL', 'DB_URL', 'ANON_KEY', 'SERVICE_ROLE_KEY', 'JWT_SECRET'] as const) {
    if (!parsed[key]) throw new Error(`supabase status is missing ${key}`);
  }
  return parsed as StackStatus;
}
