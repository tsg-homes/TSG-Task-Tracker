---
name: tsg-task-tracker-protocol
description: "TSG Task Tracker write/estimation protocol. Trigger whenever writing to the Task Tracker's Data or Rulesets files — adding/updating/deleting a task or subitem, answering the judgment queue, pushing a ruleset patch, computing estHours/estDays for a tracker task, or closing out a Claude session that worked a tracker task (effort self-report) — not only when Durand names this skill. Covers the exact Inbox-patch envelope shapes (flat op vs. bulk) and the shape bug that silently drops malformed writes, the current op list (update_subitem, judgment, request_steps, log_time, comments), the ONE estimation workflow shared with the in-script estimator (measured reference class from the team's own actuals, then the calibration table, PERT only as a last resort — never a flat multiplier), Claude-typed tasks estimated in Durand's attention turns (never Claude wall-clock), the capacity-aware estDays rules, the field checklist (delegate not assignee, docs[] not doc), and the safety rules (never write directly to Data/Rulesets, never curl the exec URL, never assume a trashed inbox file means success, never fabricate an estimate)."
---

# TSG Task Tracker protocol (revised 2026-09-23: workstreams)

## Architecture

- Backend: Apps Script project "TSG Task Tracker API" (id `1YfbOa3_KqFuTrLBZNfjEPjDk0_TX25dMDUkmGMCquQejGEsft3dCoA6L`). Source of truth for the code: GitHub `tsg-homes/TSG-Task-Tracker` (`Code.gs`, `dashboard_final.html`, `person.html`); `README.md` there documents every op and the judgment-queue answer shapes and wins over this file when they disagree.
- Data lives in Drive JSON files: `Systems — Task Tracker Data — TSG.json` (`1SRdNiNhHdAfaB-agj9OcXRIPA5xNLidt`) and `Systems — Task Tracker Rulesets.json` (`1RKkNUEfh6Q0qlQXbNlME7aIfh_h8FE-R`), both in the Task Tracker folder (`1PEyP4X_k1TxOfqZeGSbHyyaM8K64GwQ-`).
- READ THE INDEX FIRST (2026-09-22): `Systems — Task Tracker Index — TSG.json` (`1F4Lgzuq3KsawqUNGqrQBds4Mxu95yaxC`, in the Task Tracker folder; rewritten by the backend after every applied write): every open task's `id`, `title`, `status`, `group`, `owner`, `delegate`, `due`, `tags`, `needsApproval` and all its `steps` (`i` = the index `update_subitem` needs, `title` = its `expectTitle`), Done tasks as id + title, `status_values`, `priority_values`, `taskTypes`, `groups`, `roster`, `backendVersion`, `docVersion`. It is a few tens of KB. The full Data file (685 KB+) is for notes, history, docs and `meta.judgments` only; when you need one task's notes, decode the base64 in a shell and pull that task with `jq`, never the whole file into context.
- Writes never touch those files. A JSON patch file goes into `_Inbox` (`1-xBA0xRiqAcJ8btUAPUOouwNGKXY2_Pi`) through the Drive connector's `create_file`; the installed 1-minute trigger (`tsgInboxTick`) applies every patch and trashes the file, success or failure. Nothing needs to hit the web app.
- ACCESS IS DOMAIN-RESTRICTED (since 2026-09-14): the exec URL answers only a signed-in TSG Google account. `curl`, `WebFetch` and any automation get a sign-in page. NEVER curl the exec URL, never use `?api=sync`, never drive the dashboard with a browser tool. Read state with `download_file_content` on the Data/Rulesets file ids; verify writes by re-reading a minute later.
- Every judgment (estimate, type, title/notes polish, links, progress, steps) that the script would ask Claude for is queued in `meta.judgments` because no API key is provisioned. The hourly Routine "TSG Tracker — judgment queue" answers them; the request and answer shapes are in README "Judgment queue". A session that finds pending requests on a task it is working may answer them in the same patch.

## Patch envelope — the shape bug that silently drops writes

`applyDataPatch_` reads `patch.op` off the TOP-LEVEL object. `{"target":"data","ops":[...]}` matches no op, throws inside the per-patch try/catch, is renamed `FAILED-` and dropped — the file disappearing is NOT evidence of success.

