---
name: tsg-task-tracker-protocol
description: "TSG Task Tracker write/estimation protocol. Trigger whenever writing to the Task Tracker's Data or Rulesets files — adding/updating/deleting a task or subitem, answering the judgment queue, pushing a ruleset patch, computing estHours/estDays for a tracker task, or closing out a Claude session that worked a tracker task (effort self-report) — not only when Durand names this skill. Covers the exact Inbox-patch envelope shapes (flat op vs. bulk) and the shape bug that silently drops malformed writes, the current op list (update_subitem, judgment, request_steps, log_time, comments), the ONE estimation workflow shared with the in-script estimator (measured reference class from the team's own actuals, then the calibration table, PERT only as a last resort — never a flat multiplier), Claude-typed tasks estimated in Durand's attention turns (never Claude wall-clock), the capacity-aware estDays rules, the field checklist (delegate not assignee, docs[] not doc), and the safety rules (never write directly to Data/Rulesets, never curl the exec URL, never assume a trashed inbox file means success, never fabricate an estimate)."
---

# TSG Task Tracker protocol (revised 2026-09-17)

## Architecture

- Backend: Apps Script project "TSG Task Tracker API" (id `1YfbOa3_KqFuTrLBZNfjEPjDk0_TX25dMDUkmGMCquQejGEsft3dCoA6L`). Source of truth for the code: GitHub `tsg-homes/task-tracker` (`Code.gs`, `dashboard_final.html`, `person.html`); `README.md` there documents every op and the judgment-queue answer shapes and wins over this file when they disagree.
- Data lives in Drive JSON files: `Systems — Task Tracker Data — TSG.json` (`1SRdNiNhHdAfaB-agj9OcXRIPA5xNLidt`) and `Systems — Task Tracker Rulesets.json` (`1RKkNUEfh6Q0qlQXbNlME7aIfh_h8FE-R`), both in the Task Tracker folder (`1PEyP4X_k1TxOfqZeGSbHyyaM8K64GwQ-`).
- Writes never touch those files. A JSON patch file goes into `_Inbox` (`1-xBA0xRiqAcJ8btUAPUOouwNGKXY2_Pi`) through the Drive connector's `create_file`; the installed 1-minute trigger (`tsgInboxTick`) applies every patch and trashes the file, success or failure. Nothing needs to hit the web app.
- ACCESS IS DOMAIN-RESTRICTED (since 2026-09-14): the exec URL answers only a signed-in TSG Google account. `curl`, `WebFetch` and any automation get a sign-in page. NEVER curl the exec URL, never use `?api=sync`, never drive the dashboard with a browser tool. Read state with `download_file_content` on the Data/Rulesets file ids; verify writes by re-reading a minute later.
- Every judgment (estimate, type, title/notes polish, links, progress, steps) that the script would ask Claude for is queued in `meta.judgments` because no API key is provisioned. The hourly Routine "TSG Tracker — judgment queue" answers them; the request and answer shapes are in README "Judgment queue". A session that finds pending requests on a task it is working may answer them in the same patch.

## Patch envelope — the shape bug that silently drops writes

`applyDataPatch_` reads `patch.op` off the TOP-LEVEL object. `{"target":"data","ops":[...]}` matches no op, throws inside the per-patch try/catch, is renamed `FAILED-` and dropped — the file disappearing is NOT evidence of success.

