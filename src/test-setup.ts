import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, vi } from 'vitest';

import type { GatewayProviderDefinition } from './gateway-providers/gateway-provider-registry.js';

// Tests must not depend on the developer's real .env (e.g. NANOCLAW_CROSS_SESSION_ECHO=off
// or Discord credentials changing which code path runs). With no explicit
// projectRoot, read an empty directory instead of the repo's own .env. Tests
// that chdir elsewhere (a temp dir with its own .env) are left alone.
// Captured at setup time, before any test chdirs elsewhere.
const { repoRoot } = vi.hoisted(() => ({ repoRoot: process.cwd() }));

vi.mock('./env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./env.js')>();
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-env-'));
  const defaultRoot = () => (process.cwd() === repoRoot ? emptyRoot : process.cwd());
  return {
    ...actual,
    readEnvFile: (keys: string[], projectRoot?: string) => actual.readEnvFile(keys, projectRoot ?? defaultRoot()),
    envValue: (key: string, projectRoot?: string) => actual.envValue(key, projectRoot ?? defaultRoot()),
  };
});

const gateway: GatewayProviderDefinition = {
  kind: 'test-gateway',
  agentSkills: [],
  sessions: {
    async ensure() {
      return { contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' } } } };
    },
  },
  approvals: {
    async subscribe(_decide, signal) {
      if (signal.aborted) return;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  },
};

beforeEach(async () => {
  await import('./mailbox/compose.js');
  (await import('./gateway-providers/index.js')).resetGatewayProvider(gateway);
});
