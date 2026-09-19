---
name: finance-organizer
description: >-
  Splits the Finances email folder into Investments and Retirement
  sub-folders, creating them if they don't exist. Provider-agnostic — works
  against Gmail, Microsoft Graph/Outlook, or any mailbox reachable through
  the OneCLI gateway. Use when the user asks to organize, sort, or clean up
  the Finances folder specifically — not the Inbox. Pairs with the
  email-organizer skill, which is what gets mail into Finances in the
  first place; this skill runs afterward, on Finances itself. Requires the
  onecli-gateway skill for the actual API calls.
metadata:
  author: nanoclaw
  version: "1.0.0"
---

# Finance Organizer

Goes through the **Finances** folder — not the Inbox — and splits its
contents into two sub-folders: Investments and Retirement. Anything in
Finances that isn't one of those two stays exactly where it is.

## Absolute rules

0. **Never run this without a specific email address to act on.** Same
   requirement as `email-organizer`'s rule 0: if the triggering request
   doesn't name the address, ask before doing anything else, then confirm
   the connected mailbox actually matches:

   ```bash
   # Gmail
   curl -s "https://gmail.googleapis.com/gmail/v1/users/me/profile"   # check emailAddress
   # Microsoft Graph / Outlook
   curl -s "https://graph.microsoft.com/v1.0/me"                       # check mail / userPrincipalName
   ```

1. **Never delete.** Not `messages.delete`, not trash/Deleted Items either
   — a "trash" folder is a timed deletion queue, not an archive. The only
   exception is the user explicitly asking you to delete something in that
   conversation.
2. **Only touch the Finances folder.** Don't reach into the Inbox or any
   other folder. This skill's entire job is re-sorting what's already
   sitting in Finances — it never decides what belongs in Finances in the
   first place (that's `email-organizer`'s job).
3. **Reuse a sub-folder if one already fits; create one only when nothing
   does.** Match loosely (case-insensitive, plausible synonyms) before
   creating a new one with the exact name given.
4. **Moving into a sub-folder means leaving Finances**, not sitting in
   both. On a labels-based provider (Gmail), adding the sub-folder label
   and removing the parent `Finances` label is **one operation, not two**
   — a message left with both labels is a bug. Use a single `modify` call
   for both changes (see provider mechanics).
5. **Always run in a fresh session** — same reasoning as
   `email-organizer`'s rule 6: an ongoing conversation can drift stale
   against this file. If you're not already inside a task's own isolated
   session, delegate to a one-shot task (`ncl tasks create --process-after
   "now" --prompt "Run the finance-organizer skill against Finances for
   [EMAIL ADDRESS]. When done, send_message the result back to
   [DESTINATION NAME]."`) instead of running the workflow inline.
6. **Don't dump a full per-message listing into the conversation.** This
   skill runs as one continuous session — printing every Finances
   message's subject/sender to stdout to eyeball-classify it is what
   forces a mid-run compaction on a large folder. Most of this taxonomy is
   sender-identifiable (a brokerage/crypto-exchange domain, a plan
   provider) — resolve those with a provider search and file straight from
   the id list; only fetch subject/sender (never a full body) for SoFi's
   banking-vs-investing split, which needs a closer look. If you do need a
   working file, put it under `/workspace/agent/` and query it with
   `grep`/`jq` rather than printing the whole thing.

## Sub-folder taxonomy

| Category | Folder | Goes here |
|---|---|---|
| Retirement plans | **Finances/Retirement** | 401(k)/403(b)/IRA/pension statements, contribution/match notices, and plan updates. |
| Investments | **Finances/Investments** | Brokerage, investing-app, and crypto-exchange email — statements, trade confirmations, account activity (e.g. Stash, Coinbase, Robinhood, Fidelity brokerage, SoFi Invest). SoFi sends both banking and investing mail from the same brand — a stock/ETF trade confirmation or portfolio-value update is Investments; a bank statement, transfer, or balance alert stays in the Finances root, untouched by this skill. |