- Single op, flat: `{"target":"data","op":"update_task","id":11,"fields":{...},"source":"Claude","ts":"<ISO>"}`
- Several ops in one file: `{"target":"data","op":"bulk","source":"Claude","ops":[{"op":"update_task",...},{"op":"add_task",...}],"ts":"<ISO>"}` — sub-ops are flat objects with no `target`.
- Always carry `source` (your session's name, e.g. `"Claude (FUB thread)"`): a history line without a person's source counts as automation and is overwritten by later enrichment; a line with a person's source is protected.

### Data ops (`target: "data"`)
- `add_task {task}` — fields below; `skipDedup`/`skipEnrich` only when told. A near-duplicate title is merged as a step of the existing task, not added.
- `update_task {id, fields}` — merged with `Object.assign`; cannot set `id`/`history`; `timelineEnd` also sets `dueOverride`; `assignee` is accepted and landed as `delegate`; `depends` lifts `dependsNone`.
- `update_subitem {id, subIdx, fields, expectTitle}` — one step; `expectTitle` guards against a moved index.
- `add_subitem {id, subitem}` — `{title, estHours, taskType, priority, delegate, notes}`; always enriched.
- `delete_task {id}`. `bulk {ops}` is applied sub-op by sub-op: a failing sub-op is rolled back alone, the rest land, the file is kept as `PARTIAL-`.
- `set_meta {fields}` — cannot write `next_id`, `docVersion`, `comments`, `judgments`, `judgmentSeq`.
- `add_comment {comment:{text, author:'Claude', replyTo?, anchor?}}`, `update_comment {id, fields | remove:true}` — reply to Durand's board comments (`meta.comments`).
- `judgment {id:'J17', answer:{...}}` — answer a queued request (shapes in README).
- `request_steps {id, indices?}` — steps-only re-judge of open steps with no hours. `request_tidy {id}` — full forced re-run.
- `log_time {id, subIdx?, minutes, kind, source, note?, turns?, spanMin?}` — effort capture; see "Session effort report".
- `replace_all` is the dashboard's own save; never send it from a session.

### Ruleset ops (`target: "rulesets"`)
`append_category`, `replace_category_text` (exact-substring find/replace; throws if `find` is not present verbatim — byte-check against a fresh read first), `set_category` (full overwrite; avoid), `add_thread`, `update_thread_instructions`, `add_thread_memory`. All three thread ops key the thread by `patch.name` (not `thread`); a wrong key fails silently.

## Steps for any write

1. Read the current state fresh (`download_file_content`). Never patch against remembered content.
2. Build the patch flat per the shapes above; `json.loads` it locally.
3. For `replace_category_text`, confirm `find in current_content` in Python first.
4. Upload with `create_file` (`textContent`, `contentMimeType: application/json`, `disableConversionToGoogleType: true`) into `_Inbox`.
5. Wait a minute, re-read, diff against the expected result before telling Durand it is done. If the change is missing, look in `_Inbox` for your file renamed `FAILED-` (rolled back), `PARTIAL-` (a bulk: the failing sub-ops rolled back, the rest applied) or `MALFORMED-` (not JSON), and read `meta.inboxErrors[]` in the data file for the exact error (it names the failing sub-op by index and lists the ops the deployed backend accepts). A vanished file with the change present is success; anything else is not.
6. BEFORE sending an op, check `meta.backendVersion` in the data file: it is the deployed backend, which can trail the repo. `log_time` needs `>= 2026-09-17.7`; `update_subitem`, `judgment`, `request_steps`, `request_tidy`, `add_comment` need `>= 2026-09-16.5`. An op the deployed backend lacks is rolled back and filed, never applied.
7. Multi-KB content (a restore, a large rewrite): never retype it through tool calls; SHA-256 it, deliver the file, have Durand upload it as a new version, verify by re-hashing.

## Field checklist

Tasks: `title` (one imperative line), `group`, `owner`, `delegate` (the person or `Claude` the task sits with — `assignee` is retired), `status` (`meta.status_values`), `priority` (`meta.priority_values`), `tags[]` (topical only — never `Triage`, `Review`, `Aging`, `Scheduling Stuck`, `Dependency Issue`, `needs-estimate`; the review gate adds `Triage` itself to anything automation points at a person), `timelineStart`, `timelineEnd`, `dueTime` (`HH:mm`, optional), `remindAt`, `progress`, `depends` (comma list of ids) or `dependsNone`, `docs[]` (the ONE links list: `{url, label, type}` with type `link | meeting | email | claude | web | image | file`; the legacy single `doc` is retired), `notes` ("Current state" + dated "Log", every fact kept), `subitems[]`, `estHours`, `estDays`, `estSource`, `taskType` (`Email | Call | Text/Chat | Meeting | Claude | Actionable Task`), `location`, `pinned`.

Steps (`subitems[]`): `title`, `estHours`, `taskType`, `priority`, `delegate`, `notes`, `docs[]`, `status`/`done`, `location`, `dueTime`, `remindAt`.

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

## Session effort report (added 2026-09-17)

At every write-back for a tracker task the session worked on (progress, notes, Done), also push:

```json
{"op":"log_time","id":<task id>,"subIdx":null,"minutes":<Durand's attention minutes>,"kind":"session",
 "source":"Claude session (<thread>)","turns":<his messages on this task>,"spanMin":<first-to-last wall-clock>,
 "note":"<one line on what was done>"}
```

`minutes` = his turns on this task × minutes per turn (default 5) unless he states his time. `turns` and `spanMin` are kept for calibration; Claude's processing time is never logged as hours. This is the only source that ties his effort to a task id, so never skip it.

## Safety rules — non-negotiable

- Never write directly to Data or Rulesets; only `_Inbox` patches. Never `replace_all` from a session.
- Never curl or fetch the exec URL; it is domain-restricted and returns a sign-in page.
- Never assume a trashed inbox file means success; re-read and diff.
- Never fabricate `estHours`/`estDays`; follow the one workflow above or leave `estSource: "none"`.
- Never set `Triage` or `Review` yourself, never unpin the bonus tasks, never write `assignee` or `doc`.
- Never state a FUB go-live date: it is PENDING until Durand sets one.
- Check any op or field you have not used before against `applyDataPatch_` in `Code.gs`; a wrong name fails silently.
