---
name: drive-backup
description: >-
  Sets up a recurring Google Drive backup of your own /workspace/agent/
  folder using Grandfather-Father-Son (GFS) rotation, via the OneCLI
  gateway. Use this skill when the user asks you to back up your workspace,
  protect against data loss, set up a Drive backup, or schedule regular
  backups of your memory/templates/instructions. Also use it if the user
  references "GFS rotation", "grandfather-father-son backup", or asks for
  daily/weekly/monthly backup retention.
metadata:
  author: nanoclaw
  version: "1.0.0"
---

# Drive Backup (GFS Rotation)

Backs up your own `/workspace/agent/` folder to Google Drive on a recurring
schedule, with Grandfather-Father-Son rotation so backups stay useful over
time without growing forever. Requests go through the OneCLI gateway (see
the `onecli-gateway` skill) — you never handle a raw Drive credential.

## What GFS rotation means

Three tiers, each with its own retention window:

| Tier | Nickname | Cadence | Kept for |
|---|---|---|---|
| Daily | Son | every run | 7 days |
| Weekly | Father | every Sunday | 5 weeks |
| Monthly | Grandfather | 1st of the month | 12 months |

Every run uploads to Daily. If that day also happens to be a promotion day
(Sunday, or the 1st of the month), the same file is additionally copied into
Weekly and/or Monthly — no need to re-upload the bytes, Drive can copy a file
server-side. Each tier is pruned independently by age, so Daily churns fast
while Weekly and Monthly quietly build a longer history.

## Folder structure

One parent folder per agent group, so multiple groups can each have their
own backup history without colliding:

```
Drive:
└── [Agent Name] NanoClaw Backup/
    ├── Daily/     (last 7 days)
    ├── Weekly/    (last 5 Sundays)
    └── Monthly/   (last 12 months)
```

## Setting it up

Create one recurring task on your own agent group. Pick a daily time that
doesn't collide with other scheduled work on this group. Adjust
`[AGENT NAME]` and the retention numbers to taste — these are sane defaults,
not fixed rules.

```bash
ncl tasks create \
  --name "drive backup" \
  --recurrence "15 4 * * *" \
  --prompt "You are backing up your own workspace to Google Drive with GFS (Grandfather-Father-Son) rotation, in case something ever needs to be recovered.

STEPS:

1. Archive: tar --exclude=node_modules -czf /tmp/backup-\$(date +%F).tar.gz -C /workspace agent

2. Find or create the parent folder '[AGENT NAME] NanoClaw Backup' and its Daily/Weekly/Monthly subfolders:
   - Check memory/infrastructure.md (or similar) for cached folder IDs first — if all three are cached, skip the lookup/create below entirely
   - Otherwise, via Drive API v3 through the OneCLI proxy (Authorization: Bearer placeholder — proxy injects the real token):
     - files.list with q=\"name='[AGENT NAME] NanoClaw Backup' and mimeType='application/vnd.google-apps.folder' and trashed=false\"
     - If missing, create it: POST https://www.googleapis.com/drive/v3/files {\"name\": \"[AGENT NAME] NanoClaw Backup\", \"mimeType\": \"application/vnd.google-apps.folder\"}
     - Same lookup/create for Daily, Weekly, Monthly as children (set \"parents\": [\"<parent folder id>\"])
     - Cache all four IDs in memory/infrastructure.md so every future run skips this

3. Upload today's archive to Daily/ as multipart/related to https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart — metadata: {\"name\": \"backup-[DATE].tar.gz\", \"parents\": [\"<Daily folder id>\"]}, media: the tar.gz bytes, Content-Type application/gzip.

4. Promotion — check today's date:
   - If today is a Sunday: copy the file just uploaded into Weekly/ via POST https://www.googleapis.com/drive/v3/files/<fileId>/copy with {\"parents\": [\"<Weekly folder id>\"]}
   - If today is the 1st of the month: copy it into Monthly/ the same way

5. Pruning — for each tier, list files in that folder ordered by createdTime, and delete (DELETE https://www.googleapis.com/drive/v3/files/<fileId>) any older than its retention window:
   - Daily: older than 7 days
   - Weekly: older than 5 weeks (35 days)
   - Monthly: older than 12 months (365 days)
   Only prune within a run that just uploaded successfully — never prune on a failed run.

6. If any request fails with 401/403/app_not_connected: Google Drive isn't authorized yet. Show the connect_url as a bare URL on its own line so the user can authorize. Log it and stop for this run — it'll pick back up next scheduled run.

7. On success, append a brief log note (filename, which tiers it landed in, anything pruned). Only message the user directly if something needs their attention (the connect_url case, or a real failure) — a routine clean run doesn't need a report."
```

## Notes

- **Never** change the retention windows or delete something outside the
  pruning rule above without the user asking — GFS rotation is a deliberate,
  user-set policy, not something to improvise on.
- If the parent folder name collides with another group's (unlikely, since
  it's prefixed with the agent's name), ask the user rather than guessing
  which one is meant.
- This is a per-group setup: each agent group that wants backups creates its
  own task, its own parent folder, and caches its own folder IDs. Nothing is
  shared between groups.
