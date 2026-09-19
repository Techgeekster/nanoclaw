---
name: jobs-organizer
description: >-
  Splits the Jobs email folder into Job Applications and Job Search
  sub-folders, creating them if they don't exist. Provider-agnostic — works
  against Gmail, Microsoft Graph/Outlook, or any mailbox reachable through
  the OneCLI gateway. Use when the user asks to organize, sort, or clean up
  the Jobs folder specifically — not the Inbox. Pairs with the
  email-organizer skill, which is what gets mail into Jobs in the first
  place; this skill runs afterward, on Jobs itself. Requires the
  onecli-gateway skill for the actual API calls.
metadata:
  author: nanoclaw
  version: "1.0.0"
---

# Jobs Organizer

Goes through the **Jobs** folder — not the Inbox — and splits its contents
into two sub-folders: Job Applications and Job Search. Anything in Jobs
that isn't one of those two (career-tips newsletters, "pass the interview"
course marketing, generic career content) stays exactly where it is.

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
2. **Only touch the Jobs folder.** Don't reach into the Inbox or any other
   folder. This skill's entire job is re-sorting what's already sitting in
   Jobs — it never decides what belongs in Jobs in the first place (that's
   `email-organizer`'s job).
3. **Reuse a sub-folder if one already fits; create one only when nothing
   does.** Match loosely (case-insensitive, plausible synonyms) before
   creating a new one with the exact name given.
4. **Moving into a sub-folder means leaving Jobs**, not sitting in both. On
   a labels-based provider (Gmail), adding the sub-folder label and
   removing the parent `Jobs` label is **one operation, not two** — a
   message left with both labels is a bug. Use a single `modify` call for
   both changes (see provider mechanics).
5. **Always run in a fresh session** — same reasoning as
   `email-organizer`'s rule 6: an ongoing conversation can drift stale
   against this file. If you're not already inside a task's own isolated
   session, delegate to a one-shot task (`ncl tasks create --process-after
   "now" --prompt "Run the jobs-organizer skill against Jobs for [EMAIL
   ADDRESS]. When done, send_message the result back to [DESTINATION
   NAME]."`) instead of running the workflow inline.
6. **Don't dump a full per-message listing into the conversation.** This
   skill runs as one continuous session — printing every Jobs message's
   subject/sender to stdout to eyeball-classify it is what forces a
   mid-run compaction on a large folder. Resolve LinkedIn/Indeed sender
   matches with a provider search and file straight from the id list; only
   fetch subject/sender (never a full body) for the smaller remainder that
   needs the personal-recruiter-vs-template judgment call. If you do need
   a working file, put it under `/workspace/agent/` and query it with
   `grep`/`jq` rather than printing the whole thing.

## Sub-folder taxonomy

| Category | Folder | Goes here |
|---|---|---|
| Job applications | **Jobs/Job Applications** | Only two things: (1) a response to an application you actually submitted — confirmation, interview request, rejection, offer — or (2) a recruiter **personally** reaching out to you about a specific opportunity (an individually addressed message, not a template blast). |
| Job search alerts | **Jobs/Job Search** | Any LinkedIn or Indeed job-search notification: saved-search digests ("new jobs matching your search"), "jobs recommended for you" / "based on your profile," daily or weekly job-alert emails, and similar automated job-matching notices — LinkedIn included even when it's not a literal saved-search digest. Also any "opportunities at [Company]"-style email — a generic job-board or company-careers digest listing open roles, not addressed to you individually. If instead it's a recruiter personally writing to you about one specific role by name, that's Job Applications above, not this — the "opportunities at" phrasing itself doesn't override that distinction. |

Job Applications and Job Search are siblings under Jobs, not one inside
the other. A message that's neither — career-tips newsletters, resume/
interview advice, "recruiters are viewing your profile" notices (about who
looked at your profile, not a job match), bulk recruiter marketing,
career-related course pitches — stays in Jobs untouched. This skill only
pulls those two specific categories out, it doesn't re-triage everything
else in Jobs.

## Workflow

1. Resolve and confirm the target email address (rule 0). Don't proceed
   without it.
2. List what's currently in the Jobs folder (nothing else — not the
   Inbox, not its other contents beyond what you're about to classify).
3. For each message, check whether it's Job Applications, Job Search, or
   neither.
4. Look up the Job Applications/Job Search sub-folders; create whichever
   don't already exist.
5. Move matches into their sub-folder, per rule 4 above. Leave everything
   else exactly where it is in Jobs.
6. Report back: which address you acted on, **the total number of
   messages moved out of Jobs**, the breakdown behind that total (how many
   to Job Applications, how many to Job Search), and how many stayed in
   Jobs untouched.

**If Jobs has over 100 messages, use bulk mode:** classify with a provider
search scoped to the Jobs folder (sender/subject keywords for Job
Applications and Job Search) instead of fetching each message
individually, then file each category's matches in one batch call — Gmail
`batchModify` (up to 1000 ids/call), Outlook `$batch` (up to 20
requests/call) — instead of one call per message. Whatever the searches
don't catch stays in Jobs, same as step 5.

## Provider mechanics

Requests go through the OneCLI gateway (see the `onecli-gateway` skill) —
call the real API URL directly, never handle a raw credential. Nesting
works differently per provider — don't reuse a flat-folder create call
here.

**Gmail** — folders are labels; "/" in the label name is the nesting.

```bash
# What's in Jobs right now
curl -s "https://gmail.googleapis.com/gmail/v1/users/me/labels"
curl -s "https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=<jobsLabelId>"
# Create a sub-label if it's missing — full path as the name
curl -s -X POST "https://gmail.googleapis.com/gmail/v1/users/me/labels" \
  -H "Content-Type: application/json" \
  -d '{"name":"Jobs/Job Applications","labelListVisibility":"labelShow","messageListVisibility":"messageShow"}'
curl -s -X POST "https://gmail.googleapis.com/gmail/v1/users/me/labels" \
  -H "Content-Type: application/json" \
  -d '{"name":"Jobs/Job Search","labelListVisibility":"labelShow","messageListVisibility":"messageShow"}'
# Move: add the sub-label, drop the parent Jobs label — one call (rule 4)
curl -s -X POST "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}/modify" \
  -H "Content-Type: application/json" \
  -d '{"addLabelIds":["<subLabelId>"],"removeLabelIds":["<jobsLabelId>"]}'
```

**Microsoft Graph / Outlook** — real folder hierarchy; create sub-folders
as children of the Jobs folder's own id, not top-level.

```bash
# What's in Jobs right now
curl -s "https://graph.microsoft.com/v1.0/me/mailFolders"
curl -s "https://graph.microsoft.com/v1.0/me/mailFolders/<jobsFolderId>/messages"
# Create a child folder if it's missing
curl -s -X POST "https://graph.microsoft.com/v1.0/me/mailFolders/<jobsFolderId>/childFolders" \
  -H "Content-Type: application/json" -d '{"displayName":"Job Applications"}'
curl -s -X POST "https://graph.microsoft.com/v1.0/me/mailFolders/<jobsFolderId>/childFolders" \
  -H "Content-Type: application/json" -d '{"displayName":"Job Search"}'
# Move into the child folder's own id — a real move already leaves the parent (rule 4 is automatic here)
curl -s -X POST "https://graph.microsoft.com/v1.0/me/messages/{id}/move" \
  -H "Content-Type: application/json" -d '{"destinationId":"<childFolderId>"}'
```

If a request 401s/403s with `app_not_connected`, that mailbox isn't
authorized in OneCLI yet — follow the onecli-gateway skill's connect-link
flow, don't try to work around it.

## Notes

- Don't change the sub-folder taxonomy or the never-delete rule without the
  user asking.
- If Jobs itself doesn't exist yet (nothing has been filed there), run
  `email-organizer` first — this skill has nothing to sort otherwise.
