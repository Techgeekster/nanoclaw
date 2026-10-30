/**
 * `test_envs` — one row per live (or failed, not yet reaped) test stack.
 *
 * Rows are deleted once their stack is torn down, so the slot UNIQUE index is
 * the port-allocation lock: two concurrent `up`s can't both claim a slot.
 */
import { getDb } from '../../db/connection.js';
import type { ModuleMigration } from '../../db/migrations/index.js';

export type TestEnvStatus = 'starting' | 'running' | 'resetting' | 'stopping' | 'failed';

export interface TestEnvRow {
  id: string;
  agent_group_id: string;
  session_id: string | null;
  kind: string;
  status: TestEnvStatus;
  slot: number;
  project_id: string;
  source_path: string;
  services: string;
  connection: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export const testEnvsMigration: ModuleMigration = {
  version: 1,
  name: 'module:test-env:test-envs',
  async up(db) {
    await db.exec(`
      CREATE TABLE test_envs (
        id TEXT PRIMARY KEY,
        agent_group_id TEXT NOT NULL,
        session_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        slot INTEGER NOT NULL,
        project_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        services TEXT NOT NULL DEFAULT '[]',
        connection TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_test_envs_slot ON test_envs(slot);
      CREATE INDEX idx_test_envs_group ON test_envs(agent_group_id);
    `);
  },
};

export async function getTestEnv(id: string): Promise<TestEnvRow | undefined> {
  return getDb().get<TestEnvRow>('SELECT * FROM test_envs WHERE id = ?', id);
}

export async function listTestEnvs(): Promise<TestEnvRow[]> {
  return getDb().all<TestEnvRow>('SELECT * FROM test_envs ORDER BY created_at');
}

export async function insertTestEnv(row: TestEnvRow): Promise<void> {
  const cols = Object.keys(row);
  await getDb().run(
    `INSERT INTO test_envs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ...cols.map((c) => row[c as keyof TestEnvRow]),
  );
}

export async function updateTestEnv(id: string, fields: Partial<Omit<TestEnvRow, 'id' | 'updated_at'>>): Promise<void> {
  const entries = Object.entries(fields);
  await getDb().run(
    `UPDATE test_envs SET ${entries.map(([k]) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    ...entries.map(([, v]) => v),
    new Date().toISOString(),
    id,
  );
}

export async function deleteTestEnv(id: string): Promise<void> {
  await getDb().run('DELETE FROM test_envs WHERE id = ?', id);
}
