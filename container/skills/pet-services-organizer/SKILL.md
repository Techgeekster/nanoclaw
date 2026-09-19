---
name: pet-services-organizer
description: >-
  Splits the Pet Services email folder into per-platform sub-folders (Rover,
  Sniffspot), creating them if they don't exist. Provider-agnostic — works
  against Gmail, Microsoft Graph/Outlook, or any mailbox reachable through
  the OneCLI gateway. Use when the user asks to organize, sort, or clean up
  the Pet Services folder specifically — not the Inbox. Pairs with the
  email-organizer skill, which is what gets mail into Pet Services in the
  first place; this skill runs afterward, on Pet Services itself. Requires
  the onecli-gateway skill for the actual API calls.
metadata:
  author: nanoclaw
  version: "1.0.0"
---

# Pet Services Organizer

Goes through the **Pet Services** folder — not the Inbox — and splits its
contents into per-platform sub-folders: Rover and Sniffspot. Anything in
Pet Services from a platform that isn't one of those two stays exactly
where it is.

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
2. **Only touch the Pet Services folder.** Don't reach into the Inbox or
   any other folder. This skill's entire job is re-sorting what's already
   sitting in Pet Services — it never decides what belongs in Pet Services
   in the first place (that's `email-organizer`'s job).
3. **Reuse a sub-folder if one already fits; create one only when nothing
   does.** Match loosely (case-insensitive, plausible synonyms) before
   creating a new one with the exact name given.
4. **Moving into a sub-folder means leaving Pet Services**, not sitting in
   both. On a labels-based provider (Gmail), adding the sub-folder label
   and removing the parent `Pet Services` label is **one operation, not
   two** — a message left with both labels is a bug. Use a single `modify`
   call for both changes (see provider mechanics).
5. **Always run in a fresh session** — same reasoning as
   `email-organizer`'s rule 6: an ongoing conversation can drift stale
   against this file. If you're not already inside a task's own isolated
   session, delegate to a one-shot task (`ncl tasks create --process-after
   "now" --prompt "Run the pet-services-organizer skill against Pet
   Services for [EMAIL ADDRESS]. When done, send_message the result back
   to [DESTINATION NAME]."`) instead of running the workflow inline.
6. **Don't dump a full per-message listing into the conversation.** This
   skill runs as one continuous session — printing every Pet Services
   message's subject/sender to stdout to eyeball-classify it is what
   forces a mid-run compaction on a large folder. Rover and Sniffspot are
   both sender-identifiable — resolve them with a provider search and file
   straight from the id list rather than listing the whole folder's
   content first. If you do need a working file, put it under
   `/workspace/agent/` and query it with `grep`/`jq` rather than printing
   the whole thing.

## Sub-folder taxonomy

| Category | Folder | Goes here |
|---|---|---|
| Rover | **Pet Services/Rover** | Booking confirmations, sitter messages, receipts, and reviews from Rover. |
| Sniffspot | **Pet Services/Sniffspot** | Booking confirmations, host messages, receipts, and reviews from Sniffspot. |

Rover and Sniffspot are siblings under Pet Services, not one inside the
other. A message from another pet-services platform, or anything that
doesn't clearly belong to one of these two, stays in Pet Services
untouched — this skill only pulls those two specific categories out, it
doesn't re-triage everything else in the folder.

## Workflow

1. Resolve and confirm the target email address (rule 0). Don't proceed
   without it.
2. List what's currently in the Pet Services folder (nothing else — not
   the Inbox, not its other contents beyond what you're about to
   classify).
3. For each message, check whether it's from Rover, Sniffspot, or neither.
4. Look up the Rover/Sniffspot sub-folders; create whichever don't already
   exist.
5. Move matches into their sub-folder, per rule 4 above. Leave everything
   else exactly where it is in Pet Services.
6. Report back: which address you acted on, **the total number of
   messages moved out of Pet Services**, the breakdown behind that total
   (how many to Rover, how many to Sniffspot), and how many stayed in Pet
   Services untouched.

**If Pet Services has over 100 messages, use bulk mode:** classify with a
provider search scoped to the Pet Services folder (sender keywords for
Rover and Sniffspot) instead of fetching each message individually, then
file each category's matches in one batch call — Gmail `batchModify` (up
to 1000 ids/call), Outlook `$batch` (up to 20 requests/call) — instead of
one call per message. Whatever the searches don't catch stays in Pet
Services, same as step 5.

## Provider mechanics

Requests go through the OneCLI gateway (see the `onecli-gateway` skill) —
call the real API URL directly, never handle a raw credential. Nesting
works differently per provider — don't reuse a flat-folder create call
here.

**Gmail** — folders are labels; "/" in the label name is the nesting.

```bash
# What's in Pet Services right now
curl -s "https://gmail.googleapis.com/gmail/v1/users/me/labels"
curl -s "https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=<petServicesLabelId>"
# Create a sub-label if it's missing — full path as the name
curl -s -X POST "https://gmail.googleapis.com/gmail/v1/users/me/labels" \
  -H "Content-Type: application/json" \
  -d '{"name":"Pet Services/Rover","labelListVisibility":"labelShow","messageListVisibility":"messageShow"}'
curl -s -X POST "https://gmail.googleapis.com/gmail/v1/users/me/labels" \
  -H "Content-Type: application/json" \
  -d '{"name":"Pet Services/Sniffspot","labelListVisibility":"labelShow","messageListVisibility":"messageShow"}'
# Move: add the sub-label, drop the parent Pet Services label — one call (rule 4)
curl -s -X POST "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}/modify" \
  -H "Content-Type: application/json" \
  -d '{"addLabelIds":["<subLabelId>"],"removeLabelIds":["<petServicesLabelId>"]}'
```

**Microsoft Graph / Outlook** — real folder hierarchy; create sub-folders
as children of the Pet Services folder's own id, not top-level.

```bash
# What's in Pet Services right now
curl -s "https://graph.microsoft.com/v1.0/me/mailFolders"
curl -s "https://graph.microsoft.com/v1.0/me/mailFolders/<petServicesFolderId>/messages"
# Create a child folder if it's missing
curl -s -X POST "https://graph.microsoft.com/v1.0/me/mailFolders/<petServicesFolderId>/childFolders" \
  -H "Content-Type: application/json" -d '{"displayName":"Rover"}'
curl -s -X POST "https://graph.microsoft.com/v1.0/me/mailFolders/<petServicesFolderId>/childFolders" \
  -H "Content-Type: application/json" -d '{"displayName":"Sniffspot"}'
# Move into the child folder's own id — a real move already leaves the parent (rule 4 is automatic here)
curl -s -X POST "https://graph.microsoft.com/v1.0/me/messages/{id}/move" \
  -H "Content-Type: application/json" -d '{"destinationId":"<childFolderId>"}'
```

If a request 401s/403s with `app_not_connected`, that mailbox isn't
authorized in OneCLI yet — follow the onecli-gateway skill's connect-link
flow, don't try to work around it.

## Notes

- Rover mail that reaches this folder is already business-only —
  `email-organizer` examines each Rover message's content before filing and
  routes personal Rover bookings (a service *we* booked for one of our own
  dogs) straight to a separate **Puppers** folder, never into Pet Services
  in the first place. So the sender-only match here is safe: nothing left
  to re-check.
- Don't change the sub-folder taxonomy or the never-delete rule without the
  user asking.
- If Pet Services itself doesn't exist yet (nothing has been filed there),
  run `email-organizer` first — this skill has nothing to sort otherwise.