Retirement and Investments are siblings under Finances, not one inside the
other. A message that's neither (a bank statement, a credit-card alert)
stays in Finances untouched — this skill only pulls those two categories
out, it doesn't re-triage everything else.

## Workflow

1. Resolve and confirm the target email address (rule 0). Don't proceed
   without it.
2. List what's currently in the Finances folder (nothing else — not the
   Inbox, not its other contents beyond what you're about to classify).
3. For each message, check whether it's Retirement, Investments, or
   neither.
4. Look up the Investments/Retirement sub-folders; create whichever don't
   already exist.
5. Move matches into their sub-folder. Leave everything else exactly where
   it is in Finances.
6. Report back: which address you acted on, **the total number of
   messages moved out of Finances**, the breakdown behind that total (how
   many to Retirement, how many to Investments), and how many stayed in
   Finances untouched.

**If Finances has over 100 messages, use bulk mode:** classify with a
provider search scoped to the Finances folder (sender/subject keywords for
Retirement and Investments) instead of fetching each message individually,
then file each category's matches in one batch call — Gmail
`batchModify` (up to 1000 ids/call), Outlook `$batch` (up to 20
requests/call) — instead of one call per message. Whatever the searches
don't catch stays in Finances, same as step 5.

## Provider mechanics

Requests go through the OneCLI gateway (see the `onecli-gateway` skill) —
call the real API URL directly, never handle a raw credential. Nesting
works differently per provider — don't reuse a flat-folder create call
here.

**Gmail** — folders are labels; "/" in the label name is the nesting.

```bash
# What's in Finances right now
curl -s "https://gmail.googleapis.com/gmail/v1/users/me/labels"
curl -s "https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=<financesLabelId>"
# Create a sub-label if it's missing — full path as the name, no separate
# "create the parent first" step needed if Finances already exists
curl -s -X POST "https://gmail.googleapis.com/gmail/v1/users/me/labels" \
  -H "Content-Type: application/json" \
  -d '{"name":"Finances/Retirement","labelListVisibility":"labelShow","messageListVisibility":"messageShow"}'
curl -s -X POST "https://gmail.googleapis.com/gmail/v1/users/me/labels" \
  -H "Content-Type: application/json" \
  -d '{"name":"Finances/Investments","labelListVisibility":"labelShow","messageListVisibility":"messageShow"}'
# Move: add the sub-label, drop the parent Finances label
curl -s -X POST "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}/modify" \
  -H "Content-Type: application/json" \
  -d '{"addLabelIds":["<subLabelId>"],"removeLabelIds":["<financesLabelId>"]}'
```

**Microsoft Graph / Outlook** — real folder hierarchy; create sub-folders
as children of the Finances folder's own id, not top-level.

```bash
# What's in Finances right now
curl -s "https://graph.microsoft.com/v1.0/me/mailFolders"
curl -s "https://graph.microsoft.com/v1.0/me/mailFolders/<financesFolderId>/messages"
# Create a child folder if it's missing
curl -s -X POST "https://graph.microsoft.com/v1.0/me/mailFolders/<financesFolderId>/childFolders" \
  -H "Content-Type: application/json" -d '{"displayName":"Retirement"}'
curl -s -X POST "https://graph.microsoft.com/v1.0/me/mailFolders/<financesFolderId>/childFolders" \
  -H "Content-Type: application/json" -d '{"displayName":"Investments"}'
# Move into the child folder's own id
curl -s -X POST "https://graph.microsoft.com/v1.0/me/messages/{id}/move" \
  -H "Content-Type: application/json" -d '{"destinationId":"<childFolderId>"}'
```

If a request 401s/403s with `app_not_connected`, that mailbox isn't
authorized in OneCLI yet — follow the onecli-gateway skill's connect-link
flow, don't try to work around it.

## Notes

- Don't change the sub-folder taxonomy or the never-delete rule without the
  user asking.
- If Finances itself doesn't exist yet (nothing has been filed there), run
  `email-organizer` first — this skill has nothing to sort otherwise.