- Single op, flat: `{"target":"data","op":"update_task","id":11,"fields":{...},"source":"Claude","ts":"<ISO>"}`
- Several ops in one file: `{"target":"data","op":"bulk","source":"Claude","ops":[{"op":"update_task",...},{"op":"add_task",...}],"ts":"<ISO>"}` — sub-ops are flat objects with no `target`.
- Always carry `source` (your session's name, e.g. `"Claude (FUB workstream)"`): a history line without a person's source counts as automation and is overwritten by later enrichment; a line with a person's source is protected.

### Data ops (`target: "data"`)
- `add_task {task}` — fields below; `skipDedup`/`skipEnrich` only when told. A near-duplicate title is merged as a step of the existing task, not added.
- `update_task {id, fields}` — merged with `Object.assign`; cannot set `id`/`history`; `timelineEnd` also sets `dueOverride`; `assignee` is accepted and landed as `delegate`; `depends` lifts `dependsNone`.
- ONE BULK PER SESSION WRITE (2026-09-22): send every op of a working session as ONE `bulk` file, never one file per step or per task. Each notes change queues an enrich request; inside a bulk the requests for one parent's steps are coalesced into a single steps request, across separate files they are not (six per-step files on the FUB bonus task left six pending requests, 30 KB, on 2026-09-22). Split only when a file would pass ~30 KB, and then by parent task so its steps stay together.
- NOTES ARE ONE CURRENT-STATE NOTE (2026-09-22): write a task or step note as where things stand now, the next action, what it is blocked on and the facts needed to act; do not append dated log entries or keep superseded lines. Every previous version of a note is archived in full by the tracker (History folder, `noteVersions`), so nothing is lost by replacing it.
- IDS ONLY: every op that names a task needs its numeric `id` (from the index file; the dashboard shows it in front of every title as `#321`). There is no lookup by title.
- `reorder_subitems {id, by: "due"}` or `{id, order: [old indices]}` — reorder a task's steps without resending them (backend >= 2026-09-18.15); a stable sort by `timelineEnd` (undated last) or an explicit permutation; the steps are untouched and the parent logs `subitems-reordered`.
- `update_subitem {id, index, fields, expectTitle}` — one step by 0-based `index` (`subIdx` is accepted as an alias from backend 2026-09-18.8; before that only `index` worked and a `subIdx` patch was filed FAILED-); `expectTitle` guards against a moved index.
- `add_subitem {id, subitem}` — `{title, estHours, taskType, priority, delegate, notes}`; always enriched.
- `delete_task {id}`. `bulk {ops}` is applied sub-op by sub-op: a failing sub-op is rolled back alone, the rest land, the file is kept as `PARTIAL-`.
- `set_meta {fields}` — cannot write `next_id`, `docVersion`, `comments`, `judgments`, `judgmentSeq`.
- `add_comment {comment:{text, author:'Claude', replyTo?, anchor?}}`, `update_comment {id, fields | remove:true}` — reply to Durand's board comments (`meta.comments`).
- `judgment {id:'J17', answer:{...}}` — answer a queued request (shapes in README).
- `request_steps {id, indices?}` — steps-only re-judge of open steps with no hours. `request_tidy {id}` — full forced re-run.
- `log_time {id, subIdx?, minutes, kind, source, note?, turns?, spanMin?}` — effort capture; see "Session effort report".
- `replace_all` is the dashboard's own save; never send it from a session.

### Ruleset ops (`target: "rulesets"`)

ONE OP PER RULESET PATCH FILE (never a `bulk`; rulesets has no bulk op). Every workstream op
resolves its workstream by `id` first, then `name` (the old wording "key the thread by patch.name"
is stale): send `id` (preferred); `name` still works; when both are sent they must agree, and an
unknown id or name is refused by name.

- Categories (General and Code are Durand's; only when he asks): `append_category {category, text}`,
  `replace_category_text {category, find, replace}` (exact substring; throws if `find` is not present
  verbatim — byte-check against a fresh read first), `set_category {category, text}` (full overwrite,
  creates the category), `remove_category {category}`.
- Workstreams (formerly threads, renamed 2026-09-23): `add_workstream {name, instructions?, memories?}`
  (the server assigns the `id`; never send one), `update_workstream_instructions {id, instructions,
  historyEntry?}` (REPLACES the text), `add_workstream_memory {id, memory}`,
  `remove_workstream_memory {id, index}`, `remove_workstream {id}`, `rename_workstream {id, newName}`
  (keeps id, memories, code, sessions, history and the same Doc), `set_workstream_code {id, code}`,
  `set_workstream_links {id, projectUrl?, repo?, notes?}` (Claude Project URL `https://claude.ai/project/...`,
  repo `owner/repo`; an empty value clears that key), `record_session {id, sessionId, surface, title,
  startedAt}` (appends or updates by `sessionId`, lastSeen = patch `ts`; `surface` is one of `chat`,
  `cowork`, `code-local`, `code-cloud`, `scheduled`, `routine`; store the session ID only, e.g.
  `session_01...` or `cse_...`, never a link; 50 most recent kept per workstream, older ones archived).
- ALIASES: `add_thread`, `update_thread_instructions`, `add_thread_memory`, `remove_thread_memory`,
  `remove_thread`, `rename_thread`, `set_thread_code` still work and land exactly like the workstream
  ops (backend >= 2026-09-23.3). Write the workstream names.
- `mirror_instructions {}` forces a re-mirror of every Doc.

WORKSTREAM IDS: every workstream has an immutable server-assigned `id` (T002, T018 ...; read it from
its mirror Doc title "Systems — Instructions — Workstream — <id> — <name>"). Never expect an id to
change, never guess one, never rename by re-adding.

### Instruction layers (2026-09-22; workstreams 2026-09-23)

The Rulesets file holds `current.General` (everywhere), `current.Code` (Claude Code rules on top of
General) and `workstreams[name]` (a workstream's rules on top of those; `code: true` marks a code
workstream). Storage keys since backend 2026-09-23.3: `workstreams` (was `threads`),
`meta.next_workstream_id` (was `next_thread_id`), mirror records `workstream:<id>` (was `thread:<id>`);
the tracker migrates an old file on its first write. A session pushes ONLY to its own workstream
entry (`update_workstream_instructions`, `add_workstream_memory`, `remove_workstream_memory`,
`set_workstream_code`, `set_workstream_links`, `record_session`; tsg-workstream-sync covers the
instruction push, tsg-session-start the session record); General and Code are Durand's (Settings >
Rulesets, or `set_category` / `remove_category` when he asks). The tracker mirrors each set to a
Google Doc in the tracker folder's `Instructions` subfolder after every rulesets write ("Systems —
Instructions — General" / "— Code" / "— Workstream — <id> — <name>", composed so one Doc holds the
whole stack; links in `meta.mirrorDocs` and in Settings > Workstreams). Read the Doc, never the
Rulesets JSON.

