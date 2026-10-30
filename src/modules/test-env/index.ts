/**
 * Test-env module — host-brokered local Supabase stacks for agents.
 *
 * Agents need a real backend to test against, but a Docker socket in the
 * container would be host root. Instead the host runs the stack on the
 * agent's behalf (`ncl test-envs up`), and the agent only receives URLs and
 * keys for its own stack. See container/skills/test-envs/SKILL.md.
 */
import { registerMigration } from '../../db/migrations/index.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { _drainTestEnvOps, reapExpiredTestEnvs, reconcileTestEnvsOnStart } from './manager.js';
import { testEnvsMigration } from './store.js';
import './resource.js';

registerMigration(testEnvsMigration);

const REAP_INTERVAL_MS = 60_000;
let timer: ReturnType<typeof setInterval> | undefined;

onHostStart(async () => {
  // Never let test-env bookkeeping block host start.
  await reconcileTestEnvsOnStart().catch((err) => log.warn('Test env reconcile failed', { err }));
  timer = setInterval(() => {
    reapExpiredTestEnvs().catch((err) => log.warn('Test env reap failed', { err }));
  }, REAP_INTERVAL_MS);
  timer.unref();
});

onHostShutdown(async () => {
  if (timer) clearInterval(timer);
  timer = undefined;
  // Running stacks outlive the host on purpose (their TTL still applies on
  // the next start); only let in-flight bookkeeping settle briefly.
  await Promise.race([_drainTestEnvOps(), new Promise((r) => setTimeout(r, 2_000))]);
});
