---
name: test-envs
description: Spin up a disposable local Supabase stack (Postgres + auth + REST) to test backend changes — e.g. PawSavvy API work, migrations, RLS, RPCs. Use whenever you or a subagent need a real database to run backend tests or verify a migration. There is no Docker inside your container; the host runs the stack for you via `ncl test-envs`.
---

# Local test environments (`ncl test-envs`)

You can't run Docker in this container — that's deliberate (a Docker socket would give you control of the whole host). Instead, ask the host to run a stack for you. Each stack is yours alone: its own Postgres, auth (GoTrue) and REST (PostgREST), its own ports, loaded with your checkout's `supabase/migrations/*.sql` and `supabase/seed.sql`.

## Lifecycle

```bash
# 1. Start (returns immediately with an id, status "starting")
ncl test-envs up --repo /workspace/agent/clones/pawsavvy-240

# 2. Poll until status is "running" (first ever run pulls images ~3 min; after that ~30s)
ncl test-envs get te-1a2b3c4d

# 3. Load connection env into your shell
eval "$(ncl test-envs env te-1a2b3c4d)"
#   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET,
#   SUPABASE_PUBLISHABLE_KEY, DATABASE_URL, NO_PROXY

# 4. Changed a migration? Re-apply everything from scratch (DB is wiped and rebuilt)
ncl test-envs reset te-1a2b3c4d      # then poll get until "running"; check "error"

# 5. Done? Tear it down — always.
ncl test-envs down te-1a2b3c4d
```

Other verbs: `ncl test-envs list`, `ncl test-envs extend te-… --ttl-minutes 240`, `ncl test-envs help`.

Rules:

- `--repo` must be a checkout under `/workspace/agent` (absolute, or relative to it). Only the SQL files are copied — the host generates its own `config.toml`, so edits to your repo's `supabase/config.toml` are ignored.
- Envs expire (default 120 min, max 480) and are deleted automatically. Use `extend` for long sessions.
- Limit: 3 envs at most on the whole host, shared by every agent and subagent. If `up` says the limit is reached, `list` and `down` ones you no longer need — or reuse one you already have.
- Optional services are off by default. Add with `--with storage,realtime,studio,mail,functions` only when the test needs them (each costs RAM and start time).
- Data is throwaway. Never point a test env at production data and never put real secrets in seed files.

## Networking

The stack runs on the host and is reached at `host.docker.internal:<port>`. Your container's HTTP(S) traffic normally goes through the credential proxy, which can't reach it — the `NO_PROXY` value in `env` fixes that. Always `eval` the env (or pass `NO_PROXY` through) before starting anything that makes HTTP calls to `SUPABASE_URL`. Postgres (`DATABASE_URL`) is plain TCP and isn't proxied.

If something can't connect: confirm `ncl test-envs get <id>` says `running`, that `NO_PROXY` is set in the process that's connecting, and `curl --noproxy '*' "$SUPABASE_URL/auth/v1/health"`.

## PawSavvy

The API reads `SUPABASE_URL`, `SUPABASE_PUBLIC_API_KEY` and `DATABASE_URL`:

```bash
eval "$(ncl test-envs env te-…)"
export SUPABASE_PUBLIC_API_KEY="$SUPABASE_ANON_KEY"
cd /workspace/agent/clones/pawsavvy-240
npx nx test pawsavvy-api            # or run the API: npx nx serve pawsavvy-api
```

## Subagents

Subagents run in your container and can use `ncl test-envs` the same way. Pick one pattern and say it explicitly in the subagent's prompt:

- **Shared:** you start one env, pass the subagent its id, and tell it to `eval "$(ncl test-envs env <id>)"`. Don't let two subagents `reset` the same env concurrently.
- **Isolated:** each subagent runs `up` for itself (needed when they change migrations independently) and must `down` its env before finishing. With the 3-env host limit, run at most 3 isolated subagents at once, and fewer if other agents already hold envs.

Whoever started an env owns tearing it down. Before you finish a task, run `ncl test-envs list` and `down` anything you started.