## Steps for any write

1. Read the current state fresh: the index file for ids, titles, step indices and status values; `download_file_content` on the Data file only for notes/history/judgments (decode and `jq` one task). Never patch against remembered content.
2. Build the patch as a data structure and serialize it with a real JSON encoder (never paste notes into a hand-written JSON string: an unescaped quote filed the J49 answer as MALFORMED- on 2026-09-18); `json.loads` the exact text you will upload before uploading.
3. For `replace_category_text`, confirm `find in current_content` in Python first.
4. Upload with `create_file` (`textContent`, `contentMimeType: application/json`, `disableConversionToGoogleType: true`) into `_Inbox`.
5. Wait a minute, re-read, diff against the expected result before telling Durand it is done. If the change is missing, look in `_Inbox` for your file renamed `FAILED-` (rolled back), `PARTIAL-` (a bulk: the failing sub-ops rolled back, the rest applied) or `MALFORMED-` (not JSON), and read `meta.inboxErrors[]` in the data file for the exact error (it names the failing sub-op by index and lists the ops the deployed backend accepts; a malformed file's entry carries the parse position and the text around it). Every filed patch is raised as a critical dashboard alert plus a toast on load (no email, per Durand). A vanished file with the change present is success; anything else is not.
6. Keep patches lean: one write costs the data file roughly its own size again (history lines plus one queued judgment per touched item, coalesced per parent in a bulk); history over the per-item cap is archived to the `History` folder, never in the hot file, and a from/to value in a history line is cut at 240 chars, so never read old notes text back out of `history[]`.
7. BEFORE sending an op, check `meta.backendVersion` in the data file: it is the deployed backend, which can trail the repo. `log_time` needs `>= 2026-09-17.7`; `update_subitem`, `judgment`, `request_steps`, `request_tidy`, `add_comment` need `>= 2026-09-16.5`. An op the deployed backend lacks is rolled back and filed, never applied.
8. Multi-KB content (a restore, a large rewrite): never retype it through tool calls; SHA-256 it, deliver the file, have Durand upload it as a new version, verify by re-hashing.

## Field checklist

Tasks: `title` (one imperative line), `group`, `owner`, `delegate` (the person or `Claude` the task sits with — `assignee` is retired), `status` (`meta.status_values`), `priority` (`meta.priority_values`), `tags[]` (topical only — never `Triage`, `Review`, `Aging`, `Scheduling Stuck`, `Dependency Issue`, `needs-estimate`; the review gate adds `Triage` itself to anything automation points at a person), `timelineStart`, `timelineEnd`, `dueTime` (`HH:mm`, optional), `remindAt`, `progress`, `depends` (comma list of ids) or `dependsNone`, `docs[]` (the ONE links list: `{url, label, type}` with type `link | meeting | email | claude | web | image | file`; the legacy single `doc` is retired), `notes` ("Current state" + dated "Log", every fact kept), `subitems[]`, `estHours`, `estDays`, `estSource`, `taskType` (`Email | Call | Text/Chat | Meeting | Claude | Hands-on`), `location`, `pinned`.

Steps (`subitems[]`): `title`, `estHours`, `taskType` (judged on the step alone, never copied from the parent; Durand 2026-09-22), `priority`, `delegate`, `notes`, `docs[]`, `status`/`done`, `location`, `dueTime`, `remindAt`.

A typed task must carry a link of its kind (email → thread, meeting → event, Claude → the session, Text/Chat → the chat) — match an existing one or say in the notes that one must be created. Inferred values get a `BEST-GUESS <FIELD>` note line. Do not add the two pinned bonus tasks' fields by hand; never unpin or split them.

## Estimating `estHours` — one workflow, the same as the script's

The in-script estimator (`TSG_ESTIMATE_SYSTEM`) and every session use the SAME method; a session never invents its own. Hours are hands-on working time for the person doing it, never elapsed or waiting time.

1. **Measured reference class first.** Read the data file: done tasks with `actualHours` (from `timeLog`) of the same `taskType`. With 3 or more samples, anchor on their median actual hours for comparable work and scale the table row below by the median actual/estimate ratio (the script computes exactly this as `ACTUALS_BY_TYPE` and puts it in every enrich request as `actuals`). Log the reference tasks in `notes`. `estSource: "reference_class"`.
2. **Calibration table** (the script's own rows, from this team's completed work) when fewer than 3 measured samples exist:
   single call / text / short email 0.25–0.5 h · follow-up with one quiet person 0.5 h · review one document or listing draft 1–1.5 h · edit an existing checklist or SOP 2–3 h · design a new asset 3–4 h · a decision with tradeoffs and stakeholders 2.5–4 h · configure a system, per config area 4–8 h · data migration or rebuild across many records 6–16 h · train a group incl. prep 6–12 h. Multiply for genuine repetition (12 agents is not 1 agent). Do not pad; most tasks are small. `estSource: "table"`.
3. **PERT** `(O + 4M + P) / 6` only when the work matches no row; log O/M/P in `notes`. `estSource: "pert"`.
4. Nothing defensible: `estSource: "none"`, `estHours` unset, never a made-up number.

**Claude-typed tasks** (work a Cowork / Claude Code session carries out): estimate DURAND'S ATTENTION, not the session's wall-clock: expected number of his turns × minutes per turn (`meta.capacity.minutesPerTurn`, default 5 until measured). A session running for two hours while he works elsewhere costs him the turns, not the two hours.

## Estimating `estDays` — capacity- and schedule-aware

Read the current figures from the Rulesets "Daily capacity & task scheduling rules" (and `meta.capacity` once Settings carries them); defaults: 6 usable hours a day (4 on Friday), minus that day's real calendar meetings (skip self-blocked Focus time; trips are zero days); per-task daily chunk Critical 4 h, High 3 h, Medium 2.5 h, Low 2 h, never more than the day has left; 3–5 tasks active per day; chunks on consecutive workdays, never weekends; hard-deadline work claims capacity first; a due date that cannot be met is flagged at-risk with the realistic date, never quietly forced. Delegated and Claude-delegated items are paced, not charged to Durand's day. `estDays = ceil(estHours / chunk)` placed across those days.

## Comments (added 2026-09-17)

`meta.comments` is Durand's channel to you. On every tracker write-back also read the unresolved comments not authored by Claude on the items you touched (all of them in a queue-answering session): do what they ask when it is tracker work, reply with `add_comment {comment: {text, author: "Claude", replyTo: <id>, anchor: <same anchor>}}`, and resolve with `update_comment {id, fields: {resolved: true}}` only once done. Never resolve a comment you did not act on.

## Handing work back to Durand (added 2026-09-22)

There is now a real hand-back signal. On every write the server tags an open item delegated to Claude with the reserved tag `Needs Durand` when its status is `Blocked` or `Waiting`, or its notes contain `DRAFT — AWAITING APPROVAL` or `NEEDS DURAND`; a step's flag is mirrored onto its parent. The dashboard shows a "Needs you" chip, an alert row and lists them under the Triage filter. So: when you leave a draft, write the marker line `DRAFT — AWAITING APPROVAL` at the top of the draft in the notes; when you are blocked on a decision, set `status: "Blocked"` (or `"Waiting"`) and say in the notes exactly what you need. Never set the tag yourself (reserved); the server clears it on the write where the status moves on and the marker is gone.

## Delegate visibility, pending approval and feedback (added 2026-09-23)

A task reaches a delegate's page only while `delegateVisible: true`, and only Durand can set that (the server strips `true` from every other source, so never send it). Any meaningful change a session makes to a visible task (title, notes, due, priority, type, hours, delegate, location, links, or any step's title/notes/delegate/hours/due) hides it again until Durand re-checks it; a status or tag change does not. When you change a delegated task on purpose, say in the note that Durand should turn visibility back on. Delegates can only reach `Done - Pending`; Durand approves to `Done`. Do not close a delegate's item for them unless Durand asked. `meta.delegateActivity` and `meta.status_values` are the server's; feedback items are steps with a `feedback` object on a task with `feedbackFor` and must not be enriched, retitled or closed by a session (Durand implements or declines them on the dashboard; an accepted one closes itself when the linked Claude step on the tracker feature task, `feedbackRef`, is Done).

