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

- **Reads**: read the INDEX first, `Systems — Task Tracker Index — TSG.json` in the tracker
  folder (`1PEyP4X_k1TxOfqZeGSbHyyaM8K64GwQ-`; find it by name, or by id once known): every
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
   "notes":"Current state: …\n\nLog:\n- 2026-09-16: …","estHours":0.5,"taskType":"Email",
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
placeholder; `notes` rewritten as "Current state" + dated "Log" keeping every fact verbatim;
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
