---
name: monitor-pr
description: >-
  Babysit a pull request after you open it or push to it. Waits for the
  repository's Claude bot reviewer, addresses its comments, pushes fixes,
  and repeats until the bot has nothing new, then pings the user. Posts a
  status update to the originating chat thread every 5 minutes. Use this
  every time you create a PR or push more commits to an existing one.
---

# Monitor PR

Whenever you create a PR or push to an existing one, you own it until the Claude reviewer bot is satisfied. Do not tell the user the PR is "done" just because it is open.

## When to start

Immediately after `gh pr create` or any `git push` to a PR branch. If a monitor task for this PR already exists (`ncl tasks list`), don't create a second one — the next scheduled run picks up your new push. Otherwise create it (below).

## Start the monitor

Run from the session that is talking to the user (the Discord thread that asked for the PR). Scheduled-task messages are delivered back into this thread, so create the task here, not from another session.

1. **Destination — get this exactly right.** You have many near-identical channel destinations (e.g. `discord-mg-17882`, `discord-mg-17882-2`, `discord-mg-17882-3`) and one wrong character posts into a different channel. Take the destination from the message you're answering (its channel/thread routing), never from memory or a similar-looking name. Before creating the task, confirm the name appears in your destinations list *and* matches the channel of the message that asked for the PR. All status updates, replies and pings go only to that thread, never to another thread or channel.
2. Note three things to bake into the prompt: the PR (`owner/repo#N`), your destination name for this thread (shown in your destinations list — task sessions must pass it as `to` on every `send_message`), and the user's mention so you can ping them.
3. Create a gated 5-minute task. The gate keeps it cheap and satisfies the frequency limit; it only wakes you while the PR is open:

```bash
ncl tasks create --name "monitor pr <N>" --recurrence "*/5 * * * *" \
  --script 'state=$(gh pr view <N> --repo <owner/repo> --json state -q .state 2>/dev/null || echo UNKNOWN); if [ "$state" = "OPEN" ] || [ "$state" = "UNKNOWN" ]; then echo "{\"wakeAgent\": true, \"data\": {\"state\": \"$state\"}}"; else echo "{\"wakeAgent\": false}"; fi' \
  --prompt "<prompt below, filled in>"
```

Test the script with `bash -c '<script>'` first. Then tell the user, in one line, that you're monitoring the PR and will post updates here.

### Task prompt (fill in the placeholders)

> Monitor PR `<owner/repo>#<N>` per the monitor-pr skill, "Each run". Post ONLY to destination `<to>` (the originating thread) — never any other channel or thread. When finished, ping `<user mention>`. Work in the checkout at `<path>` on branch `<branch>`.

## Each run

Keep state in `/workspace/agent/monitor-pr/<owner>-<repo>-<N>.json`: `last_review_id`, `last_head_sha`, `rounds`, `started_at`.

1. **Fetch** the PR state, head SHA, CI checks (`gh pr checks`), reviews (`gh pr view --json reviews`) and inline comments (`gh api repos/<o>/<r>/pulls/<N>/comments`, plus issue comments). The Claude reviewer is the author whose login contains `claude` (typically `claude[bot]`). Ignore other reviewers unless the user asked otherwise.
2. **Post a status update** to the thread, every run, short and factual — e.g. `PR #N · round 2 · CI: 3/4 passing · Claude review: waiting on review of abc1234 · 14 min in`. Include which of these states applies:
   - *Waiting* — pushed, Claude hasn't reviewed the current head yet. Do nothing else; do not poll in a loop inside the run.
   - *Addressing* — Claude posted new comments since `last_review_id`.
   - *CI failing* — name the failing check and say you're fixing it.
   - *Clean* — see step 5.
3. **Address new Claude comments** (those after `last_review_id`). Read each one against the code, then decide: fix it, or won't-fix. If a comment is wrong, out of scope, or you disagree, make no change.
   **Every comment thread gets a reply from you, no exceptions** — the user reads these replies to know you saw it. Reply in the thread itself (`gh api repos/<o>/<r>/pulls/<N>/comments/<id>/replies -f body=...` for inline comments; a PR comment quoting the point for top-level ones):
   - *Fixed* — `Fixed in <sha>: <one line on what changed>.`
   - *Won't fix* — `Won't fix: <one-line reason>.`
   Reply even when the comment is a nit or a duplicate of an earlier one. **Never resolve a review thread or comment yourself** (no "Resolve conversation" click, no `resolveReviewThread` GraphQL mutation) unless the user has explicitly told you that you may, for this PR or in standing instructions. Replying is your job; resolving is the user's (or the reviewer bot's) call. Before finishing a round, list the round's comment ids and confirm each has your reply; a round isn't complete with any unanswered thread. For fixes, the SHA only exists after the push in step 5, so post the replies after pushing; post won't-fix replies immediately.
4. **Fix CI failures.** For every failed check (`gh pr checks`), pull the logs (`gh run view <run-id> --log-failed`), find the root cause, and fix it in the same round as review comments. Reproduce locally where you can. Treat flaky-looking failures with care: re-run once (`gh run rerun <run-id> --failed`) only if the log shows an infra/network error, otherwise fix the code. Never skip, disable, or weaken tests/checks to get green.
5. **Verify, commit, push.** Run the repo's tests/typecheck/lint for what you touched, make one commit per round with a message naming what was addressed, **always committed as `tia.dillman+ruby@gmail.com` and no other email**: run `git -c user.email=tia.dillman+ruby@gmail.com commit ...` so author and committer email are both that address, whatever the repo or global git config says; if a commit was made with any other email, amend it before pushing, push, and update state (`last_review_id`, `last_head_sha`, `rounds += 1`). Then post the *Fixed* replies from step 3 with this commit's SHA. The bot re-reviews on push; the next run looks for it. Mention CI fixes in the commit message.
6. **Finish** when the latest Claude review is on the current head SHA, it raised nothing new to address (or everything it raised is fixed/answered), and all CI checks have finished green (pending checks mean keep waiting):
   - Post a final message pinging the user: PR link, number of rounds, what changed across rounds, anything you disagreed with and why, and that it's ready for their review.
   - `ncl tasks cancel <task id>` (`ncl tasks list` to find it), and delete the state file.

## Limits and escalation

- Stop and ping the user (and cancel the task) rather than looping if: 5 rounds pass without a clean review, the same comment recurs after you've fixed it twice, a fix would exceed the scope of the PR, the same CI check fails after two fix attempts, CI fails for reasons outside your change (e.g. broken on the base branch), or you can't push (auth/permissions/branch protection).
- If no Claude review appears within 30 minutes of a push, say so in the status update and ping the user once; the bot may not be configured on this repo.
- If the PR is merged or closed, post a final line and cancel the task.
- Never merge the PR, force-push, or bypass checks. Merging is the user's call.
- Never resolve review threads on your own; only do so if the user has told you that you can.

## Troubleshooting

- `gh` unauthenticated or 401: credentials come from the gateway; don't ask the user for tokens — report it and stop.
- Status updates landing in the channel root instead of the thread: the task was created from the wrong session. Cancel it and recreate it from the thread's session.
- Task refused for frequency: the `--script` gate is missing from `ncl tasks create`.