## Session effort report (added 2026-09-17)

At every write-back for a tracker task the session worked on (progress, notes, Done), also push:

```json
{"op":"log_time","id":<task id>,"subIdx":null,"minutes":<Durand's attention minutes>,"kind":"session",
 "source":"Claude session (<workstream>)","turns":<his messages on this task>,"spanMin":<first-to-last wall-clock>,
 "note":"<one line on what was done>"}
```

`minutes` = his turns on this task × minutes per turn (default 5) unless he states his time. `turns` and `spanMin` are kept for calibration; Claude's processing time is never logged as hours. This is the only source that ties his effort to a task id, so never skip it.

## Safety rules — non-negotiable

- Never write directly to Data or Rulesets; only `_Inbox` patches. Never `replace_all` from a session.
- Never curl or fetch the exec URL; it is domain-restricted and returns a sign-in page.
- Never assume a trashed inbox file means success; re-read and diff.
- Never fabricate `estHours`/`estDays`; follow the one workflow above or leave `estSource: "none"`.
- Never set `Triage` or `Review` yourself, never unpin the bonus tasks, never write `assignee` or `doc`.
- FUB is TSG's main CRM (Durand, 2026-09-23); Lofty is phasing out and stays only as a backstop for anything missed in the transfer. Never describe FUB as pending or Lofty as the operating CRM, and never invent a go-live or Lofty shut-off date.
- Dates are America/New_York. A cloud session's clock is UTC, which is already "tomorrow" after 8 PM Eastern; compute TODAY and every `due` / `timelineEnd` in Eastern and never propose a due date on a day whose workday (ends 4:30 PM) is over. Stored `ts` values stay UTC ISO.
- Check any op or field you have not used before against `applyDataPatch_` in `Code.gs`; a wrong name fails silently.
