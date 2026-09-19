---
name: email-organizer
description: >-
  Organizes an inbox (or, if a specific folder/label is named, just that
  folder): classifies each message and files it into the right folder (or
  label), creating folders that don't exist yet and reusing ones that do.
  Provider-agnostic — works against Gmail, Microsoft Graph/Outlook, or any
  other mailbox reachable through the OneCLI gateway. Use this skill when
  the user asks to organize, clean up, sort, or triage their inbox (or a
  named folder/label), file their email, or set up inbox folders. Requires
  the onecli-gateway skill for the actual API calls.
metadata:
  author: nanoclaw
  version: "1.0.0"
---

# Email Organizer

Sorts an inbox into folders by category. The rules below are a deliberate,
user-set policy — don't improvise on them.

## Absolute rules

0. **Never run this without a specific email address to act on.** This
   skill is provider-agnostic and a single agent may have more than one
   mailbox reachable through the gateway, so never assume "whichever
   account the API defaults to" is the right one. If the triggering
   request (a chat message or a scheduled task prompt) doesn't name the
   address, ask which one before doing anything else. Once you have it,
   confirm the connected mailbox actually matches before touching
   anything:

   ```bash
   # Gmail
   curl -s "https://gmail.googleapis.com/gmail/v1/users/me/profile"   # check emailAddress
   # Microsoft Graph / Outlook
   curl -s "https://graph.microsoft.com/v1.0/me"                       # check mail / userPrincipalName
   ```

   If it doesn't match the address you were given, stop and tell the user
   instead of proceeding against the wrong mailbox.

1. **Never delete.** Not `messages.delete`, not `messages.trash`/moving to
   Trash or Deleted Items either — a "trash" folder is a timed deletion
   queue, not an archive, so it counts as deleting. The only exception is
   the user explicitly asking you to delete something in that conversation.
