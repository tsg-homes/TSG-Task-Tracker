# TSG Task Tracker

Apps Script backend + dashboard for The Stawasz Group's internal task tracker. This repo is
the local, git-backed home for the project so it can be developed with Claude Code (or any
editor/terminal) instead of one-off file hand-offs through a Cowork chat.

Live web app: `https://script.google.com/macros/s/<web-app deployment id>/exec`. **This repo is
public, so the deployment id, the exec URL and the API token are never committed** — the id
lives in `.tracker-ids.json` (gitignored; recover it with `clasp deployments`, the entry that is
not `@HEAD`), and the exec URL + token are injected into the dashboard by `doGet` at serve time.
GitHub repo: `https://github.com/tsg-homes/task-tracker.git`

## Files

- `Code.gs` — the Apps Script backend: the `doGet`/`doPost` API, the `_Inbox` merge-on-read
  patch pipeline, the estimator/scheduler, and the Drive-doc / Calendar-meeting auto-link
  matchers.
- `dashboard_final.html` — the single-file dashboard (HTML/CSS/JS) served by `doGet`. Since
  2026-09-14 it is a file inside the Apps Script project (pushed by `clasp` alongside
  `Code.gs`), so one `npm run deploy` ships backend and dashboard together.
- `test/test_codegs.js` — Node `vm`-based unit tests for `Code.gs`. Loads the file into a
  sandboxed context with stubbed Apps Script globals (`DriveApp`, `CalendarApp`, `Utilities`,
  `PropertiesService`, etc.) and a controllable fake Claude responder, so `applyDataPatch` and
  friends can be exercised without touching the live Drive/Calendar/Anthropic API.
- `person.html` — the per-person view served to signed-in roster members (see CLAUDE.md,
  "Per-person view"). A Board-style page: reads a server-computed slice and writes
  single-item operations; progress is derived from the notes by the estimator, and tasks
  created there are enriched and scheduled like any other. The owner opens any member's
  view from the dashboard's "Views" buttons (or `?person=<Name>`).
- `test/test_person.js` — jsdom smoke test for the per-person view.
- `test/test_dashboard.js` — a jsdom smoke test for the dashboard: loads the real HTML into a
  DOM, mocks `fetch`, and exercises rendering, the task modal, and the meeting picker.

Run both with:

```
npm install
npm test
```

