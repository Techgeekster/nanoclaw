/**
 * OneCLI — the built-in gateway provider.
 *
 * The same wiring the spawn path always did (ensure the agent exists
 * gateway-side, fetch the per-session container config, treat "not applied" as
 * a transient hard failure), with one change: the contribution crosses into
 * the spec as TYPED env and mounts, merged before validation, instead of raw
 * docker flags appended after it.
 *
 * The SDK's apply surface still emits argv, so this provider parses it at the
 * boundary. The grammar is closed and known from the SDK source: with
 * `addHostMapping: false` it emits exactly `-e KEY=VALUE` pairs (proxy env,
 * CA bundle pointers) and `-v host:container[:ro]` mounts (the CA
 * certificate, credential stub FILES — stubs never ride env). Anything else
 * refuses the spawn: nothing gets to ride raw argv around the spec again. A
 * typed SDK config surface is the successor that deletes this parser.
 */
import { lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OneCLI } from '@onecli-sh/sdk';

import { ONECLI_API_KEY, ONECLI_URL } from '../config.js';
import type { MountSpec } from '../drivers/types.js';
import { log } from '../log.js';

import {
  registerGatewayProvider,
  type GatewayApprovalRequest,
  type GatewayApprovalSource,
  type GatewayContribution,
} from './gateway-provider-registry.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

/**
 * The SDK writes its CA bundle to these two fixed, shared paths in the OS
 * tmpdir via plain `fs.writeFileSync` (`@onecli-sh/sdk` `src/container/ca.ts`)
 * and then bind-mounts them into the spawned container. If a `docker run -v`
 * ever executes while the container runtime is restarting or otherwise
 * unhealthy — something this host's docker/WSL setup does hit from time to
 * time — dockerd can auto-vivify a momentarily-missing bind-mount source as a
 * root-owned *directory* instead of a file. Once that happens, the SDK's
 * `writeFileSync` throws EISDIR forever: it has no way to tell "this should
 * be a file" and clean up after itself, so every future spawn for every
 * agent group fails silently and host-sweep just retries it forever. Clear
 * any stray directory here, before every spawn, so that vendor footgun can
 * never wedge the whole install again.
 */
const ONECLI_TMP_CA_PATHS = [join(tmpdir(), 'onecli-proxy-ca.pem'), join(tmpdir(), 'onecli-combined-ca.pem')];

/** Exported for its test — the failure mode it guards against is otherwise unreproducible without a real docker/tmpdir race. */
export function clearStrayOnecliCaDirectories(): void {
  for (const path of ONECLI_TMP_CA_PATHS) {
    try {
      if (!lstatSync(path).isDirectory()) continue;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    rmSync(path, { recursive: true, force: true });
    log.warn('Cleared stray OneCLI CA directory that would have blocked every container spawn', { path });
  }
}

/** Argv → typed contribution. Exported for its tests; the grammar is closed. */
export function contributionFromArgs(args: readonly string[], groupScope: string): GatewayContribution {
  const env: Record<string, string> = {};
  const mounts: MountSpec[] = [];
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === '-e' && value?.includes('=')) {
      const eq = value.indexOf('=');
      env[value.slice(0, eq)] = value.slice(eq + 1);
      continue;
    }
    if (flag === '-v' && value) {
      const parts = value.split(':');
      if (parts.length >= 2 && parts.length <= 3 && (parts[2] === undefined || parts[2] === 'ro')) {
        mounts.push({
          class: 'allowlisted-extra',
          hostPath: parts[0],
          containerPath: parts[1],
          mode: parts[2] === 'ro' ? 'ro' : 'rw',
          groupScope,
        });
        continue;
      }
    }
    // Fail-closed on grammar drift: an SDK that starts emitting a flag this
    // parser cannot type must break the spawn loudly, not smuggle argv.
    throw new Error(`OneCLI gateway emitted argv this seam cannot type: '${flag} ${value ?? ''}'`);
  }
  return { env, mounts };
}

/**
 * OneCLI's approvals capability: the SDK's manual-approval long-poll, mapped
 * to the neutral request shape. `listPending`/`decide` are deliberately
 * absent — the gateway does not redeliver un-decided requests on reconnect
 * and the SDK exposes no late-decision surface, so the capability flags
 * honestly say so and the approvals module degrades accordingly.
 */
function onecliApprovalSource(): GatewayApprovalSource {
  return {
    subscribe(handler) {
      const handle = onecli.configureManualApproval(async (request) =>
        // The SDK's ApprovalRequest is structurally the neutral shape (the
        // hosted gateway's `summary` rides as an extra field).
        handler(request as unknown as GatewayApprovalRequest),
      );
      return { stop: () => handle.stop() };
    },
  };
}

registerGatewayProvider('onecli', () => ({
  kind: 'onecli',
  approvals: onecliApprovalSource,
  async contribute({ key, groupName }) {
    // OneCLI agent identifier is always the agent group id — stable across
    // sessions and reversible via getAgentGroup() for approval routing.
    await onecli.ensureAgent({ name: groupName, identifier: key.agentGroupId });
    clearStrayOnecliCaDirectories();
    const args: string[] = [];
    const applied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: key.agentGroupId });
    if (!applied) {
      throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
    }
    log.info('OneCLI gateway applied', { agentGroupId: key.agentGroupId, sessionId: key.sessionId });
    return contributionFromArgs(args, key.agentGroupId);
  },
}));