2. **Only touch the target scope — the Inbox by default.** If the
   triggering request names a specific folder/label ("organize the
   Promotions label," "clean up Job Search"), that folder is the scope
   instead: list only its contents and classify each against the same
   taxonomy below. Without a named folder, the scope is the Inbox. Either
   way, never reach beyond the resolved scope into Sent, Drafts, Spam, or
   any other folder — that mail has already been organized (or is out of
   bounds for a different reason).
3. **Reuse a folder if one already fits; create one only when nothing
   does.** Match loosely (case-insensitive, plausible synonyms — e.g. an
   existing "Marketing" folder satisfies the Promotions rule below) before
   creating a new folder with the exact name given. If an existing folder
   is clearly the *same* category under an old name — most notably a
   pre-existing **Urgent** folder from before this skill renamed that
   category to **Needs Action** — rename that folder in place (Gmail
   `labels.update`, Outlook `PATCH .../mailFolders/{id}` with
   `displayName`) rather than creating a duplicate. Don't hand-move its
   messages into a freshly created folder just because the name changed.
4. **"Archiving" means moving it out of the scope folder into its category
   folder**, not leaving it where it was. Every message whose category
   differs from the scope folder leaves the scope folder — a message
   already sitting in the folder that matches its own category (e.g. a
   Promotions email found while scoped to Promotions) has nothing to fix
   and just stays. When the scope is the Inbox, "leaves the scope folder"
   means the same thing it always did: drop `INBOX`. On a labels-based
   provider (Gmail), adding the category label and removing the scope
   folder's label is **one operation, not two** — a message that ends up
   with a category label *and* still shows in the scope folder is a bug,
   not a partial success. Do it in a single `modify` call (see provider
   mechanics) rather than one call to add the label and a separate one to
   drop the old one.
5. **Never open a security/verification code email.** A subject like
   "Your verification code", "Security code", "One-time passcode", "OTP",
   "Verify your identity/email", or a 2FA/login-code notice must be
   classified from the **subject line alone** — fetch subject-only (never
   the body/snippet, never `format=full`) and file it straight to
   **Security Codes** without reading its content. These codes are
   time-sensitive and sensitive; there is no reason for you to ever see
   one. See the provider mechanics below for the subject-only calls.
6. **Always run this skill in a fresh session — never inline in an
   existing, possibly long-running conversation.** A chat session can stay
   open indefinitely (one continuous conversation per wiring), so anything
   you inferred about this skill's rules earlier in that conversation can
   silently go stale the moment this file is edited — you'd keep filing
   against rules that no longer exist, with no way to notice. If this
   skill is triggered from within an ongoing conversation (a wired
   channel, a DM), don't run the workflow inline. Instead, kick off a
   one-shot task and let it do the actual work in its own isolated
   session — that's what guarantees a fresh read of this file every time:

   ```bash
   ncl tasks create --name "organize inbox" --process-after "now" \
     --prompt "Run the email-organizer skill against the Inbox for [EMAIL ADDRESS]. When done, send_message the result back to [DESTINATION NAME]."
   ```

   Reply in the current conversation that you've kicked it off; the actual
   report arrives via `send_message` from the task once it finishes. If
   `--process-after "now"` is rejected, use the current timestamp instead.
   The one case that's already safe to run inline is a task prompt itself
   (task runs already get their own isolated session — see the scheduling
   module — so there's nothing to delegate further).
7. **Classify from headers + snippet only — never a full message body.**
   Every fetch used for classification (not just the rule-5 security-code
   check) stays at `format=metadata` with `metadataHeaders=Subject,From`
   (Gmail) or `$select=subject,from,bodyPreview` (Outlook). The
   snippet/`bodyPreview` that comes back with that call is enough to
   resolve every content-based split in this table — Netflix vs. its own
   marketing, SoFi banking vs. investing vs. marketing, an Airbnb/Vrbo
   booking vs. its promo mail, Insurance vs. a Promotions upsell, and so
   on. Fetching a full raw body (`format=full`, or Outlook's default full
   `body` field) to settle a classification call is a context mistake, not
   just a privacy one: a single marketing HTML body can run tens of
   kilobytes, and this skill runs the whole scope folder — often hundreds
   of messages — in one continuous session that never gets to reset
   mid-run. If a snippet genuinely isn't enough to tell two categories
   apart, treat the message as uncategorized (workflow step 7) rather than
   opening it to decide.

## Folder taxonomy

Apply these in order — a message matches the first rule it fits.

| Category | Folder | Goes here |
|---|---|---|
| Security codes | **Security Codes** | Verification/security codes, OTPs, 2FA and login-confirmation emails — identified by subject alone (rule 5). Checked before every other category and before you fetch any body content, since it changes *how* you're allowed to read the message, not just where it ends up. |
| Account administration | **Accounts** | Google Account administration/security email — new sign-in alerts, security checkups, storage warnings, Google One, account-settings changes — plus other account-administration mail that isn't tied to a category of its own, including Social Security Administration (SSA) correspondence and Outlier AI account/platform email (Outlier AI is a data-labeling/gig platform — not insurance, despite the name; see the Insurance exclusion below). Not Google Calendar (goes to Notifications/Calendar, below) and not a Google verification code (already pulled off by rule 5). Meant to generalize across providers, not just Google. |
| GitHub | **GitHub** | Any email from GitHub — notifications, security alerts, PR/issue activity, billing, everything. Checked before Subscriptions/Finances/Promotions below so a GitHub billing or Copilot-renewal email doesn't get pulled into those instead: sender wins here, no content nuance needed. |
| Projects | **Projects** | Any email from ClickUp — task assignments, comments, due-date reminders, digests, billing, everything. Same sender-wins logic as GitHub above. |
| Medical | **Medical** | Healthcare-related email — appointment confirmations/reminders, patient-portal messages from a doctor's office or hospital, lab/test result notices, prescription/pharmacy notices. |
| Jobs | **Jobs** | Anything job- or career-related, full stop: recruiter outreach, application confirmations/receipts, interview requests, rejections, offers, LinkedIn/Indeed search-criteria digests, "recruiters are viewing your profile" notices, and career-advice/tips content (interview prep, resume advice, "pass the frontend interview"-style course marketing) even when it's really a newsletter or promo. This includes every Indeed and LinkedIn email — file them straight into Jobs, never directly into a Job Applications or Job Search sub-folder from this skill; those sub-folders only get created and filled by the separate `jobs-organizer` skill, chained automatically once this run finishes (workflow step 9). Don't try to sort out real applications from generic tips here either — same deferral. At this stage the only question is "is this about jobs/careers at all?" |
| Work | **Work** | Work-related email that isn't itself a job application — payroll notifications, HR/benefits communications, employer-sent updates and announcements. |
| Finances | **Finances** | Bank and credit card statements, alerts, and notices — including retirement and investment accounts, and NerdWallet email (goes to the Finances root, not a sub-folder). Also SoFi email that's real account/banking activity (statements, transfers, balance alerts) — but see the SoFi split below for its marketing side. A separate `finance-organizer` skill splits Retirement and Investments out into their own sub-folders, chained automatically once this run finishes (workflow step 9); this skill just gets everything financial out of the Inbox and into Finances. |
| Welding | **Welding** | Email from aws.org (the American Welding Society) — membership, certification, and related notices. Not Amazon Web Services, which is a different `aws.amazon.com`/`amazon.com` domain and isn't covered by this rule. |
| Purchases | **Purchases** | Purchase receipts and order/shipping updates — including a purchase made through a social platform's built-in shop (e.g. a TikTok Shop order confirmation), recurring Autoship/subscribe-and-save orders (e.g. Chewy Autoship), and Airbnb/Vrbo booking email (confirmation, itinerary, check-in details) for an upcoming or current stay — see the Needs Action exception below, these also get copied there. A recurring order confirmation is still a purchase receipt, not a Subscriptions-folder item and not a Pet-Services-folder item just because it's pet food or supplies. Source platform doesn't matter; a receipt is a receipt. Mark as read when filed here. |
| Subscriptions | **Subscriptions** | Subscription confirmations, renewals, and changes — including Netflix billing/plan-change email. Does not include insurance (below), and does not include a subscription service's marketing content (see the Netflix split below). |
| Insurance | **Insurance** | Only email from a **current** policy: statements, renewal notices, claims correspondence, premium/billing notices. Kept separate from Subscriptions even though it's also a recurring charge. Does **not** include marketing — a quote offer, a "switch and save" pitch, or an upsell for a policy you don't already have (even from your existing insurer) goes to Promotions instead, not here. Does **not** include Outlier AI — that's a data-labeling/gig platform, not insurance, and goes to Accounts (above) instead. Does **not** include SoFi Invest/stock or portfolio content either, even if it uses words like "protect" or "portfolio protection" — that's investing activity, not insurance; see the SoFi split below. SoFi only belongs here for an actual SoFi Protect insurance-policy email (a real policy sold through SoFi's insurance marketplace), which is rare — when in doubt, it's Finances, not Insurance. |
| Pet services | **Pet Services** | Business email for the dog-services business — Sniffspot always (booking confirmations, host messages, receipts, reviews), and Rover **only when someone booked a service from us** (a client boarding/walking/sitting with our business) — plus any other email about *providing* a dog service yourself (boarding, sitting, daycare, walking inquiries or bookings where you're the provider, not the customer). A Rover email where *we're* the customer instead goes to **Puppers**, below — see the Rover split, content must be examined, sender alone isn't enough. A separate `pet-services-organizer` skill splits this folder into per-platform sub-folders (Rover, Sniffspot), chained automatically once this run finishes (workflow step 9). |
| Personal dog content | **Puppers** | Dog-related email that isn't part of the dog-services business — a Rover booking *we* made for one of our own dogs (see the Rover split below) — plus any other dog-related email that doesn't already fit a more specific row above (a dog-food/supplies purchase receipt still goes to Purchases, a dog's vet visit still goes to Medical, and so on; those more specific rows win first). One flat folder, not split further. |
| Social platforms | **Socials** | Notifications, activity digests, friend/follow requests, and account emails from social platforms (Facebook, Twitter/X, Instagram, TikTok, Nextdoor, etc.) — the platform doing social-network things, not selling you something. Mark as read when filed here. |
| Calendar invites | **Notifications/Calendar** | Calendar invitations and meeting invites (`.ics` attachments, "invitation:"/accepted-declined-tentative notices) from any calendar system, plus Google Calendar event reminders and updates. A sub-folder of Notifications, not a sibling. |
| Automated notifications | **Notifications** | Automated notices that aren't really about anything actionable and don't fit a category above — Jeep Connect vehicle alerts, USPS Informed Delivery daily mail-preview emails, and similar (calendar-related mail goes to Notifications/Calendar above instead). If it's a routine automated FYI with nowhere else to go, it goes here rather than becoming an uncategorized suggestion. |
| Personal contacts | **Contacts** | Email from a sender address that's in the connected mailbox's own contacts/address book (see provider mechanics for how to check) — a personal note, family/friend correspondence, any person-to-person email — **but only once nothing above already claimed it.** A contact emailing about work, a job referral, a purchase, a payment, etc. still goes to that specific folder instead; being a known contact never overrides a more specific category earlier in this table. |
| Promotions / marketing | **Promotions** | Promotional and marketing email, including marketing sent by a social platform (e.g. a TikTok Shop promo blast), insurance quotes/upsells/"switch and save" pitches (even from your current insurer — see the Insurance exclusion above), Netflix's own marketing content (new releases, "shows for you" — see the Netflix split below), and SoFi marketing (product pitches, refer-a-friend, rate-change ads not tied to your actual account — see the SoFi split below) — but *not* job/career-related marketing (career-tips newsletters, "pass the interview" course pitches), which goes to Jobs above regardless of how promotional it reads. Use an existing "Marketing" folder if that's what's already there instead of creating a duplicate. Mark as read when filed here. |

### Netflix and SoFi: each a sender with two possible folders

Both send genuinely different kinds of email depending on content — classify
by what the email *is*, not just who sent it:

- **Netflix**: a billing receipt, plan/price change, or renewal notice →
  **Subscriptions**. "New this week," "shows we think you'll love," and
  similar content marketing → **Promotions**.
- **SoFi**: a statement, transfer confirmation, balance alert, or other real
  banking account activity → **Finances**. A SoFi Invest stock/ETF trade
  confirmation, portfolio-value update, or other investing activity →
  **Finances** as well (a later `finance-organizer` pass sorts it into the
  Investments sub-folder — SoFi Invest is investing, not insurance, even
  when the email talks about "protecting" your portfolio). A product pitch,
  refer-a-friend email, or rate/offer advertisement not tied to something
  that actually happened on your account → **Promotions**. The one
  genuinely-Insurance case is an actual SoFi Protect policy email (SoFi's
  separate insurance marketplace) — see the Insurance exclusion above;
  don't default to Insurance just because the sender is SoFi.

### One sender, three possible folders

A social platform can send three completely different kinds of email —
classify by what the email *is*, not who sent it:

- A friend request, comment/like notification, or "someone tagged you" →
  **Socials**.
- An order confirmation from the platform's shop (TikTok Shop, Facebook
  Marketplace, etc.) → **Purchases**.
- A marketing/promo blast from the platform → **Promotions**.

### Rover: one sender, two possible folders

Rover mail means one of two very different things depending on who booked
whom, and the sender alone can't tell you which — unlike Sniffspot, a Rover
email needs its content examined before filing:

- Someone booked **us** through Rover — a client's booking for
  boarding/walking/sitting with our business → **Pet Services** (the
  `pet-services-organizer` chain moves it into the Rover sub-folder from
  there).
- **We** booked a Rover service for one of our own dogs — we're the
  customer, not the business → **Puppers**.

This is resolvable from subject/snippet alone (rule 7) — a booking
confirmation addressed to us as the service provider (a new booking
request, a client's info, a payout notice) reads differently from one
confirming a walker/sitter we hired for our own dog. If a snippet genuinely
doesn't make it clear which side we're on, treat it as uncategorized
(workflow step 7) rather than guessing. Sniffspot isn't part of this split
— every Sniffspot email keeps filing to Pet Services by sender alone, same
as before.

### Needs Action — the one exception to "move"

Anything needing an immediate response — a late payment notice, a declined
or invalid payment method, insufficient funds, an account/service
suspension warning, or a license/certification/registration expiration
notice — gets **copied** into a **Needs Action** folder and **marked
important**, in addition to whatever the table above says. The original
still goes to its normal category folder (e.g. a failed-payment notice from
a card issuer lands in both Finances *and* a copy in Needs Action; a
driver's-license renewal notice lands in Accounts *and* a copy in Needs
Action). Needs Action is additive, never a substitute for the category
rule.

Needs Action is for a **problem that requires you to act to fix
something** — not just anything time-sensitive or upcoming. A routine
service reminder (e.g. a Rover or Sniffspot notice that a guest/booking is
arriving soon, a calendar reminder, a delivery-arriving-today notice) is
time-sensitive but isn't a problem to resolve — it stays only in its normal
category folder (Pet Services, Notifications/Calendar, Purchases, etc.),
no Needs Action copy. When in doubt, ask: "is there something broken here
that needs fixing, or is this just telling me something is about to
happen?" Only the former is Needs Action.

**Deliberate exception:** an Airbnb or Vrbo email about an upcoming or
current booking (confirmation, check-in/itinerary details, house-rules or
access-code info, trip reminder) always gets copied into Needs Action too,
alongside its normal Purchases filing — even though it isn't a "problem"
by the test above. This is an explicit user policy, not a precedent for
generalizing to other travel or reservation platforms without being told
to.

### Anything else

For a message that doesn't fit any rule above and isn't urgent: don't
invent a folder silently. Propose one to the user (an existing folder if a
reasonable one exists, otherwise a new folder name) and wait for their call
before filing it. If it's urgent-but-otherwise-uncategorized, still copy it
to Needs Action + mark important immediately — urgency doesn't wait on a
suggestion.

## Workflow

0. Check rule 6: if you're running inline in an existing conversation
   rather than inside a task's own isolated session, delegate to a
   one-shot task now and stop here for this turn — everything below is
   what the task does, not what you do inline.
1. Resolve and confirm the target email address (rule 0). Don't proceed
   without it.
2. Resolve the scope (rule 2): the Inbox unless the request named a
   specific folder/label, in which case that's it.
3. List what's currently in the scope folder, **subject + sender only**
   (never fetch full bodies for the whole folder in one shot — see rule 7).
   Pull out every message whose subject matches rule 5 and file it
   straight to Security Codes now, unopened. It never gets classified any
   further. If the scope folder has over 100 messages, switch to bulk mode
   (below) for the rest of the workflow.
4. For everything else, classify it against the taxonomy above using
   subject/sender/snippet only (rule 7) — never a full body. Before
   classifying, fetch the connected mailbox's contacts/address book once
   (see provider mechanics) and build a set of known contact addresses —
   you need that set to catch the Contacts row, and fetching it once up
   front is far cheaper than a lookup per message. Skip this fetch
   entirely if the scope folder has fewer than 5 messages left to classify
   once Security Codes has been pulled off — a directory fetch that can
   run to hundreds of KB isn't worth it to check a handful of messages.
5. Look up existing folders/labels first; create the ones you need that
   don't already exist.
6. File the message: move it into its category folder, removing it from
   the scope folder (rule 4) — unless its category already *is* the scope
   folder, in which case leave it. If it's urgent, also copy it into
   Needs Action and mark it important. If it's going to Promotions, Socials, or
   Purchases, also mark it read — see the provider mechanics below for
   exactly how "copy", "important", and "mark as read" map onto the
   connected service.
7. For anything uncategorized, hold it (leave it in the scope folder) and
   collect it into a suggestion instead of guessing.
8. Report back: which address and which folder you acted on, **the total
   number of messages moved out of the scope folder**, the per-folder
   breakdown behind that total, any new folders created, anything flagged
   Needs Action, and your suggestions for the uncategorized leftovers.
9. **Chain to the sub-organizers for whichever of Jobs, Finances, and Pet
   Services you actually filed something into this run.** This skill only
   ever files the parent folder (rule per the Jobs/Finances/Pet services
   taxonomy rows above) — splitting those into their sub-folders is each
   sub-skill's own job, and it doesn't happen unless something kicks it
   off. For each of the three that received at least one message this run,
   run (don't skip this just because you're already inside this run's own
   isolated session — each sub-skill's fresh-session rule is about *its*
   file staying current, which this session can't satisfy on its behalf):

   ```bash
   ncl tasks create --name "organize jobs" --process-after "<current UTC timestamp>" \
     --prompt "Run the jobs-organizer skill against Jobs for [EMAIL ADDRESS]. When done, send_message the result back to [DESTINATION NAME]."
   ncl tasks create --name "organize finances" --process-after "<current UTC timestamp>" \
     --prompt "Run the finance-organizer skill against Finances for [EMAIL ADDRESS]. When done, send_message the result back to [DESTINATION NAME]."
   ncl tasks create --name "organize pet services" --process-after "<current UTC timestamp>" \
     --prompt "Run the pet-services-organizer skill against Pet Services for [EMAIL ADDRESS]. When done, send_message the result back to [DESTINATION NAME]."
   ```

   Skip whichever of the three got nothing filed into it this run — no
   point spinning up a task with nothing new to sort. `--process-after
   "now"` is rejected by this CLI; use the real current UTC timestamp
   (`date -u +"%Y-%m-%dT%H:%M:%SZ"`) instead, same as rule 6.

## Keeping this run inside its context budget

This whole skill runs as **one continuous session** (rule 6) with no
mid-run reset, so what you choose to put in front of yourself matters even
below the bulk-mode threshold. A single scope-folder run that dumps its
own working data into the conversation can force this session to
compact mid-task — burning tokens on a summary, and then burning more
when you have to re-invoke this skill via the `Skill` tool to get its
rules back in view. Avoid both:

- **Never print a full per-message listing (sender/subject for the whole
  scope folder) into the conversation.** Redirect it to a scratch file
  under `/workspace/agent/` instead, and work against that file with
  `grep`/`awk`/`jq` — only pull a specific row, a count, or a small sample
  back into your own context. A 500-row TSV of every message in the
  folder printed to stdout is exactly the kind of thing that forces a
  mid-run compaction.
- **Resolve every sender-identifiable category with a search, not a
  listing — regardless of folder size.** Most of the taxonomy above is
  mechanical: GitHub, ClickUp, aws.org, LinkedIn/Indeed, a known Insurance
  policy sender, and so on can all be matched by sender/domain with a
  provider search and filed straight from the search's id list, without
  ever needing the message's content in your context. Don't wait for the
  100-message bulk-mode threshold to do this — do it first, always, then
  only fall back to fetching subject/sender/snippet (rule 7) for whatever
  is left over. The leftover pool after the mechanical pass is usually far
  smaller than the whole folder, which is what actually keeps a large
  folder's classification pass cheap — the 100-message threshold below
  only decides how the *content-nuanced* remainder gets filed, not whether
  you look at everything up front.
- **Load this skill's instructions once per run.** They stay valid for the
  rest of this session (that's what rule 6's fresh session buys you) —
  don't re-invoke the `Skill` tool mid-run "just to double check," and if
  a mid-run compaction already happened, one re-read to reorient is
  enough; don't make it a habit inside the same run.
- Clean up any scratch files you wrote under `/workspace/agent/` once the
  run's report is ready — they're working state for this run, not durable
  records.

## Bulk mode for large folders

**If the scope folder has over 100 messages, use bulk mode instead of the
default one-message-at-a-time workflow for whatever's left after the
mechanical sender pass above:**

- Classify with provider search queries (subject/sender keyword searches
  scoped to the folder) instead of fetching each message's subject
  individually.
- File matches with one batch call per category instead of one API call
  per message — Gmail `users.messages.batchModify` (up to 1000 message ids
  per call), Outlook `$batch` (up to 20 requests per call). See the batch
  examples in provider mechanics below.
- Security Codes (rule 5) still gets checked first, and still only via a
  subject-scoped search — bulk mode never opens a body to classify
  anything, same as the normal workflow.
- Contacts still needs the address-book fetch up front (step 4) — it's one
  call regardless of folder size, not a per-message lookup, so it isn't
  part of what bulk mode is optimizing away. Build a `from:(a@x.com OR
  b@x.com OR ...)` search from that address list to find matches scoped to
  the folder, same batching approach as any other category.
- **Promotions, Socials, and Purchases still have to be marked read when
  batch-filed — bulk mode doesn't drop this requirement.** Gmail: the
  `batchModify` call for these three categories must include `"UNREAD"` in
  `removeLabelIds` alongside the scope folder, same as the per-message
  case. Outlook: a `move` alone doesn't touch `isRead`, so these three
  categories need a second batched PATCH (`isRead: true`) per message id —
  see the read-marking batch example below. Every other category's batch
  call stays file-only, no read-marking needed.
- Whatever a category's searches don't catch becomes the
  uncategorized-leftovers list from step 7 — don't try to hand-classify a
  five-figure tail one message at a time just because bulk mode missed it.
- Rover is the one sender-identifiable category that still isn't a pure
  sender match (see the Rover split above): run two subject-keyword
  searches scoped to the sender — one for booking-request/client/payout
  language (files to Pet Services) and one for booking-confirmation/hired-a-
  sitter language (files to Puppers) — instead of one blanket search. Only
  Sniffspot gets the simple sender-only search-and-batch-file treatment.

## Provider mechanics

Requests go through the OneCLI gateway (see the `onecli-gateway` skill) —
call the real API URL directly, never handle a raw credential. The calls
below use `INBOX` / the Inbox folder as the worked example, since that's
the default scope — when scoped to a named folder instead (rule 2),
substitute that folder's label id / folder id everywhere `INBOX` appears,
both for listing and for the "remove" side of each file/modify call.

**Gmail** — folders are labels; a message can carry several at once.

```bash
# Contacts, once per run (Contacts-row check) — People API, not Gmail's own API
curl -s "https://people.googleapis.com/v1/people/me/connections?personFields=emailAddresses&pageSize=1000"
# Existing labels
curl -s "https://gmail.googleapis.com/gmail/v1/users/me/labels"
# Create one that's missing
curl -s -X POST "https://gmail.googleapis.com/gmail/v1/users/me/labels" \
  -H "Content-Type: application/json" \
  -d '{"name":"Jobs","labelListVisibility":"labelShow","messageListVisibility":"messageShow"}'
# List what's in the Inbox
curl -s "https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX"
# Subject only, for the security-codes pre-pass (rule 5) — never format=full for this check
curl -s "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=metadata&metadataHeaders=Subject"
# Subject + From, for general classification (rule 7) — format=metadata already
# includes the snippet field for free; still never format=full
curl -s "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From"
# File a message: add its category label, drop INBOX — this is Gmail's own "archive"
curl -s -X POST "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}/modify" \
  -H "Content-Type: application/json" \
  -d '{"addLabelIds":["<categoryLabelId>"],"removeLabelIds":["INBOX"]}'
# Needs Action: keep the category label, ALSO add Needs Action + IMPORTANT (don't remove INBOX if you haven't filed it yet — add it alongside the category label above)
curl -s -X POST "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}/modify" \
  -H "Content-Type: application/json" \
  -d '{"addLabelIds":["<needsActionLabelId>","IMPORTANT"],"removeLabelIds":["INBOX"]}'
# Promotions / Socials / Purchases: file AND mark read in the same call — drop UNREAD alongside INBOX
curl -s -X POST "https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}/modify" \
  -H "Content-Type: application/json" \
  -d '{"addLabelIds":["<categoryLabelId>"],"removeLabelIds":["INBOX","UNREAD"]}'
```

**Microsoft Graph / Outlook** — real folders; a message lives in exactly
one, so "copy" is a real second message.

```bash
# Contacts, once per run (Contacts-row check)
curl -s "https://graph.microsoft.com/v1.0/me/contacts?\$select=emailAddresses&\$top=1000"
# Existing folders
curl -s "https://graph.microsoft.com/v1.0/me/mailFolders"
# Create one that's missing
curl -s -X POST "https://graph.microsoft.com/v1.0/me/mailFolders" \
  -H "Content-Type: application/json" -d '{"displayName":"Jobs"}'
# List what's in the Inbox
curl -s "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages"
# Subject only, for the security-codes pre-pass (rule 5) — $select excludes the body
curl -s "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?\$select=subject"
# Subject + sender + preview, for general classification (rule 7) — bodyPreview is
# a short plain-text snippet, not the full body; still never omit $select and pull the default full body
curl -s "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?\$select=subject,from,bodyPreview"
# File a message: move (this removes it from the Inbox as part of the move)
curl -s -X POST "https://graph.microsoft.com/v1.0/me/messages/{id}/move" \
  -H "Content-Type: application/json" -d '{"destinationId":"<categoryFolderId>"}'
# Promotions / Socials / Purchases: move, then mark read
curl -s -X PATCH "https://graph.microsoft.com/v1.0/me/messages/{id}" \
  -H "Content-Type: application/json" -d '{"isRead":true}'
# Needs Action: copy (leaves the original where it was filed) + flag importance
curl -s -X POST "https://graph.microsoft.com/v1.0/me/messages/{id}/copy" \
  -H "Content-Type: application/json" -d '{"destinationId":"<needsActionFolderId>"}'
curl -s -X PATCH "https://graph.microsoft.com/v1.0/me/messages/{id}" \
  -H "Content-Type: application/json" -d '{"importance":"high","flag":{"flagStatus":"flagged"}}'
```

**Bulk mode calls** — search-based classification and batch filing, per the
bulk mode section above:

```bash
# Gmail: search scoped to the folder instead of fetching each subject
curl -s "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in:inbox+subject:(receipt+OR+order+OR+shipped)"
# Batch-file every id that search returned, one call for the whole category
curl -s -X POST "https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify" \
  -H "Content-Type: application/json" \
  -d '{"ids":["id1","id2","..."],"addLabelIds":["<categoryLabelId>"],"removeLabelIds":["INBOX"]}'

# Microsoft Graph: search scoped to the folder
curl -s "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?\$search=\"receipt OR order OR shipped\"&\$select=id,subject"
# $batch: one HTTP call carrying up to 20 individual move requests
curl -s -X POST "https://graph.microsoft.com/v1.0/\$batch" \
  -H "Content-Type: application/json" \
  -d '{"requests":[{"id":"1","method":"POST","url":"/me/messages/{id}/move","body":{"destinationId":"<categoryFolderId>"},"headers":{"Content-Type":"application/json"}}]}'

# Promotions / Socials / Purchases in bulk mode — batch-file AND batch-mark-read, don't skip the second part:
# Gmail: one batchModify call does both (drop UNREAD alongside INBOX)
curl -s -X POST "https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify" \
  -H "Content-Type: application/json" \
  -d '{"ids":["id1","id2","..."],"addLabelIds":["<categoryLabelId>"],"removeLabelIds":["INBOX","UNREAD"]}'
# Outlook: move doesn't set isRead, so pair each move with an isRead PATCH in the same $batch call
curl -s -X POST "https://graph.microsoft.com/v1.0/\$batch" \
  -H "Content-Type: application/json" \
  -d '{"requests":[
        {"id":"1","method":"POST","url":"/me/messages/{id}/move","body":{"destinationId":"<categoryFolderId>"},"headers":{"Content-Type":"application/json"}},
        {"id":"2","method":"PATCH","url":"/me/messages/{id}","body":{"isRead":true},"headers":{"Content-Type":"application/json"}}
      ]}'
```

If a request 401s/403s with `app_not_connected`, that mailbox isn't
authorized in OneCLI yet — follow the onecli-gateway skill's connect-link
flow, don't try to work around it.

## Running it regularly

This is a natural recurring task. Once it's working well interactively,
offer to schedule it:

```bash
ncl tasks create \
  --name "inbox organize" \
  --recurrence "0 7 * * *" \
  --prompt "Run the email-organizer skill against the Inbox for [EMAIL ADDRESS]. Report back only if something is Needs Action or you have suggestions waiting; otherwise a one-line summary is enough."
```

Naming the address in the task prompt itself is what satisfies rule 0 for a
scheduled run — there's no user to ask at 7am. Step 9's sub-organizer
chaining still applies on a scheduled run exactly as it does interactively
— don't drop it just because no one's watching.

## Notes

- **Notifications/Calendar** nests the same way the other multi-level
  categories do — Gmail: create the label with the full path
  `"Notifications/Calendar"` directly, no need to create the parent first.
  Outlook: create it as a child folder of the Notifications folder's own
  id, not top-level (same pattern as `finance-organizer`'s
  Retirement/Investments split, just handled directly here instead of by a
  separate sub-skill).
- Don't change the folder taxonomy or the never-delete rule without the
  user asking — this is a deliberate policy, not something to improvise.
- If the connected mailbox already has folders that don't map cleanly onto
  this taxonomy (e.g. a pre-existing "Bills" folder that overlaps with
  Finances), ask the user which one to use rather than creating a
  near-duplicate.