(`npm install` only pulls in `jsdom`, needed for the dashboard test — `test_codegs.js` has no
dependencies beyond Node's built-ins.)

## Deploying

`npm run deploy` pushes `Code.gs`, `appsscript.json` and `dashboard_final.html` to the live
Apps Script project and republishes the existing web-app deployment (same exec URL). That is
the whole deploy: there is no separate dashboard step any more. The historical
`?target=html` write path is retired and now returns an error; the old Drive copy of the
dashboard is no longer what `doGet` serves.

`clasp` (Google's official Apps Script CLI) is what makes this possible from any machine,
including a Claude Code cloud session: `clasp push` uploads the files, `clasp deploy -i
<deploymentId>` republishes the *existing* deployment instead of minting a new one.

### One-time setup (run these yourself — they need your own Google OAuth login, which
### shouldn't be driven by an agent on your behalf)

```
npm install -g @anthropic-ai/claude-code
npm install -g @google/clasp
clasp login
```

Then link this folder to the live Apps Script project. You'll need the project's **Script
ID** (Apps Script editor → Project Settings → "Script ID") — it isn't recorded anywhere in
this repo or in chat, so grab it from the editor once:

```
cd path/to/tsg-task-tracker
clasp clone <SCRIPT_ID>
```

`clasp clone` will pull down whatever's currently live, including `appsscript.json` (the
manifest — now committed here so `clasp push` works from a fresh clone) and its own
`.clasp.json` (gitignored here on purpose — it's environment-specific, not a secret, but
there's no reason to commit it). `.claspignore` limits what `clasp push` uploads to `Code.gs`,
`appsscript.json` and `dashboard_final.html` — `test/`, `scripts/` and the docs must never be
pushed into the script project. After cloning, this repo's files are the versions to keep —
overwrite the cloned copies with them, then:

```
clasp push
clasp deployments        # find the existing web-app deployment's ID
clasp deploy -i <deploymentId>
```

From then on, `npm run push` / `npm run deploy` do the same thing. `npm run deploy` runs
`scripts/deploy.js`, which reads the web-app deployment id from `.tracker-ids.json` and
republishes that deployment — a bare `clasp deploy` would mint a brand-new deployment with a
different URL. The other deployment listed by `clasp deployments` is the `@HEAD` dev
deployment; leave it alone.

Linked and pushed for the first time on 2026-09-14 (this repo's `Code.gs` was a strict
superset of what was live — it added the Drive/Calendar auto-link matchers). Note that the
cloud session's outbound proxy blocks `script.google.com`, so an exec-URL smoke test has to
run from a local machine or a browser; `clasp` itself is unaffected.

**Version indicator.** `Code.gs` carries `TSG_CODE_VERSION` and `dashboard_final.html`
carries `UI_VERSION` (both `YYYY-MM-DD.n`). Bump the one you changed, every time. The
dashboard footer shows `API <code version> · UI <ui version>`, and `<exec URL>?api=version`
returns the live backend version as JSON with no token — that is how you tell whether a
deploy actually landed.

**Until you've actually run a `clasp deploy` and confirmed the live tracker picked up a
change, don't treat this as working** — same rule this project has always followed for
`Code.gs` changes: a delivered-but-unconfirmed change is not a live change.

## Running this in the cloud (Claude Code on the web / Desktop's Code tab, Environment: Cloud)

The GitHub repo for this project already exists: **https://github.com/tsg-homes/task-tracker.git**
(confirmed empty — no commits yet, so this is a clean first push, no merge to worry about).

A cloud Claude Code session runs in an Anthropic-managed VM and needs GitHub to get the code
in and push work back out — it can't see this local folder directly. One-time setup, all of
it your own authenticated steps (an agent shouldn't drive GitHub/OAuth logins on your behalf):

1. **Push this folder to it**, from a terminal opened in this folder:
   ```
   git init                     # harmless if .git already exists
   git add -A
   git commit -m "Initial commit: TSG Task Tracker"
   git branch -M main
   git remote add origin https://github.com/tsg-homes/task-tracker.git
   git push -u origin main
   ```
2. **Connect Claude Code to GitHub** — either:
   - Install the Claude GitHub App on the repo during web onboarding at
     [claude.ai/code](https://claude.ai/code), or
   - Run `/web-setup` inside any local Claude Code session (sends your local `gh` CLI token to
     your Claude account — needs `gh auth login` done first if you haven't).
3. **Start the cloud session**: in Claude Desktop's **Code** tab → **+ New session** →
   **Environment: Cloud** → pick the `tsg-homes/task-tracker` repo. Or from a terminal:
   `claude --cloud "<task>"`. Or from [claude.ai/code](https://claude.ai/code) directly.

After that, `clasp push`/`clasp deploy` (see **Deploying** above) work the same way from
inside a cloud session as they do locally — `clasp login` just needs to happen once per
environment, so a fresh cloud session will ask for it again the first time.

## Access model and automation (2026-09-14)

The web app is deployed **domain-restricted**: only signed-in TSG Workspace accounts
(thestawaszgroup.com / tsg.homes, one organization) can reach the exec URL. The owner gets
the full dashboard; any other TSG account gets a per-person page. Consequences for
automation (Claude sessions, scripts):

- **Reads**: read the INDEX first, `Systems — Task Tracker Index — TSG.json`
  (`1F4Lgzuq3KsawqUNGqrQBds4Mxu95yaxC`, in the tracker folder `1PEyP4X_k1TxOfqZeGSbHyyaM8K64GwQ-`): every
  open task's id, title, status, group, owner, delegate, due, tags and ALL its steps by index
  and title, Done tasks as id + title, the value lists and the deployed backend version, well
  under 50 KB. Fetch the full `Systems — Task Tracker Data — TSG.json`
  (`1SRdNiNhHdAfaB-agj9OcXRIPA5xNLidt`) only when notes, history, docs or judgments are
  needed, and `Systems — Task Tracker Rulesets.json` (`1RKkNUEfh6Q0qlQXbNlME7aIfh_h8FE-R`)
  for rulesets. `?api=data` / `?api=rulesets` are for the signed-in dashboard only.
- **Writes**: unchanged — drop a patch file into `_Inbox` (`1-xBA0xRiqAcJ8btUAPUOouwNGKXY2_Pi`).
  A one-minute time-driven trigger (`tsgInboxTick`) applies it; nothing needs to poke
  `?api=sync` any more. Verify by re-reading the Drive file after a minute.
- **No curl to the exec URL from anything that isn't a browser session.** It will get a
  Google sign-in page, not JSON.

Switching the access mode: change `TSG_ACCESS_MODE` in `Code.gs` AND `webapp.access` in
`appsscript.json` together (`npm test` fails if they disagree), deploy, then run
`tsgInstallInboxTrigger` once from the Apps Script editor to authorize the new scopes and
install the trigger.

## Dependencies and due dates always align (2026-09-18)

On every write the backend (`tsgAlignDependencies_`) pushes a dependent task forward so it starts on
the next workday after every task it depends on ends (a predecessor's At Risk `realisticEnd` counts).
The move shifts the due date, the scheduled span and every open step together, lands them on
workdays, and logs `due` with source `Dependency`. A hand-set date (`dueOverride`) is never moved: the
task is tagged `At Risk` with `realisticEnd` = the date it would need, cleared once it fits. Only numeric task ids in `depends` (comma list)
take part; prose in that field is ignored, so a patch that wants a real dependency must write the id
(or `dependsOnTitle` in an enrich answer, which the server resolves to the id).

## External sessions read the index (2026-09-22)

The data file passed 685 KB, which the Drive connector returns base64-encoded: far past what
a session can hold, and in-page fetches of the Drive download URL are blocked, so a session
that needed a task id had no way to get one. One thing ships for that; two were weighed
and rejected.

- **Index file** (`tsgWriteIndex_`, after every applied data write in `processInbox_`): the
  file named above, rebuilt from the document just written. Downsides: one extra Drive write
  per applied patch (about a second of trigger time); it lags the data file by exactly that
  write, so a session that just uploaded a patch sees the pre-patch index until the trigger
  runs (same as the data file today); and it carries no notes or history, so a session that
  must read the current note text still needs the big file (read one task's slice with `jq`
  from the base64 decode rather than the whole thing).
- **Rejected: patching by title.** Built and removed the same day (Durand: "dont like patch by
  title, doesn't each task have a unique ID?"). Every task has a stable numeric id; the index file
  carries it, and the dashboard now shows it in front of every title, so a session or a person
  always has the id at hand. Titles move (the enricher polishes them, Durand edits them), so a
  title match would either refuse or, worse, hit the wrong task.
- **Rejected: trimming history harder.** History is already capped and archived (2026-09-18);
  the hot file's bulk is notes and pending judgments, and no trim gets 685 KB under a session's
  budget. It would lose audit trail for no read benefit.

## Judgment queue (2026-09-16): Claude answers without an API key

The script has no `ANTHROPIC_API_KEY`. Instead of calling the API, every judgment it would
have asked for is queued in the data file at `meta.judgments` (server-owned; `replace_all`
and `set_meta` cannot write it). A scheduled Claude Code Routine ("TSG Tracker — judgment
queue", hourly on weekdays) reads the data file, answers each request under its own
judgment, and writes the answers back as inbox ops. Until an answer lands a new task carries
`needs-estimate` + `Triage` and the usual fallback note, so a gap is visible, never silent.

**Request shapes** (`meta.judgments[]`, each with `id` like `J17`, `ts`, `kind`, `taskId`):

- `kind: "enrich"` — a new task, a task or SUBTASK whose notes changed (`subIdx` + `subTitle`
  set for a subtask; its `current.subtask` is true and it never asks for `group`,
  `dependsOnTitle` or `subitems`), or a Tidy re-run (`force: true`). Polish the notes FIRST
  and derive every other field from the polished text. Fields: `need` (subset of `title`, `notes`, `estHours`, `taskType`, `subitems`, `priority`,
  `group`, `dependsOnTitle`, `tags`, `progress`, `location`, `due`, `driveMatch`,
  `meetingMatch`, `mailMatch`, `webLinks`, `steps`), `title`, `notes` (free-flow text as typed), `priority`, `current` (the
  task's current fields: return them unchanged unless the title/notes clearly justify a
  change), `batchSiblings`, `driveCandidates` (`[{url, label, excerpt}]` or null),
  `calendarCandidates` (`[{date, start, end, htmlLink, label}]` or null), `mailCandidates`
  (`[{url, label, from, date, excerpt}]` recent Gmail threads, or null), `currentSteps` (the task's open
  steps `[{index, title, notes, estHours, taskType, priority, progress, location, due, delegate}]`
  when `need` has `steps`; a request with `need: ["steps"]` alone is a steps-only re-judge), `personCreated`.
  Candidates are gathered on EVERY pass, whatever is already linked (2026-09-17), and every
  request is slimmed to caps when queued and again on every write (2026-09-18, backend
  2026-09-18.14): 6 Drive candidates with 240-char excerpts, 4 Gmail threads with 160-char
  excerpts, 10 calendar events, and calendar candidates only for a Meeting or a TASK whose type
  is still open (a step never carries them). The queue holds 80 requests. A `bulk` that touched
  several steps of one task queues ONE steps-only request for that parent (`need: ["steps"]`,
  `currentSteps` = those steps) instead of one full request per step; when the parent already
  has a pending request the steps are merged into it. Link matching for those steps rides the
  parent's next pass. The notes as typed are never cut.
  Read `EXISTING_GROUPS` / `OPEN_TASK_TITLES` / `EXISTING_TAGS` from the data file itself.
- `kind: "progress"` — legacy; answer `{progress}` from the notes only.
- `kind: "comment"` (2026-09-18) — one of Durand's comments (`commentId`, `text`, `anchor`,
  `taskId` = the anchored task, or the pinned feature task, or 0; `featureStep` true when the
  comment was also added as a step on that task). Do what it asks when it is tracker work
  (update ops in the same bulk patch), then answer `{"reply": "<what you did or why not>",
  "resolved": true}`; the server posts the reply as a Claude comment on the same anchor and
  resolves the original. `resolved: false` keeps it open with the reply. A comment resolved by
  hand drops its request. A comment on the page itself (anchor kind element / tile / group)
  is a tracker feature request: `add_comment` also appends it as a Claude-delegated step on
  the pinned feature task (`meta.featureTaskId`, else the pinned Claude task whose title
  mentions the Task Tracker and feature/bug/request), stamped `commentId`.

**Answer op** (one per request, in a `bulk` data patch dropped into `_Inbox`):

```json
{"target":"data","op":"bulk","source":"Claude (queue)","ops":[
  {"op":"judgment","id":"J17","answer":{"title":"Send Farina the listing agreement for signature",
   "notes":"Current state: … Next: … Blocked on: …","estHours":0.5,"taskType":"Email",
   "subitems":[{"title":"Chase the signed copy","estHours":0.25,"taskType":"Email","priority":"High"}],
   "steps":[{"index":0,"title":"Draft the agreement","notes":"Current state: drafted.","estHours":0.5,"taskType":"Hands-on","priority":"High","tags":[],"progress":100,"location":null,"due":null}],
   "priority":"High","group":"Ops","dependsOnTitle":null,"tags":["Listings"],
   "progress":25,"location":"Farina Di Vita, Media PA","due":"2026-09-19","needsConfirmation":false,
   "driveMatch":{"index":1,"confident":true,"rationale":"…"},"meetingMatch":null,
   "mailMatch":{"index":2,"confident":true,"rationale":"…"},
   "webLinks":[{"url":"https://www.usps.com/business/web-tools-apis/address-information-api.htm","label":"USPS Address API"}],"rationale":"…"}},
  {"op":"judgment","id":"J18","answer":{"progress":60}}
]}
```

DATES ARE AMERICA/NEW_YORK: the tracker runs in the script's time zone, and a cloud session's clock
is UTC, so "today" after 8 PM Eastern is already tomorrow in UTC. Compute TODAY and every `due` in
America/New_York, and never propose a due date on a day whose workday (ends 4:30 PM) is over; the
server pushes such a date to the next workday and notes it (2026-09-17).

Rules are the estimator's own (`TSG_ESTIMATE_SYSTEM` in `Code.gs`): only fields in `need`;
`title` one imperative line, max 80 chars, derived from a free-flow note when the title is a
placeholder; `notes` rewritten as ONE compact "Current state" note (next action, blockers, the facts still needed, verbatim; NO running log: every previous version of a note is archived in full to the History folder, 2026-09-22);
hours are hands-on time from the calibration table; `taskType` one of Email | Call |
Text/Chat | Meeting | Claude | Hands-on; `priority` one of Critical | High | Medium |
Low; `group` an existing group unless nothing fits; `dependsOnTitle` an exact open title or
null; 0-3 topical tags, never a system tag; `progress` 0-100 from evidence in the notes;
`location` a stated place or null; `due` a stated deadline as YYYY-MM-DD or null; `subitems` NEW steps only,
each `{title, estHours, taskType, priority}` (a bare string still works); `steps` one entry per index in
`currentSteps`, each judged like the task's own fields for that step (a step with nothing to change echoes
its current values; never drop, reorder or invent an index);
`driveMatch` / `meetingMatch` / `mailMatch` `{index (1-based into the stored candidates), confident,
rationale}` or null; `webLinks` up to 3 `{url, label}` for the named tool / service / vendor /
form page / reference the task explicitly involves (official pages only, real URLs — RUN A WEB
SEARCH to confirm each one; never a Drive, Gmail or Calendar link, never a search-results page)
or null, the usual answer. `answer: null` drops a request; an unknown id is ignored.

**What the server does with an answer** (`tsgApplyEstimateToTask_`, tasks and subtasks
alike): the notes polish lands first, then the title, then a stated `location` / `due`
(updated on every pass unless Durand set them by hand; never cleared), then the fields; a
field Durand set by hand (a history line with a person's source) is kept unless the request
was a Tidy re-run; title / notes / progress are skipped when Durand edited them after the
request was queued, and the notes polish is skipped when the notes moved on; new steps are
appended to a task, existing ones kept, a subtask never mints steps; tags merge; a confident
Drive / calendar / Gmail match and every returned web link is added on every pass unless that
url is already on the item (Gmail as type `email`, sites as type `web`);
every change gets its own history line with the answer's source. Verify by re-reading the data
file after a minute: the answered ids are gone from `meta.judgments`.

## Instruction layers and mirror Docs (2026-09-22)

Per Durand: "the general set of instructions should be a generalized merge of all rules to be
applied everywhere; the code instructions should be Claude Code specific rules that sit on top of
the general instructions; each thread should push to its own instruction set, a set of
thread/project specific instructions that sit on top of the general ones (and code ones for code
threads)". The Rulesets file holds three layers and the tracker mirrors each to a Google Doc:

- `current.General` — applies everywhere (the former Cowork block is merged into it; `Cowork` is retired).
- `current.Code` — Claude Code rules on top of General.
- `threads[name]` — that thread's `instructions` + `memories`, on top of General (+ Code when the
  thread has `code: true`; toggle "Code thread" in Settings > Threads or the `set_thread_code` op).

Mirror: after every rulesets write `tsgMirrorInstructions_` rewrites one Doc per set in the
`Instructions` folder under the tracker folder, COMPOSED so a session reads ONE Doc:
"Systems — Instructions — General" (General), "… — Code" (General + Code), "… — Thread — <name>"
(General [+ Code] + thread + memories). Ids, urls and content hashes live in `meta.mirrorDocs`
(server-owned); an unchanged set is not rewritten, a Doc keeps its id, a removed thread's record
is dropped (its Doc stays for Durand to trash). The legacy 'Systems — Cowork Instructions' Doc
is reused as the General mirror. `tsgMirrorInstructionsNow()` (editor, owner only) repairs or
first-fires the mirror; the rulesets op `mirror_instructions` does the same through the inbox.
Settings > Rulesets / Threads show each set's "Mirror Doc" link.

Only the latest instructions live in the hot file (Durand 2026-09-22: "history logged separately,
same as notes"): after every rulesets write `tsgArchiveRulesetsHistory_` keeps the newest 3
changelog lines per category and per thread and moves the rest to
`History/rulesets-history-<ISO>.json` (counts in rulesets `meta.historyArchive`).

Rulesets ops added: `set_category` now creates a missing category, `remove_category {category}`,
`set_thread_code {name, code}`, `mirror_instructions {}`.

THREAD IDS (2026-09-23, per Durand: "threads identify themselves by an ID generated on creation
that never changes, so there are no title-change errors"). `threads` stays keyed by name, but every
thread object carries an immutable `id` ('T' + zero-padded number: T001, T002 ...) allocated from
the server-owned counter `meta.next_thread_id`. Never derived from the count, never reused (a removed
thread's number is gone), never set by a patch or a Settings save: `add_thread` ignores a supplied
id, `replace_all` restores the server's id for a thread of the same name and drops any other, and a
client copy cannot touch the counter (`tsgEnsureThreadIds_`, idempotent, also the one-time backfill
that ran on the first rulesets write after deploy in first-history-ts order, then by name). Every
thread op (`update_thread_instructions`, `add_thread_memory`, `remove_thread_memory`, `remove_thread`,
`set_thread_code`) takes `id` or `name` (`tsgResolveThread_`: id wins, a disagreeing pair is refused
by name). New op `rename_thread {id, newName}` moves the object to the new key keeping id,
instructions, memories, code and history and logs "Renamed from <old> to <new>." (Settings > Threads
has a Rename button that uses it; a renamed key is never saved through replace_all). Mirror Docs are
keyed `thread:<id>` in `meta.mirrorDocs` and titled `Systems — Instructions — Thread — <id> — <name>`
with the id in the body header, so a rename retitles the SAME Doc; the name-keyed records were
migrated in place (same Doc ids, no new Docs). Settings > Threads shows the id ("id pending" on a
thread added there until the save lands). Sessions: read your id from the Doc title and send it on
every op; a thread with no Doc yet does not exist (`add_thread`, then the id is in the title a minute
later).

WHAT A SESSION DOES: read its layer's Doc (the thread Doc when it has a thread, else the Code
Doc in a code session, else General) at start; push its own durable rules and memories to ITS
thread only (`update_thread_instructions`, `add_thread_memory`); never edit General or Code from
a thread (Durand edits those in Settings or asks for a patch); the app-side "Instructions for
Claude" field in Cowork / a project's CLAUDE.md carries a one-line pointer to the Doc, not a copy.

Replacement text for the Cowork `tsg-thread-sync` skill (Durand applies it in Cowork): "Push this
thread's instructions and critical memories to ITS OWN thread entry in the tracker's Rulesets
(`update_thread_instructions` / `add_thread_memory` patches into `_Inbox`), never to General or
Code. The tracker mirrors the composed set (General, Code when the thread is a code thread, then
this thread) to the Google Doc 'Systems — Instructions — Thread — <name>' within a minute; read
that Doc, not the Rulesets file. Mark a thread as a code thread with `set_thread_code`."

## The Routine's prompt lives in the repo (2026-09-18)

`routines/judgment-routine-prompt.md` is the full prompt for the "Task Tracker Judgement
Call" Routine: judgment queue, comments, the work delegated to Claude (outward-facing
actions drafted only, never sent), and the inbox and meeting-notes scan that replaced the
Google Tasks import (state in `meta.scanned_email_thread_ids` / `scanned_drive_file_ids` /
the two scan watermarks, written with `set_meta`; new work as `add_task` ops). Agents cannot edit the Routine, so Durand pastes the block
from that file; edit the file first. It reads the data file from Drive by id and never
carries the exec URL or the API token. The dashboard's "Judge now" prompt carries the same
three steps in short form, and both it and "Send open comments" open the working session
set under Settings > General (prompt copied, session opened) when one is set.

## Reordering steps (2026-09-18)

`reorder_subitems {id, by: "due"}` sorts a task's steps by due date (stable, undated last);
`{id, order: [old indices]}` applies an explicit permutation. Nothing on the steps changes and
the parent logs `subitems-reordered`. Use it instead of an `update_task` carrying the whole
`subitems` array, which resends every step's history and is easy to corrupt.

## Git mirrors what is live (2026-09-17)

`npm run deploy` refuses a dirty tree (uncommitted changes in the four pushed files) unless
`--allow-dirty` is passed, and after a successful deploy moves the tag `live` to HEAD and
fast-forwards `main` to it. So `main` and `git show live:Code.gs` are always the deployed script;
feature work stays on the session branch until it ships.

## Inbox trace (2026-09-18): a dropped patch is never silent

`processInbox_` used to rename a failing patch `FAILED-` and then trash it, so from a session's
side it was "consumed with nothing recorded". Now:

- A patch that throws is rolled back (JSON snapshot, in-place restore) and its file stays in
  `_Inbox` renamed `FAILED-<name>`; a file that is not JSON stays as `MALFORMED-<name>`. Prefixed
  files are never re-read; Durand trashes them once read.
- `bulk` applies sub-op by sub-op: a sub-op that throws is rolled back on its own and the rest
  still apply. If at least one applied, the file stays as `PARTIAL-<name>`; if none did, `FAILED-`.
- Every failure is recorded in the data file at `meta.inboxErrors[]` (server-owned, last 30):
  `{ts, file, target, op, error, appliedSubOps?, failedSubOps?: [{index, op, id, error}]}`; a
  malformed file's `error` carries the parse position and the 60 characters around it, plus
  `bytes`. The dashboard raises a CRITICAL alert naming the newest file when anything was dropped
  entirely (FAILED-/MALFORMED-), a warn alert for PARTIAL- only, and lists them in Settings >
  General, and raises one toast per new entry when the page loads (UI 2026-09-18.17). No email:
  per Durand (2026-09-18) a filed patch is logged and notified in the tracker only.
- An envelope with `ops` but no `op` is applied as a `bulk` (2026-09-18). Everything else about
  the envelope is unchanged; a file that is not valid JSON is still MALFORMED-, so serialize
  with a real JSON encoder and parse the exact text before uploading it.
- `meta.backendVersion` is stamped on every write. A session MUST read it before sending an op
  the deployed backend may not have yet (e.g. `log_time` needs `>= 2026-09-17.7`); an unknown op's
  error names the accepted ops (`TSG_DATA_OPS`).
- Verify a write by re-reading the data file: the change is there, or the file name in `_Inbox`
  and `meta.inboxErrors` say why not. Nothing else counts as evidence.

## History retention (2026-09-18): the hot file stays small

**2026-09-22 (Durand: "the tracker only needs the latest polished note, the rest can go to the
history"):** the hot-file caps are now 12 lines per open task, 4 per Done task, 4 per step (was
40 / 12 / 12; history was 51% of a 697 KB file). A notes history line whose text would be cut
to 240 characters first stashes the FULL previous and new note in `meta.noteVersions`
(server-owned), and the archive pass writes those to the same dated History file
(`noteVersions[]`) on the same write, even when no line is over its cap. So the complete text
of every note version lives in the History folder; the hot file keeps the short line flagged
`fullInArchive`. The enricher now writes a note as one compact current state with no running
log. Existing notes that carry a Log are rewritten the next time they change, not all at once.

Measured 2026-09-18 on the live data file (930 KB): 1,328 history lines held 405 KB, notes lines
alone (the whole old and new notes text per line) 231 KB, and `meta.judgments` 284 KB; one 2 KB
bulk grew the file by 36 KB (17.5x). Now, on every write (`tsgAutoScheduleDoc_`):

- A history line's `from` / `to` string is cut at 240 characters (`TSG_HISTORY_VALUE_CHARS`).
  Nothing reads old notes text back out of `history[]`; the notes live on the item.
- Pending judgment requests are slimmed to the caps above (`tsgCompactJudgments_`).

And before every data write from `processInbox_` (`tsgArchiveHistory_`): an item over its cap
(task 40 lines, Done task 12, step 12; `TSG_HISTORY_KEEP`) keeps `created`, the latest line per
field, the latest PERSON-sourced line per field (what hand-set protection reads) and the newest
24 / 8 / 8 lines; the rest are written to a dated file `history-<ISO>.json` in the tracker
folder's `History` subfolder (`{archivedAt, backendVersion, lines, items: [{taskId, subIdx,
title, lines}]}`) and only then removed. A failed archive write prunes nothing.
`meta.historyArchive` counts files and lines. Replayed offline against the live file, the first
write after deploy shrinks it by ~328 KB and a 2.3 KB bulk touching four steps then costs 3.7 KB
(1.6x).

## Comments are the Durand-to-Claude channel (2026-09-17)

`meta.comments` holds notes Durand anchors to a task, step, group or tile from the dashboard's
Comment mode. Every session that touches the tracker (the judgment Routine, a Judge-now session,
any Cowork/Code session on a task) reads the UNRESOLVED comments not authored by Claude, does what
they ask when it is tracker work (field changes ride in the same bulk patch), replies with
`add_comment` (`author: "Claude"`, `replyTo: <id>`, same anchor) saying what was done or why not,
and resolves with `update_comment {id, fields: {resolved: true}}` only when done. A Claude-authored
comment (e.g. an estimate settlement) is Durand's to resolve after reading.

## Delegate visibility, pending approval, activity, feedback (2026-09-23)

Per Durand: a delegate sees a task only when he has switched it on, can never close work
himself, every change he makes is logged and surfaced, and his feedback collects on one
pinned task per person.

- **Visibility switch** `delegateVisible` (task field, default off). `tsgPersonSlice_` shows a
  task the person does not own only while it is `true`. The dashboard chip (row Delegate cell,
  cards, the card's Delegate row) toggles it; the Views pop-up applies it. Only the owner can
  turn it on: `update_task` / `add_task` from any other source have `delegateVisible: true`
  stripped (`tsgStripVisibilityFromFields_`). Any automation write (a judgment answer, a session
  patch, the routine: anything whose `source` is not a person) that changes the task's meaningful
  content turns it off again (`tsgSnapshotVisibility_` before the op, `tsgResetVisibilityOnChange_`
  after; hash over title, notes, priority, type, hours, delegate, location, due, due time, links
  and every step's title/notes/delegate/hours/due/location/links). Status, progress, tags and
  schedule bookkeeping are not meaningful. The person's own edits and the owner's dashboard saves
  never turn it off. A task the person owns (self-created) is always theirs to see. Downside to
  know: the switch is off on every existing delegated task at deploy, so every delegate page is
  empty until Durand turns tasks on one by one.
- **Pending approval**: the person page offers `TSG_PERSON_STATUSES` (`Not Started`, `In Progress`,
  `Blocked`, `Waiting`, `Done - Pending`), never `Done`; a `Done` or `Cancelled` from a delegate
  lands as `Done - Pending` with progress 100 (the owner previewing with `?person=` may still
  close). A pending item is out of the scheduler, the reminder tick and the open-hours roll-up.
  The dashboard shows Approve (status `Done`, history `approval` "Verified and approved by Durand")
  and Send back (status `In Progress`, `RETURNED <date> by Durand: <note>` at the top of the notes)
  on rows, steps and the card, plus a critical alert row. `meta.status_values` carries the value.
- **Activity log** `meta.delegateActivity[]` (server-owned, cap 200): every delegate write records
  `{ts, person, taskId, subIdx, title, kind: update|pending|add|feedback, field, from, to}` (values
  cut at 240 chars). Dashboard: warn alert row with per-person counts, the activity panel (Open /
  Approve / Mark all seen -> `set_meta {delegateActivitySeen}`), toasts for entries new to this
  browser (`localStorage tsgSeenDelegateActivityTs`) and a native notification when the frame's
  origin is allowed. `meta.delegateEmails === 'on'` (Settings > General) also mails each entry to
  the owner; default off.
- **Feedback**: one pinned task per delegate with `feedbackFor: <Name>` (created 2026-09-23 for
  the nine roster members, group `Team Feedback`, tag `Feedback` (reserved), linked to the
  delegate how-to Doc, never enriched, aging- and stale-exempt). The person page's Feedback button
  calls `tsgPersonRpc('feedback', {kind: Bug | Feature request | Feedback, text})`, which files an
  `add_subitem` on that task: title `[Kind] first line`, notes = the text, delegate = the person,
  `feedback: {kind, by, ts}`, `skipEnrich`, never held for review. The person sees the item with
  its state (sent / accepted / declined / implemented) and can only edit its notes. On the
  dashboard each item shows Implement (a Claude step lands on the tracker feature task with
  `feedbackRef {taskId, index, title}`; the item goes `In Progress` with `ACCEPTED <date>` on top)
  or Decline (`Cancelled`, `DECLINED <date> by Durand: <reason>` on top); an accepted item closes
  itself when its linked step is Done (`tsgSyncFeedbackImplementations_`, every write). The
  feedback panel (alert row, Settings > General) lists them all.
- For sessions: never send `delegateVisible: true`; expect any meaningful change you make to a
  visible task to hide it again (say so in the note if Durand should re-check it); never set
  `Done` on a delegate's item on their behalf unless Durand asked; `delegateActivity` is
  server-owned.

## Actual time (2026-09-17): one log, three ways in

Nothing measured actual time before this. Now every item (task or step) carries `timeLog[]`
entries `{ts, minutes, kind, source, note?, turns?, spanMin?}` and `actualHours` = the sum of
its own log in quarter hours (a parent's total for calibration adds its steps'). Kinds:

- `timer` — the card timer on the dashboard (Start / Stop on the Actual row; survives a reload;
  the toolbar chip shows it running).
- `manual` — the "How long did this take?" prompt that opens when an item is marked Done with
  nothing logged (prefilled with the estimate, Enter accepts, Skip costs nothing), "+ Log time"
  on the card, and the Evening Wrap-Up line "Log time on N tasks finished today".
- `session` — a Claude session's self-report, pushed as an inbox op at write-back time:

```json
{"target":"data","op":"log_time","id":123,"subIdx":null,"minutes":20,"kind":"session",
 "source":"Claude session","turns":6,"spanMin":95,"note":"drafted and sent the vendor reply","ts":"<ISO>"}
```

  `minutes` is DURAND'S ATTENTION on the task (his messages on it × the minutes-per-turn figure,
  default 5, unless he states his time), `turns` is how many messages he sent on it, `spanMin`
  the session's first-to-last wall-clock. Claude's own processing time is never logged as hours.
- `calendar` — `tsgAttributeCalendarHours` (editor-run) for booked work.

`tsgActualsByType_` turns done items with logged time into `ACTUALS_BY_TYPE` (n, median actual
hours, median actual/estimate ratio per task type, only types with 3+ samples). The estimator
prompt carries it whenever `estHours` is asked for, queued enrich requests carry it as `actuals`,
and the rule is: measured work beats the calibration table.

## Conventions carried over from prior work on this project

- All writes to the tracker's Data/Rulesets files go through the `_Inbox` patch-file
  mechanism (`DriveApp` `createFile`, merged on the next `doGet`/`doPost` hit) — never a
  direct overwrite of the live file. `doPost` does a blind full-document overwrite with no
  staleness check, so a direct write can silently clobber a newer one.
- Field values that can be inferred (priority, group, tags, taskType, docs, meeting links)
  are never defaulted silently — an inference that isn't confident gets a `Triage` tag and an
  explanatory note instead of being guessed at quietly.
- `subitem.depends` is an index into that task's own `subitems` array; top-level `task.depends`
  is a task id. Different address spaces — don't mix them up.
