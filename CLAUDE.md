# TSG Task Tracker — standing facts for Claude Code sessions

Read README.md for the file map, test commands, and conventions. This file holds the
identifiers and environment facts that are otherwise only known from chat.

## Apps Script identifiers

- Script ID: `1YfbOa3_KqFuTrLBZNfjEPjDk0_TX25dMDUkmGMCquQejGEsft3dCoA6L` ("TSG Task Tracker API")
- Web-app deployment ID: NOT in this repo (it is the exec URL, and the repo is public).
  It is in `.tracker-ids.json` (gitignored) or from `clasp deployments` (the non-`@HEAD` one).
  Never write the deployment id, the exec URL, or the API token into any tracked file,
  commit message, or test fixture. `npm test` fails if one of those patterns shows up.
- Dev deployment: the `@HEAD` entry in `clasp deployments`; leave it alone.
- The dashboard's `API_URL` and `TSG_TOKEN` are placeholders (`__TSG_API_URL__`,
  `__TSG_TOKEN__`) that the bare `doGet` stamps at serve time from
  `ScriptApp.getService().getUrl()` and the `SCRIPT_TOKEN` script property.
- Drive folder holding the Data/Rulesets JSON, dashboard file, and script: `1PEyP4X_k1TxOfqZeGSbHyyaM8K64GwQ-`
- First clasp push and deploy from this repo: 2026-09-14 (version 33).

## Deploy rules

- Bump `TSG_CODE_VERSION` (Code.gs) on every backend deploy and `UI_VERSION`
  (dashboard_final.html) on every dashboard deploy, format `YYYY-MM-DD.n`. The footer shows
  both; `<exec URL>?api=version` returns the backend one. Tests assert the format.
- The dashboard (`dashboard_final.html`) is a file IN the script project since 2026-09-14
  and is pushed by `clasp` with `Code.gs`; `npm run deploy` ships both. There is no
  separate dashboard deploy step and no curl path. `?target=html` is retired (returns an
  error). The old Drive copy (`1gvrLx4RcVh3mrnVOeiD5ExSbK9mKUnkv`) is historical only.
  Never add a fetch-from-URL endpoint to Code.gs (denied 2026-09-14 as a remote-code-
  loading surface); it is also no longer needed.

- `npm run push` = `clasp push` (Code.gs, appsscript.json, dashboard_final.html; see .claspignore).
- `npm run deploy` = push + `clasp deploy -i <web-app deployment ID>`. Never run bare
  `clasp deploy`; it mints a new deployment with a new URL.
- Deploying changes live behavior for the team. Confirm with Durand before running it
  unless the task explicitly asks for a deploy.
- `.clasp.json` is gitignored. In a fresh clone, recreate it with
  `clasp clone <Script ID>` into a scratch folder and copy the `.clasp.json` over, or
  write it by hand with the Script ID above.

## Identity and access

- `TSG_ACCESS_MODE` in Code.gs MUST agree with `appsscript.json` webapp.access (a test
  enforces it). Live since 2026-09-14 version 45: `DOMAIN` ("Anyone within The Stawasz
  Group", confirmed in Manage deployments). Every request carries the signed-in TSG
  account: `tsgIsOwnerEmail_` gets the full dashboard, every other organization account
  gets `tsgPersonPlaceholderHtml_` (later: the per-person view). Verified live for the
  owner and for info@tsg.homes. thestawaszgroup.com and tsg.homes are one Workspace (alias).
- Caution on identity calls: on 2026-09-14 a `Session.getActiveUser()` probe under the
  anonymous deployment made Apps Script return Google's "Sorry, unable to open the file"
  page. The most likely cause in hindsight is that the script had never been authorized
  for the identity scope (Durand granted it by running `tsgInstallInboxTrigger` in the
  editor), not the access mode itself. Either way: after adding any call that needs a new
  scope, Durand must run a function in the editor once, or every request errors.
- Transport under DOMAIN: the dashboard cannot fetch() the exec URL cross-origin (the
  browser drops the Google session, every call returns a sign-in page: "Failed to fetch").
  All 13 call sites go through `apiFetch`, which uses `google.script.run.tsgRpc` when the
  page is served by Apps Script and plain fetch otherwise. `tsgRpc` rebuilds the doGet/doPost
  event, supplies the token itself, and is OWNER-ONLY until per-person scoping exists,
  because google.script.run is callable from any page this script serves.
- Roster mapping: explicit roster `email` wins, else `firstname@<tsg domain>` matches the
  roster name case-insensitively (`tsgRosterNameForEmail_`).
- "Sorry, unable to open the file at this time" with NO doGet row in Executions means Google
  refused the request before the script ran: the tab is signed in to an account outside the
  domain (a new tab uses the browser's default account, which need not be durand@). It is not
  a code error, and no try/catch in doGet can surface it. Open the URL from a tab already on
  the TSG account or add `&authuser=N`. Diagnosed 2026-09-15 on the `?person=Marj` preview
  (v49 added an owner-visible error page to the person branch, v50 renamed the preview
  parameter from `as`; neither was the cause, both stay).
- DOMAIN switch was completed 2026-09-14 (versions 43-45; 43 was a no-op because
  `clasp push` silently skipped a changed manifest without `-f`, now fixed in
  scripts/deploy.js). The 1-minute `tsgInboxTick` trigger is installed. Rollback of any
  deploy: `clasp deploy -i <id> -V <previous version>`. Testing as another account from
  Durand's browser: append `?authuser=N` to the exec URL.
- Skills that curl the exec URL broke at this switch; the replacement text lives in the
  README "Access model and automation" section. Durand applies it in Cowork.
- After the switch, automation must not use the exec URL: read the Data/Rulesets files
  from Drive by id and write via `_Inbox` patches, which the trigger applies within a
  minute. `?api=sync` is no longer needed or reachable without a Google login.

## Hardening batch 1 (2026-09-15, backend 2026-09-15.1 / UI 2026-09-15.1)

- `processInbox_` (now private): a busy lock returns `{busy:true}` and doPost answers
  `{ok:false,error:'busy'}` (the dashboard shows "Queued" and polls); inbox files are
  trashed only AFTER the data/rulesets write succeeds; an unreadable target document
  leaves every patch queued and logs; a patch that throws is renamed `FAILED-` and
  dropped, the rest still apply. Empty listings set a 50 s cache flag that `tsgInboxTick`
  honours (no Drive listing while it holds; doPost clears it).
- `?api=version` is answered from the script cache (`docVersion` written on every write)
  before any inbox pass; the dashboard poll costs no Drive I/O.
- `tsgCheckToken_` refuses when SCRIPT_TOKEN is unset (no fail-open). `tsgRpc` gate is
  unconditional. Internals are private: `getTrackerFile_`, `applyDataPatch_`,
  `applyRulesetPatch_`, `getCalendarHours_`, `processInbox_`, `tsgListModels_`. Editor-run
  maintenance functions call `tsgAssertOwner_` first. `tsgTestDedup` and
  `tsgReestimateAllOpenTasks` are deleted.
- replace_all requires a numeric `baseVersion` (else rejected as `missing_baseVersion`);
  update_task cannot set `id`/`history`; set_meta cannot set `next_id`/`docVersion`/
  `rejectedSaves`/`addResults`; replace_all advances `next_id` past client-minted ids.
- NO ANTHROPIC API KEY IS PROVISIONED in the script (Durand 2026-09-16: "i dont have a claude
  api"; the dashboard's Ask-Claude button was disabled 2026-09-03 for the same reason). Until
  `ANTHROPIC_API_KEY` is set in Script Properties, every `tsgClaude_` call returns null before
  any HTTP: the estimator, Drive/calendar matching, progress-from-notes and Tidy are all
  no-ops, and a pushed task falls to needs-estimate + Triage. Estimates for Claude-session
  pushes come from the session itself (tsg-task-tracker-protocol skill), not the script.
- Claude calls: model `claude-opus-5` (raw HTTP via UrlFetchApp, no SDK in Apps Script);
  one retry on 429/529/5xx; `perRunCap` 12 estimator/matcher calls per execution; the
  remembered 404-fallback id is keyed to the configured model
  (`ANTHROPIC_MODEL_RESOLVED_V2`) so an upgrade is never shadowed by a stale memory.
- Tests: both suites exit non-zero on any failure; `.github/workflows/test.yml` runs them
  on every push.

## Hardening batch 2 (2026-09-15, UI 2026-09-15.2)

- Page 467 KB -> 338 KB: the two logos are 96x120 PNGs (about 1.9 KB each, downscaled
  with scripts in the session scratchpad from the 1441x1808 originals; keep them small),
  the seed `TASKS` array is gone (page never ships task data), `reestimateFromNotes`,
  `inBonusFinalWeek_` and the dead `prefers-color-scheme` block are removed, fonts are
  Playfair 700 + Lato 400/700 only (all 600/800/900 weights collapsed to 700).
- Warm start: `applyLoadedDoc_` installs a document; on boot the last document from
  `localStorage` (`tsgDocCache`) paints immediately, then the live fetch replaces it.
- `syncFubRoster` runs when Settings opens, not on every load.
- Search input is debounced 150 ms. `isoLocal_` replaces every `toISOString().slice(0,10)`.
- Modals carry `role="dialog"`, Escape closes the topmost one (`closeTopmostModal_`),
  the task card takes focus on open, `:focus-visible` is styled, the nine icon spans are
  real buttons, light-mode muted text is `#6b6a65` (5.4:1).

## Per-person view (2026-09-15, backend 2026-09-15.2, person UI 2026-09-15.1)

- `person.html` is served by doGet to any signed-in roster member (owner still gets the
  dashboard; owner + `?person=<Name>` previews that person's page). Placeholders stamped at
  serve time: `__TSG_PERSON__`, `__TSG_AS__`, `__TSG_CODE_VERSION__`. No token, no URL.
- Server decides everything: `tsgPersonSlice_` (own tasks by `owner`, tasks by `assignee`,
  subitems by `delegate`), `tsgPersonRpc(action, payloadJson)` with `load | update | add |
  version`. Own tasks: title/status/priority/progress/due/notes. Delegated: status/
  progress/notes only; anything else is refused server-side. Writes are single-item ops
  through `tsgQueueDataPatch_` (`update_task`, new `update_subitem` with an `expectTitle`
  guard, `add_task` with `skipEnrich`/`skipDedup`). Person-created tasks: owner and
  assignee = name, group = name, tag `Self-created`.
- Bump `PERSON_UI_VERSION` in person.html when it changes. Tests: `test/test_person.js`.

## Per-person view, round 2 (2026-09-15, backend 2026-09-15.5, person UI 2026-09-15.2, dashboard UI 2026-09-15.3)

- person.html mirrors the dashboard's Board view: same tokens (`data-theme` light/dark with
  a toggle, remembered in `localStorage` `tsgPersonTheme`), group sections "Delegated to
  you" / "Your tasks" / collapsed "Completed", status battery per group, pill selects,
  owner avatar, type badge, tag chips, progress track, subtasks nested under her own tasks
  (checkbox + status + notes), and a "+ Task" add form in the group head.
- Progress follows the notes BOARD-WIDE (backend 2026-09-15.6). `tsgApplyProgressFromNotes_`
  runs inside `update_task`, `update_subitem` and `replace_all` (the dashboard's own save,
  paired by task id / subitem index), and `add_task` asks the estimator for `progress`
  whenever a new task carries notes. Rule: only an OPEN item WITHOUT subitems whose notes
  actually changed and whose progress was not set explicitly in the same write is re-read
  (an explicit number always wins; the dashboard's manual progress input still works and
  sticks until the notes next change). Empty notes are 0 with no call; a task with subitems
  takes its bar from them; Claude unavailable leaves the value alone; first progress moves
  Not Started to In Progress. The change is logged on the item's history with the write's
  source. Cost: one estimator call per changed-notes item per write, under `perRunCap`.
  On the person page `progress` left every `TSG_PERSON_*_FIELDS` list and a typed value is
  refused; the estimator field itself is `progress` in `TSG_ESTIMATE_SYSTEM` /
  `tsgEstimateTask_`, read through `tsgProgressFromNotes_`.
- Person-created tasks are enriched like any other new task (estimate, type, subitems,
  tags, dependency, Drive doc) with `skipDedup` still on. Minted subitems are delegated to
  the task's assignee when that is not Durand (`tsgDefaultSubitemDelegate_`), and for a
  `personCreated` task the estimate is split evenly across them so they schedule (steps
  with no hours are never queued; Durand's pipeline still keeps the hours on the parent).
  The rollup then adds the 0.5 h confirm cost per delegated step to the parent's estHours.
- Scheduler: `tsgWorkItemsOf_` now returns a whole task owned by any named person other
  than Durand as a work item flagged `delegated`; `tsgItemIsDurandWork_` decides whether an
  item charges his capacity. Such a task is paced at its priority's chunk rate like a
  delegated subitem, never draws on his day, reserves the 0.5 h confirm slice after it
  finishes, and logs `auto-scheduled` on its own history. Unowned/`Unassigned` tasks stay
  unscheduled. This applies to every non-Durand-owned task on the board with estHours and
  no due date, not only person-created ones.
- Owner preview edits (`?person=<Name>`, RPC payload `as`) are recorded with `source` =
  the owner's roster name (`actor` in `tsgPersonRpc`), not the person's.
- Dashboard toolbar has one "Views" button per roster member (not Durand). A click opens
  that person's slice (owned by / assigned to / any subitem delegated to them) as the
  board's own scoped list pop-up (`openPersonView` -> `openMultiTaskModal`; a single task
  opens straight as its card, the modal's convention). Shift-click opens
  `<exec URL>?person=<Name>` in a named window from the dashboard tab's session
  (`personViewUrl_`), which sidesteps the wrong-default-account page.

## Per-person view, round 3 (2026-09-15, backend 2026-09-15.7, person UI 2026-09-15.3, dashboard UI 2026-09-15.4)

- REVIEW GATE, per Durand ("tag pushed tasks for review before sending them to delegates'
  views; not all tasks marked for Marj are actually hers; use the Triage tag so I have a
  quick list"). `TSG_REVIEW_TAG = 'Triage'`. Anything AUTOMATION pushes that points at a
  person other than Durand/Claude is tagged Triage: `add_task` (owner/assignee is a person,
  or any subitem delegate is), the near-duplicate merge-as-subitem, `add_subitem` with a
  person delegate (subitem-level tag), `update_task` that adds or re-delegates a subitem to
  a person (subitem-level) or re-points `assignee`/`owner` at a person (task-level). Never
  held: `personCreated` adds (the person's own page) and the dashboard's `replace_all`.
  `tsgPersonSlice_` hides any task tagged Triage (with all its subitems) and any subitem
  tagged Triage, so a Triage tag from ANY cause, an estimate to confirm included, keeps the
  item off the delegate page until Durand clears it. History field `pending-review`.
- Clearing: on the board row the Triage chip is a button (`reviewChipHtml` /
  `approveReview`) that strips Triage from the task and every subitem and logs `review`;
  the task modal's tag "x" on Triage does the same; a subitem-level hold also clears via the
  subitem row's click-to-remove chip. The toolbar's Triage filter and the alert banner
  ("needs triage: an estimate to confirm or a pushed delegate item to release") are the
  quick list.
- Person page: steps always nest under their parent row, open by default (`collapsedSubs`
  holds the ones closed by hand). A task that is neither hers nor assigned to her but has
  steps delegated to her is a read-only CONTEXT row (`context: true`, `editable: []`,
  status/progress rolled up from HER steps only, owner shown, no notes/tags/estimate)
  with her steps beneath it. Clicking a row (not a control) opens a card (`openCard`,
  `#cardBack`) with the same edit rules and her steps; Escape, backdrop or x closes it; an
  open card re-renders after every load. Adds lock the board (`#board.busy`, form disabled,
  spinner in `#sync`) until the server answers.

## Whole-task delegate (2026-09-15, backend 2026-09-15.9, dashboard UI 2026-09-15.6)

- The task-level field is `delegate` (per Durand: "drop assignee, it's been replaced by
  delegate"), the same word subitems use. It is what puts a whole task on that person's page.
  Editable on the dashboard: a Delegate select on every board row (under Owner) and a
  Delegate row in the task modal (`taskDelegateSelect` / `onTaskDelegateChange`, history
  field `delegate`). Set by Durand on the dashboard it is NOT held for review; set by a
  patch it is (round 3 gate). `delegate` is in `TSG_TASK_DIFF_FIELDS`.
- `assignee` is retired. `tsgTaskDelegate_(t)` reads `delegate` and falls back to a leftover
  `assignee`; `tsgMigrateAssigneeToDelegate_` (run inside `tsgAutoScheduleDoc_`, i.e. on
  every data write) moves the value and deletes the old key; `update_task` / `add_task`
  accept a patch that still says `assignee` and land it as `delegate`. The dashboard's
  `taskDelegate(t)` has the same fallback. Patches from Claude sessions should say
  `delegate` from now on.

## Claude as delegate and task type (2026-09-15, backend 2026-09-15.10, dashboard UI 2026-09-15.7)

- Task type `Claude` (in `TASK_TYPES` and the estimator's list): work Claude carries out in a
  Cowork / Claude Code session. A new task the estimator types Claude with no delegate gets
  `delegate: 'Claude'` (a supplied delegate is never overridden). Delegate selects (task and
  subtask) offer "Claude" after the roster; the owner select does not.
- Claude-delegated items are never held by the review gate (Claude has no page) and, like
  any non-Durand delegate, are paced rather than charged to Durand's capacity.
  `tsgWorkItemsOf_` now decides "delegated" by the whole-task delegate when set, else the
  owner, so a task Durand owns but delegated to Marj or Claude no longer eats his day.

## "+ Task" on pop-up lists (2026-09-15, task #269, backend 2026-09-15.11, dashboard UI 2026-09-15.8)

- Every scoped pop-up list (stat tiles, alert lists, a person's view, "Didn't fit", the
  schedule block detail, the full-schedule view with one button per block) carries a
  "+ Task" (`popupAddBtn_` / `setDayViewAdd_`, slot `#dayViewActions`) that opens the New
  Task modal pre-filled from the list: `openMultiTaskModal(title, ids, prefill)`,
  `schedulePrefill_(item, dateISO)` (Errands -> group Errands + tag Errand; Lunch/Relief/
  Admin -> tag; calendar -> notes "From meeting: ..."; every block -> due that day).
  Prefills live in `POPUP_PREFILLS` by index, never JSON in an attribute.
- The New Task modal (`renderNewTaskModalBody(prefill)`, `newTaskFieldsFromModal_`) now has
  Delegate (roster + Claude) and Tags fields and a "Pre-filled from" line.
- Dashboard adds send `ownerCreated: true` on `add_task`; the review gate skips them, so a
  delegate chosen on the dashboard is never held (only automation pushes are).

## #250 backlog build-out (2026-09-16, backend 2026-09-16.2, dashboard UI 2026-09-16.3)

Decided with Durand one by one on 2026-09-16; all built, item 13 was already in place.
- Durand first: `sortPeople_` / `rosterNames` pin Durand ahead of everyone (owner filter,
  owner sort, Workload, every person select).
- Group is a dropdown (`groupSelectOptions_`, `modalGroupChange`, `ntGroupChange`) with a
  "+ New group…" entry; tags autocomplete from `#tagOptions` (refilled by
  `populateDynamicFilters`, `modalAddTagFrom`); notes/title contenteditables carry
  `spellcheck="true"`.
- Task-level dependencies editable in the modal (`dependsChipsHtml_`, `modalAddDepends`,
  `modalRemoveDepends`; same `t.depends` comma list the Timeline drag writes).
- Dense cards: a Cards group with more than `DENSE_CARD_THRESHOLD` (12) open cards renders
  compact cards; per-group "Full cards / Compact" toggle (`denseOff`).
- Link picker (`addManualDoc` -> `#linkModal`): Drive search through `api=driveSearch&q=`
  (`tsgDriveSearch_`, files Durand owns, up to 15), upcoming meetings, or a pasted URL whose
  label comes from `api=linkLabel&url=` (`tsgLabelForUrl_`: Drive/Docs file name; hostname
  otherwise; NO fetch of arbitrary URLs). Labels are never typed by hand any more.
- Recurring meetings: both calendar feeds carry `seriesId` (`getEventSeries().getId()`);
  the picker's "Link the series" (`linkMeetingToTarget(ev, true)`) stamps
  `item.meetingSeriesId` and a docs entry with `seriesId`; `todayMeetingBlockMatch_` /
  `linkableToday` match any occurrence of the series on that day.
- Merge (`mergeTaskInto`): the modal's Merge row folds notes (dated "[Merged from #id]"
  block), subtasks, links, tags, due and dependencies into the target, repoints dependents,
  logs `merged-from`, deletes the source.
- Tidy (`tidyTask` -> POST `target=tidy` -> `tsgTidyProposal_` with `TSG_TIDY_SYSTEM`):
  Claude proposes title/notes/priority/type/group/estHours/tags; validated server-side
  (unknown values fall back to current, hours rounded to 0.25, system tags kept, 3 topical
  tags max); the dashboard shows before/after per changed field with checkboxes and applies
  only what Durand ticks, logged with source "Claude (tidy), accepted by Durand". Never
  automatic; one Claude call per click.
- Comment mode (toolbar "Comment" toggle, `commentMode`): click anything to leave a note
  anchored to it (`commentAnchorFor_`: task / sub / group / tile / element). Stored in
  `meta.comments` via NEW ops `add_comment` ({comment}) and `update_comment` ({id, fields}
  or {id, remove:true}); `set_meta` can no longer write `comments`. Badges on rows/cards,
  a toolbar count, and a Comments panel (resolve/reopen/delete). CLAUDE SESSIONS: read
  `meta.comments` from the data file; reply with an `add_comment` inbox patch carrying
  `author: 'Claude'` and `replyTo: <id>`, resolve with `update_comment`.

## Claude-call efficiency pass (2026-09-16, backend 2026-09-16.3)

Per Durand ("is there a more efficient way to implement all of the claude calls?" ->
"implement then deploy everything"). All plumbing is in `tsgClaudeBody_` / `tsgClaude_` /
`tsgClaudeSettle_` / `tsgClaudeMany_`; tests in the "Claude call plumbing" section.
- One call per new task: `tsgDriveCandidates_` and `tsgCalendarCandidates_` only GATHER
  candidates; the judgment rides in the estimator call as NEEDED_FIELDS `driveMatch` /
  `meetingMatch` (`tsgMatchFromParsed_`, `tsgDocFromCandidates_`, `tsgMeetingFromCandidates_`).
  Calendar candidates are offered whenever the type is Meeting or still unknown; the link is
  applied only once the resolved type is Meeting. `tsgSearchDriveForTask_`,
  `tsgSearchCalendarForTask_`, `tsgMatchCandidate_` and the two match system prompts are gone
  (their rules moved into `TSG_ESTIMATE_SYSTEM`). A failed merged call loses every field for
  that task, handled exactly as an unreachable Claude was (needs-estimate, no links).
- Effort: `output_config.effort = 'low'` whenever a call asks only for classification fields
  (`TSG_ESTIMATE_LOW_EFFORT_FIELDS`: progress, driveMatch, meetingMatch) and for every
  progress-many read. The full estimator, Tidy and `?target=claude` keep the model default.
- Structured outputs: `output_config.format = {type:'json_schema', schema}` on the estimator
  (`tsgEstimateSchema_`, built from the requested fields), Tidy (`TSG_TIDY_SCHEMA`) and
  progress-many (`TSG_PROGRESS_MANY_SCHEMA`). `tsgExtractJson_` still parses the text. An HTTP
  400 on a schema request is retried once without it and schemas are paused 6 h (script cache
  key `claudeNoSchema`) so an unsupported schema keyword can never take the pipeline down.
- Prompt caching: the system prompt is always a `cache_control` block; the estimator sends
  the board context (`tsgBoardContext_`: EXISTING_GROUPS / OPEN_TASK_TITLES / EXISTING_TAGS)
  as the FIRST user block with its own marker, byte-identical across a bulk push (the bulk
  handler computes it once as `__batchContext`; siblings go in BATCH_SIBLING_TITLES in the
  volatile part). Below 512 tokens (Opus 5 minimum) a marker is a silent no-op.
- Parallel: `tsgClaudeMany_(reqs)` = one `UrlFetchApp.fetchAll`, every request charged to
  `perRunCap`, the overflow returned null unsent. Used by `tsgReestimate` and by
  `tsgProgressFromNotesMany_` when a save changes notes on more than 20 items.
- Progress on a dashboard save (`tsgApplyProgressFromNotesOnSave_`) is ONE call for every
  changed item (`tsgProgressWanted_` decides, `tsgSetProgressFromNotes_` applies), 20 items per
  request. Single-item writes (update_task / update_subitem) still make one call each.
- Response parsing: the first `text` block is the answer (a thinking block may precede it);
  `stop_reason: 'refusal'` is no answer. `tsgEstimatePrompt_` / `tsgEstimateParse_` split
  the estimator so callers can build many prompts and send them together.

## Errands block, add lockout, task location (2026-09-16, backend 2026-09-16.4, dashboard UI 2026-09-16.4)

- Errands block: a task in group `Errands` or tagged `Errand` that is on today's plate
  (`todayInclude_`) sits INSIDE the Errands block as `items` (`getTodayErrandItems`,
  `isErrandTask_`); `getTodayCandidates` skips it, so it is never a separate work block. The
  block grows from 30 min to the sum of the items (estimate + round-trip travel). The row,
  the block detail and the arrow nav treat an errand block with items like a task block.
- Add lockout: `confirmNewTask` marks `#newTaskModal.busy` and sets `NT_BUSY`; the form is
  inert (CSS) and `closeNewTaskModal` refuses (Cancel, backdrop, Escape) until `createTask`
  answers. The inline group add form gets `.add-form.busy` the same way.
- Location: task field `location` (free text; in `TSG_TASK_DIFF_FIELDS`). New Task modal
  field `ntLocation`; task modal "Location" row (`modalEditLocation`, prompt); card badge
  with the round trip. Settings > Team has a "Home base" input that posts
  `set_meta {homeBase}` (`setHomeBase`; `HOME_BASE` / `RAW_META.homeBase`).
- Round trip: `tsgApplyTravelTimes_` runs inside `tsgAutoScheduleDoc_` (every write): for a
  located, open task whose `travelFor` key (location | homeBase, lower-cased) is stale it
  calls `tsgRoundTripMinutes_` (Apps Script `Maps.newDirectionFinder`, DRIVING, both legs,
  rounded up to 5 min), stamps `travelMin` + `travelFor`, logs `travelMin` with source
  `Maps`; results cached 6 h in the script cache; at most `TSG_TRAVEL_PER_RUN_CAP` (10)
  Maps calls per run; a Maps failure logs and leaves the task alone; clearing the location
  deletes both fields; no home base means nothing is computed. `tsgItemHours_` (estimate +
  travel) is what the scheduler seeds and places with. Work items on the dashboard carry
  `tags`, `location`, `travelMin`.

## Judgment queue, location search, travel modes (2026-09-16, backend 2026-09-16.5, dashboard UI 2026-09-16.5)

- METHOD 2 per Durand ("use method 2 to bypass the need for a key"): with no API key every
  judgment is queued in `meta.judgments` (`tsgQueueJudgment_`, ids `J<n>` from
  `meta.judgmentSeq`, cap 200, one pending request per kind + target) and applied later by
  `tsgApplyJudgmentOp_` from `{op:'judgment', id, answer}` inbox ops. Kinds: `estimate`
  (queued by add_task after the id is minted; carries need, notes, plain Drive/calendar
  candidates), `progress` (update_task / update_subitem / replace_all, one per changed item,
  dropped on apply if the notes moved on), `tidy` (`request_tidy` op from the Tidy button;
  the answer lands in `meta.tidyProposals[taskId]`, cleared by `clear_tidy_proposal`).
  `judgments`, `judgmentSeq`, `tidyProposals` are server-owned (set_meta / replace_all
  cannot write them). `TSG_CURRENT_DOC` is the doc applyDataPatch_ is working on, so deep
  helpers can queue. `tsgApplyEstimateToTask_` is the one field-apply routine for both the
  live path and a deferred answer (deferred: never overwrites a value set meanwhile, strips
  needs-estimate and the fallback note). Protocol for the Routine: README "Judgment queue".
  The Routine itself: "TSG Tracker — judgment queue", fresh cloud session hourly on
  weekdays 11:00-21:00 UTC, Google Drive connector; its prompt is standalone (it does not
  rely on this repo being checked out on the branch that holds this text).
- Dashboard: Tidy button reads "Tidy requested" while a tidy request is pending and
  "Review tidy" once `meta.tidyProposals[id]` exists (`refreshTidyButton_`, `tidyProposalFor_`;
  review has Keep for later / Discard / Apply; apply or discard posts `clear_tidy_proposal`).
  The Estimate row shows "queued for Claude" while an estimate request is pending
  (`pendingJudgment_`).
- Location search (per Durand: "location add should be a search too"): `#locationModal`
  (`openLocationPicker(current, onPick)`): `api=geocode&q=` (`tsgGeocode_`, Maps geocoder,
  top 6 formatted addresses), "Recently used" from other tasks' locations, "Use as typed",
  "Clear location". Used by the task modal's Location row and the New Task modal's Search.
- Travel modes (per Durand: "an estimate for the task itself, plus one-way and round trip
  estimates, i can pick which, and show a total"): the server stamps `travelOneWayMin` and
  `travelMin` (round trip); task field `travelMode` ('round' default | 'oneway' | 'none', in
  `TSG_TASK_DIFF_FIELDS`). `tsgTravelChargeMinutes_` / dashboard `travelMinutesFor_` give the
  charged minutes; `tsgItemHours_` = estimate + charged travel; the Estimate row has a
  select (none / one-way N min / round trip N min) and "= X h total"; the card badge shows
  the chosen travel and the total; the Errands block uses the same minutes. Home base is
  mirrored into script property `TSG_HOME_BASE` by set_meta so the calendar feeds can use
  it: an off-site calendar event's travel is the real one-way drive (`tsgEventTravelMinutes_`,
  Maps, cached) instead of the flat 20 min when a home base is set. Maps calls are capped
  per execution by `TSG_TRAVEL_CALLS` / `TSG_TRAVEL_PER_RUN_CAP`.

## Free-flow notes, automatic tidy, travel methods (2026-09-16, backend 2026-09-16.6, dashboard UI 2026-09-16.6)

- Per Durand: "write a free flow thought into a new (or existing) task note and Claude
  populates all fields from that and polishes the note itself"; "the tidy should now just be
  automatic"; "travel method, walk/drive/transit - and make a recommendation".
- Queue kind `enrich` replaces `estimate` and `tidy`. add_task asks for `title` + `notes`
  polish (and `location` / `due` when blank) whenever notes are present; a task whose notes
  change (update_task after its field log, replace_all) goes through `tsgEnrichTask_` with
  `tsgEnrichNeedFor_` (everything except fields Durand set by hand per `tsgUserTouched_`:
  a history line for the field with a person's source; no source = automation); emptied
  notes only reset a notes-driven bar. `request_tidy` = `tsgEnrichTask_(force)`: every field
  re-judged, applied automatically, no proposal (`meta.tidyProposals` is dead). The estimator
  prompt/schema carry `title`, `notes`, `location`, `due`, a `TODAY` line and
  `CURRENT_FIELDS` (`tsgCurrentSnapshot_`). `tsgApplyEstimateToTask_` guards: `keep(field)`
  (hand-set, unless force), `touchedSince(field)` for title/notes/progress, stale notes via
  `tsgStripFallbackNotes_`; progress lands before new steps are appended; steps merge by
  title; every change gets a history line with the answer's source.
- Dashboard: New Task needs only a note (title = first line, group Unsorted, Claude fixes
  both); the Tidy button is "Re-run Claude" / "Claude queued"; the Estimate row says
  "queued for Claude" while an enrich request is pending.
- Travel methods: `travelOptions {drive, walk, transit}` one-way minutes (Maps, three calls
  per location, cached 6 h, null when unroutable), `travelRecommended`
  (`tsgRecommendTravel_`: walk <= 15 min, else transit within 30% of driving, else drive),
  `travelMethod` (Durand's pick, in `TSG_TASK_DIFF_FIELDS`), `travelMethodUsed`, and the
  effective `travelOneWayMin` / `travelMin` recomputed on every write without Maps. The
  Estimate row has a method select (recommended marked) next to the mode select; card and
  Errands block label the method. Calendar events use the drive time.

## Subtasks in the pass, polish first, links every update (2026-09-16, backend 2026-09-16.7, dashboard UI 2026-09-16.7)

- Per Durand: "it should apply to subtasks fully as well, the note should be polished first,
  infer location and due date as well, and add links at every update".
- `tsgEnrichItem_(doc, parent, item, subIdx, now, source, opts)` is the one entry
  (`tsgEnrichTask_` wraps it): update_subitem (after its field log), add_subitem with notes,
  and replace_all subitem notes changes all re-judge the SUBTASK with its own title/notes/
  estimate/type/priority/tags/progress/location/due (never group, dependency or steps);
  the request carries `subIdx` + `subTitle` and `current.subtask: true`; on apply the
  subtask is found by index, else by title, else dropped. `TSG_SUBITEM_DIFF_FIELDS` logs
  `location` / `travelMode` / `travelMethod` so hand edits count as hand-set.
- Every pass gathers Drive candidates (from the item title) and, when the type is Meeting or
  still open, calendar candidates; a confident match is linked unless the url is already on
  the item. `location` and `due` update on any pass unless hand-set (never cleared).
- `tsgApplyEstimateToTask_` applies the notes polish first, then the title, then
  location/due, then the rest; the prompt says to polish first and derive from the polished
  text. Travel (`tsgApplyTravelTimes_`) runs over subtasks too; the subtask row shows its
  location and travel. Legacy `progress` requests still apply.

## Block Party raffle (raffle/, 2026-09-18)

- `raffle/` is a SEPARATE Apps Script project: "TSG Open House Sign-In + Client Intake Forms",
  script id `1ZPZIHv8ocQyN23ikKf3rTgpyIU9pktRqjlaFJEGamwNziWWjUqLGvBRf`, owned and deployed by
  `info@tsg.homes` (the web app runs as the deploying account and that is what MailApp sends
  from; redeploying as durand@ silently moves the sending identity). Not the tracker's script,
  not `npm run deploy`. Read `raffle/README.md` first. The folder was imported to this branch on
  2026-09-18 from `claude/inspiring-brown-d0r5kr` (its last raffle commit 1a08d4f); that branch
  is an older tracker snapshot and is not merged.
- Deploying: from a scratch clone of that project (`clasp clone <script id>` as info@), pull the
  live project first (`Code.js`, `OpenHouseForm.html`, `ClientIntake.html` have no other version
  control), copy `RaffleCode.gs`, `RaffleReferral.gs`, `RaffleForm.html` (BUILT: run
  `npm run build:form`, never hand-edit), `RaffleConsole.html`, `RaffleConsent.html` over, push,
  then Deploy > Manage deployments > edit the existing deployment > New version. A new deployment
  mints a new URL and kills the printed QR. The two `PATCH-Code.gs.md` hooks in the host
  `Code.gs` are already live. `setupRaffle()` must be re-run as info@ after any deploy that adds
  a trigger. The cloud proxy blocks script.google.com, so Durand loads the live pages.
- Tests: `npm run test:raffle` (templates + 583 server + 199 red-team, in `npm test`) and
  `npm run test:form` (Playwright against the built page and the console; needs
  `npm i --no-save playwright` matching `/opt/pw-browsers`, not in `npm test`).
- Failure handling batch (2026-09-18, Durand's 9/17 rehearsal): pages parse the reply as text
  and name an HTML error page as a server error; every failure is a `.fail` / `.failbox` block
  with a Retry that re-sends the same payload; caught exceptions return `serverError`, a scrubbed
  message and an `E-XXXXXX` ref; `step: 'report'` writes the `Client Errors` sheet tab and alerts
  Durand (10-min throttle); `raffleAlertOps_` mails Durand ONLY (`RAFFLE_ALERT_EMAIL`; per Durand "only send errors
  to me not ryan", the quota alert too) on draw / result-email / winner-email / redraw failures;
  every failure raises a fixed red `#failBanner`; every in-flight request locks the page
  behind `#busyOverlay` with a seconds counter; `raffleTimer_` puts `timing` on the
  request/verify/referral/invite JSON (shown in test mode). Kiosk: `Start over for the next
  guest` only with `&kiosk=1`. Full write-up: README "Failure handling".

## Cloud (Claude Code on the web) session facts

- clasp credentials do not persist between cloud sessions. Each session needs
  `clasp login --no-localhost`: Claude prints the URL, Durand authorizes as
  durand@thestawaszgroup.com, and pastes back the `http://localhost:8888/?...code=...` URL.
- The cloud session's outbound proxy blocks `script.google.com`. The exec URL cannot be
  smoke-tested from a cloud session; ask Durand to load it. clasp works because it uses
  googleapis.com.
- Work on the branch the session names; never push to main without being told.

## Pinned tasks and the two bonus tasks (2026-09-16, backend 2026-09-16.8, dashboard UI 2026-09-16.8)

- Task field `pinned` (boolean, in `TSG_TASK_DIFF_FIELDS`, never touched by enrich). Dashboard:
  `isPinned_` / `sortTasks` put pinned tasks ahead of every sort in every list; Board and Cards
  render a "Pinned" section (`renderPinnedGroupHtml_`, `data-group="__pinned__"`) above every
  group and drop pinned tasks from their own group; pin button on rows, cards and the modal
  header (`togglePin`, history field `pinned`). Patches can set `pinned` on add/update.
- Per Durand ("pin these two tasks to the top always, they are required for my bonus"): the
  eight open FUB tasks (#1, #240, #252, #264, #265, #266, #267, #277) were collapsed into ONE
  pinned task "FUB Go-Live — Agent Rollout, Lofty Migration, Automations and Forms (Bonus)"
  (42 steps, phase-prefixed, each step's notes carry "[Merged from #id]"), and a pinned task
  "SOPs 01–10 Live by the Dec 18 Review (Bonus)" (29 steps derived from the Ops Manual working
  copy) was created. Both Critical, due 2026-12-18, tag `Bonus`. The FUB go-live date stays
  PENDING (first step of the FUB task). Never split these back out or unpin them without Durand.

## Links every update, round 2 (2026-09-17, backend 2026-09-17.1, dashboard UI 2026-09-17.3)

Per Durand: "still perform link match searches even if links are added manually; search emails
too; linking to Claude sessions; for Claude tasks a link to open the thread with a preloaded
prompt; web searches for named or recommended sites; a send to phone button for directions;
for meeting tasks without a meeting, create one between owner and delegate with recommended
times when both are free before the deadline, duration from the estimate in Google's buckets".
- Candidates are gathered on every add/enrich pass whatever is already linked (the
  already-linked url is skipped on apply). NEW: `tsgMailCandidates_` (GmailApp.search, read-only,
  6 threads, 180 days, 300-char excerpt) judged as `mailMatch` (low-effort field); a confident
  match becomes a `type: 'email'` doc (`https://mail.google.com/mail/u/0/#all/<threadId>`,
  history `email-auto-linked`), a weaker one only a history line. NEW need `webLinks`: up to 3
  `{url,label}` named sites the task involves, applied as `type: 'web'` docs
  (`web-auto-linked`); the README tells the Routine to web-search them. Queue requests carry
  `mailCandidates`. Schema/prompt/parse in `tsgEstimateSchema_` / `tsgEstimatePrompt_` /
  `tsgEstimateParse_` (`MAIL_CANDIDATES` block).
- Link picker: "Search your email" (`api=mailSearch&q=` -> `tsgMailSearch_`, 10 threads).
  `addDocToTarget_(url, label, type)`; `linkTypeFor_` / `docIcon_` (meeting, email, claude, web,
  link). `tsgLabelForUrl_` labels claude.ai (chat / Code session) and Gmail links.
- Claude: task modal row (Claude-typed task or any task with a claude.ai link). Per Durand
  ("always use cowork or code, the sessions should be linked to the computer and be able to be
  run from the cloud"), NEVER a plain chat link. Buttons (`claudeLinksFor_`, docs-verified deep
  links): "Cowork" -> `claude://cowork/new?q=<prompt>` (desktop app, this computer); "Code" ->
  `claude://code/new?q=<prompt>&repo=<meta.claudeRepo>` (desktop app); "Code (cloud)" ->
  `https://claude.ai/code?prompt=<prompt>&repositories=<repo>` (claude.ai/code, pull down with
  `claude --teleport`); "Open linked session" when the task links a claude.ai session (opens it,
  prompt copied, since an existing session cannot take a prompt by URL); "Copy prompt".
  `claudePromptFor_`: starts with `/optimize-prompt` (per Durand 2026-09-17 "use the optimize
  prompt skill to generate the prompts": the receiving session recomposes the brief and runs it),
  then id, title, fields, notes capped at 4000 chars (desktop q limit ~14k), steps, links,
  write-back instruction naming the tsg-task-tracker-protocol skill. claude:// links are
  opened by same-tab navigation. Settings > Team "Claude Code repo" -> `set_meta {claudeRepo}`
  (`CLAUDE_REPO`), optional owner/repo.
- Directions: Location row gets "Directions" (Maps directions URL, home base -> location, in the
  task's travel method, `directionsUrl_`) and "Send to phone" (POST `target=sendDirections` ->
  `tsgSendDirections_`: MailApp.sendEmail to OWNER_EMAIL with the link; no third party).
- Meeting slots: `api=meetingSlots&guest=&start=&end=&minutes=` -> `tsgMeetingSlots_`: weekdays
  07:30-16:00 minus lunch 12-13, never within the next hour, Durand's calendar (declined events
  ignored) plus the guest's via `CalendarApp.getCalendarById` (must be shared, SOP 09; else
  `guestCalendar:false` and Durand-only slots), 2 per day, 10 max, window capped at 42 days.
  `tsgDurationBucket_` / dashboard `meetingBucket_`: 15/30/45/60/90/120 from estHours (30 when
  none). Windows cascade (`TSG_MEETING_WINDOWS`, per Durand 2026-09-17): 'preferred' Mon-Thu
  9-2, then 'second' Mon-Thu 8-4 only when that has nothing, then 'third' Mon-Thu 8-4 plus Fri
  10-2 only when the second has nothing; the form says which applied. The day template's errand
  (10:00-10:30), lunch (12-1) and relief (14:00-14:20) blocks (`TSG_DAY_BLOCKS`) are busy by
  default ("exclude errands and break blocks by default"); `&blocks=0` / the form's "skip
  errand and break blocks" checkbox lifts that (backend 2026-09-17.3, dashboard UI 2026-09-17.6). The picker's "+ New meeting" form lists "Suggested times" up to the item's due date
  (`loadMeetingSlots_`, `useMeetingSlot_` fills date/start/duration; guest email change reloads).
- Scopes: GmailApp (read) and MailApp were already in use (verifyEmail, write-failure mail), so no
  new authorization was needed.

## Due time and reminders (2026-09-17, backend 2026-09-17.3, dashboard UI 2026-09-17.6)

- Per Durand: "add a reminder function and optional time component for due dates". Fields on
  tasks AND subtasks: `dueTime` 'HH:mm' (optional; `timelineEnd` stays the date and the
  scheduler ignores the time), `remindAt` 'YYYY-MM-DDTHH:mm' in the script time zone,
  `reminderSentAt` (server-set ISO). `dueTime` / `remindAt` are in both DIFF_FIELDS lists.
- Backend: `tsgIndexReminders_` runs inside `tsgAutoScheduleDoc_` (every write) and stores the
  earliest pending reminder (`tsgPendingReminders_`: remindAt set, not sent, item not Done) in
  script property `TSG_NEXT_REMINDER`. `tsgInboxTick` (the installed 1-minute trigger) calls
  `tsgReminderTick_` first: no Drive read until the property is due; then it emails OWNER_EMAIL
  one message per due item (subject "Reminder: <title> — due <date> <time>", body with parent,
  priority, delegate, location, notes, links) and queues a `bulk` patch (source "Reminder")
  stamping `reminderSentAt`; a 15-minute cache key `reminderFired:<key>` guards against a double
  send before the stamp lands. No new trigger or scope (MailApp already in use).
- Dashboard: the modal Due row and every subtask row carry a time input and a bell select
  (`REMIND_PRESETS`: none / at due time / 15 min / 1 h / 1 day before / Custom with a
  datetime-local). Presets are computed from the due date + due time (09:00 when no time) and
  follow later date/time changes (`followDueReminder_`, `onDueTimeChange_`); a change clears
  `reminderSentAt`; "· sent" shows once emailed. A preset without a due date is refused (Custom
  still works). The board row shows the time as a chip next to the date.
- Native notifications (dashboard UI 2026-09-17.7, per Durand "if the tracker is open it
  should also send a native notification"): `checkReminderNotifications_` (on load and every
  30 s) raises a browser `Notification` (click opens the task) for every reminder due in the last
  24 h, or an in-page toast (`#tsgToasts`) when permission is missing; each remindAt value is
  remembered in localStorage `tsgNotifiedReminders` so nothing repeats. Permission is requested
  when a reminder is set and from Settings > "Reminder notifications". Whether the Apps Script
  iframe origin is allowed to show notifications is unverified from a cloud session; the toast
  is the fallback either way.
- Scheduler due times (same UI version, per Durand "when the scheduler builds the schedule and
  assigns timeslots to tasks, that should fill in the due time field"): `applyScheduledTimes_`
  runs after `buildTodayAgenda` in the day view: every task / subtask in a task or errand block
  whose due date is that day gets `dueTime` = its slot start (items inside a block advance by
  estimate + travel), flagged `dueTimeAuto`, history source "Scheduler", and a preset reminder
  follows. A time typed by hand (any edit through `onDueTimeChange_` clears the flag) is never
  overwritten.

## Hand edits win, disagreements flagged (2026-09-17, backend 2026-09-17.4, dashboard UI 2026-09-17.8)

Per Durand: "Claude should be making judgement calls on all fields that aren't calculated from a
formula or system entered" and "fix the overwrite bug, but if there's a significant difference
between that hand set value and the Claude generated value, flag it for manual review and
explain everything in the note too".
- BUG FIXED: dashboard `logHistory` wrote no `source`, and `tsgUserTouched_` reads a source-less
  line as automation, so no dashboard edit was ever protected from enrichment. Every dashboard
  history line now carries `source: 'Durand'` (the page is owner-only). `tsgUserTouched_` also
  treats `rollup`, `Scheduler` and `Reminder` as automation (a roll-up line on a task with steps
  used to look like a hand edit). Values typed into the New Task form get `Durand` history lines
  at creation (`ownerCreated`), so they are hand-set from the start.
- `tsgEnrichNeedFor_` asks for EVERY judgment field on every pass (title, notes, tags, estHours,
  taskType, priority, location, due; plus subitems, group, dependsOnTitle on a task). Protection
  moved to apply time: `keep(field)` still wins, and `tsgFlagDisagreements_` records a material
  difference (`tsgMaterialDiff_`: hours off by more than max(1h, 50%); priority 2+ ranks; due
  more than 3 days; progress 25+ points; type/group/location any difference; never hours on a
  task with steps) as `task.reviewFlags[] {ts, field, mine, claude, rationale, source}`, a
  `disagreement` history line, the tag `Review` (NOT Triage: Triage hides an item from the
  delegate's page and a disagreement must never do that; `Review` is reserved, never handed out
  by Claude) and a "REVIEW (date): Claude proposed …; your value … is kept." paragraph
  regenerated at the end of the note by `tsgSyncReviewNotes_` (stripped by
  `tsgStripReviewNotes_` / `tsgStripFallbackNotes_` for stale-notes comparisons). A later pass
  that agrees clears the flag; a forced re-run (Tidy) adopts Claude's values and clears them all.
- Dashboard: `Review` renders as a "Claude disagrees" chip that opens the card; the modal's
  "Claude disagrees" row lists each flag with "Keep mine" / "Use Claude's" (`resolveReviewFlag`:
  applies the value with a Durand history line or logs `review: kept …`, drops the flag, the tag
  and the paragraph when none remain). The Triage toolbar filter also shows Review-tagged tasks.
- Dependencies: removing the last one on the dashboard sets `dependsNone: true` (in
  `TSG_TASK_DIFF_FIELDS`); add_task and the enricher then never ask for `dependsOnTitle`; adding a
  dependency by hand (dashboard or an `update_task` with `depends`) lifts it; the Depends row
  says "none, cleared by you" with a refresh button (`allowDependsInfer`).

## Subtasks ride in the parent's call (2026-09-17, backend 2026-09-17.5)

Per Durand: "subtasks may also enrich when the main task's notes change, including getting new
notes of their own, wait for that before enriching them on their own so there's only 1 call, not 2".
- A task's enrich pass now carries its open steps: `tsgOpenStepsSnapshot_` (index + current values,
  30 max, notes cut at 600 chars) goes in the prompt as `CURRENT_STEPS`, need gets `steps`, and the
  answer's `steps[]` (one per index) is applied per step through the SAME parse + apply
  (`tsgEstimateParse_` / `tsgApplyEstimateToTask_` with `subitem: true`), so hand-set protection and
  Review flags work per step. Deferred answers follow a moved step by the title stored in the
  request's `currentSteps`. A Done step is never touched.
- Minted steps (`subitems`) are objects `{title, estHours, taskType, priority}` (schema enforced live;
  a bare string from the Routine still lands), so a new step never needs a second call.
- Triggers: parent notes change (update_task / replace_all) = one call carrying every open step;
  parent unchanged but steps new or with changed notes = ONE steps-only call for that parent
  (`tsgChangedStepIndices_` -> `tsgEnrichSteps_`, need `['steps']`, no link gathering); add_subitem
  is always enriched (a title is enough for a step: `allowEmptyNotes`); update_subitem keeps its
  own single call. New op `request_steps {id, indices?}`: steps-only re-judge of the open steps that
  still have no hours (titles with hours already are never sent), used for backfills.
- Backfill still pending: queue `request_steps` for the 12 parents holding the 33 unestimated
  steps once the Routine has its Drive connector.

## One links field, uploads, image paste (2026-09-17, backend 2026-09-17.6, dashboard UI 2026-09-17.9)

Per Durand: "one field for all types of links, don't need to separate drive, email, web, Claude or
uploaded files/pasted images (add the ability to add local files and paste images too)".
- `docs[]` is the one list on tasks and subtasks; the legacy single `doc` is folded in by
  `tsgMigrateDocToDocs_` (runs inside `tsgAutoScheduleDoc_`, i.e. on every write) and no code
  writes `doc` any more. Entry types: `link` (Drive/any URL), `meeting`, `email`, `claude`, `web`,
  `image`, `file`; `docIcon_` / `linkTypeFor_` on the dashboard.
- Link picker (`addManualDoc` -> `#linkModal`): ONE search box (`#linkSearch`, `runLinkSearch_`)
  that queries Drive (`api=driveSearch`), Gmail (`api=mailSearch`) and the loaded upcoming
  meetings together into `LINK_HITS` (each row typed; `addLinkHit_`), one file input
  (`#linkFile`, `onLinkFilesChosen_`), a pasted URL, and drag/drop onto the task or New Task
  modal (`onLinkDrop_`). The separate mail search box and `runLinkMailSearch_` are gone.
- Uploads: dashboard `attachFiles_(files, target)` -> `shrinkImage_` (images downscaled to
  1600 px JPEG client-side) -> POST `target=upload` `{name, mime, base64}` ->
  `tsgUploadAttachment_` writes the file into an `Attachments` folder under
  `TRACKER_FOLDER_ID` (`tsgAttachmentsFolder_`, created once), 10 MB cap, `tsgSafeFileName_`;
  a pasted image with no name is dated `pasted-YYYY-MM-DD-HHmmss.<ext>` (script time zone).
  The answer `{url, name, mime, type}` lands as a typed docs entry on the target (a pending
  New Task keeps it in the form until save). Ctrl/Cmd-V of an image on an open task card
  attaches to that card (`pastedFiles_`, document paste listener).
- Tests: backend "Attachments and the one docs list"; dashboard unified-picker / upload / paste
  tests. The test `Utilities.formatDate` stub handles `yyyy-MM-dd`, `HH:mm`, `yyyy-MM-dd-HHmmss`.

## Actual time capture and measured reference class (2026-09-17, backend 2026-09-17.7, dashboard UI 2026-09-17.10)

Per Durand: "how are we currently measuring actual time spent on a project?" (nothing was), "build
the timer, but that might not be accurate either cause it relies on me starting and stopping it",
and "update the skill". His Cowork usage readings (87 rows, plan-quota % over time) are NOT effort
data: they give quota burn per active hour, not minutes per turn or concurrency; every capacity
default is still self-reported until session reports or an export feed it.
- One log: `timeLog[]` on tasks and steps, entries `{ts, minutes, kind, source, note?, turns?,
  spanMin?}`; `actualHours` = own log in quarter hours (`tsgActualHoursFromLog_`), `actualSource`
  = last kind; parent total for calibration = own + steps (`tsgItemActualHours_`). `actualHours`
  is in both DIFF_FIELDS lists. NEW op `log_time {id, subIdx?, minutes, kind, source, note?,
  turns?, spanMin?}` (`tsgLogTime_`); kinds timer | manual | session | calendar; a `session`
  entry keeps `turns`/`spanMin` and sums `claudeTurns` on the item, only attention minutes count.
- Dashboard: Actual row on the card (`actualRowHtml_`: total, % of estimate, Start/Stop timer,
  "+ Log time"); `TIMER` in localStorage `tsgTimer` (survives reload), toolbar chip `#timerChip`,
  `logTime_` writes the entry locally with source Durand and saves through the usual replace_all;
  `captureActualOnDone_` runs on every Done path (modal pill, row select, kanban drop, step tick):
  a running timer on the item stops and logs, else with nothing logged the `#actualModal` prompt
  opens prefilled with the estimate (Enter saves, Skip is free); `buildActualsCheck` adds "Log time
  on N tasks finished today" to the Evening Wrap-Up block.
- Calibration: `tsgActualsByType_` (done items with logged time, by taskType, 3+ samples: n,
  median actual hours, median actual/estimate ratio) rides in `tsgBoardContext_().actuals`, in the
  estimator prompt as `ACTUALS_BY_TYPE` whenever `estHours` is needed, and in queued enrich
  requests as `actuals`; the system prompt says measured work beats the table.
- The protocol skill's source of truth is now `skills/tsg-task-tracker-protocol/SKILL.md` in this
  repo (Durand applies it in Cowork; the synced copy there was last revised 2026-09-02 and still
  said assignee/doc/curl). It carries the session effort report and the one estimation workflow.

## Inbox trace and bulk roll-back (2026-09-18, backend 2026-09-18.1, dashboard UI 2026-09-18.1)

Root cause of the raffle session's "silently dropped" bulk (2026-09-18): the deployed backend was
2026-09-17.5 (v66, identical to commit f09c5a1, confirmed with `clasp pull`), which has
`update_subitem` / `judgment` / `request_steps` / `request_tidy` but NOT `log_time` (added in
2026-09-17.7, deploy blocked in the cloud session). The unknown sub-op threw, the whole bulk failed,
and `processInbox_` renamed the file `FAILED-` and TRASHED it, so nothing was visible. `main` is
stale (2026-09-14); everything lives on `claude/affectionate-planck-458f9h`.
- `tsgRestoreDoc_` (in-place restore from a JSON snapshot) rolls back a failing patch, and inside
  `bulk` each failing SUB-OP alone (`err.partial = {applied, errors}` thrown at the end).
  `processInbox_` keeps failing files in `_Inbox` as `FAILED-` / `PARTIAL-` / `MALFORMED-` (never
  trashed, never re-read: the listing skips those prefixes), records every failure in
  `meta.inboxErrors[]` (server-owned with `backendVersion`; cap 30; loads the data file for the
  record on a rulesets-only pass), and writes the data file when anything applied OR an error was
  recorded. Return shape `{ok, applied, partial, failed, malformed}`.
- Unknown-op errors name `TSG_DATA_OPS` and the backend version; `tsgAutoScheduleDoc_` stamps
  `meta.backendVersion` on every write so a session can check what the DEPLOYED script accepts.
- Dashboard: warn alert "N inbox patches failed in the last 7 days" (opens Settings) and a
  Settings > Inbox errors list (`inboxErrorsHtml_`).
- The meeting-slot "third window" test was date-dependent (failed when run on a Friday); it now
  blocks every Mon-Thu day in its range.
- Pending on Durand: `npm run deploy` (backend 2026-09-18.1 / UI 2026-09-18.1 carries 2026-09-17.6
  through .8: one links field, uploads, actual time, inbox trace). After that: drop the log_time
  patch for tasks 281/287 (scratchpad `patch-logtime-281-287.json`) and the deliberately bad
  patch (`patch-verify-bad.json`) to verify a PARTIAL- file + `meta.inboxErrors` entry appear.
- Roll-up fix (backend 2026-09-18.2): the 0.5 h confirm-the-handoff slice (`tsgOpenSubitemHours_`
  and the scheduler's `tsgReserveConfirmCapacity_` sites) applies only to steps delegated to a
  PERSON (`tsgHandoffConfirmNeeded_`), never to Claude or Durand: a Claude step's estimate is
  already his attention. Task 287 rolled up to 4.5 h instead of 2.5 h before this; the next write
  after deploy recomputes it.
- Git mirrors live (2026-09-17 21:55 EDT, per Durand "keep the git up to date with the live
  code"): `scripts/deploy.js` refuses a dirty tree, tags the deployed commit `live` and
  fast-forwards `main` to it. `main` was fast-forwarded by hand to f09c5a1 (the script pulled with
  clasp is byte-identical to it) and `live` tagged there. Times in chat and patch `ts` values are
  America/New_York (the script's time zone); UTC dates had put "2026-09-18" on work done Thursday
  evening 9/17.
- Judgment-queue Routine, checked 2026-09-17 21:55 EDT via list_triggers: it is named "Task
  Tracker Judgement Call" (trig_01QwHu6NY22BZUeNXNcPznkq), cron `30 11 * * 1-5` = ONCE per
  weekday at 7:30 AM Eastern (not hourly as an earlier note said), no connectors stored on the
  Routine, last run 2026-09-17 12:35 PM EDT succeeded. Pending requests wait until the next
  morning unless a session answers them (as this session did for J13/J14).
- DEPLOY CHECKPOINT (Durand, 2026-09-17 22:10 EDT: "add the rule, but I am the checkpoint, you
  have to ask me and we review it together"). `.claude/settings.json` allows `npm run deploy` /
  `npm run push` so the session can ship, but a deploy happens ONLY after a review in chat:
  post the backend/UI versions, the commits since the `live` tag, the test result and anything
  that changes live behavior for the team, then wait for Durand's explicit go in that exchange.
  Never deploy on a standing approval from an earlier turn.
- "Judge now" chip (dashboard UI 2026-09-18.2, per Durand "build the chip"): toolbar `#judgeChip`
  shows "N judgments queued · Judge now" from `meta.judgments` (`pendingJudgments_`,
  `renderJudgeChip_` on every load); click opens a Cowork session with `judgePromptFor_()` (a
  standalone queue-answering prompt: data file id, pending ids, README answer shapes, one bulk
  patch, verify), shift-click opens claude.ai/code with the same prompt. The page never answers
  judgments itself. The Routine cannot be edited by an agent (created via http_api); Durand
  edits its schedule at claude.ai/code/routines.
- Claude-step review minutes (backend 2026-09-18.3, UI 2026-09-18.3, per Durand "add the extra
  minute"): `meta.capacity.claudeReviewMin` (Settings > Capacity, default 5 = one turn, 0 = off) is
  what a finished Claude-delegated step costs Durand the next workday; `tsgReadCapacity_` loads it
  on every write, `tsgOpenSubitemHours_` adds it per open Claude step, `tsgConfirmHoursFor_` gives
  the scheduler's reserve (0.5 h person / Settings figure Claude / 0). First key of the
  Settings-backed capacity values (the rest of the tranche-4 capacity knobs go here too).
- TEAM VIEWS ARE OFF-LIMITS (Durand, 2026-09-17 22:40 EDT: "nothing should be editing the team
  views, I need to build them separately"): do not edit `person.html` or the person-page RPC
  surface in Code.gs (`tsgPersonRpc`, `tsgPersonSlice_`, `TSG_PERSON_*_FIELDS`) in any tranche;
  Durand builds the team views himself. Unchanged since d80f280.
- Review placement (backend 2026-09-18.4, UI 2026-09-18.4, per Durand "same day preferred, at
  completion, if approval is required account for that and a post review update session"): a
  Claude-delegated step's review (`claudeReviewMin`) is reserved on the day it FINISHES, not the
  next workday; a person handoff keeps 0.5 h the next workday. New hand-set field `needsApproval`
  (tasks and steps, in both DIFF_FIELDS, "approval" checkbox beside every delegate select, never
  set by enrichment): the item also gets a post-review update session (`postReviewUpdateMin`,
  default 10) `approvalWaitDays` (default 1) workdays after it finishes, in the roll-up and the
  scheduler (`tsgReserveReviewSlices_`, `tsgAddWorkdays_`). Settings > Capacity holds all three
  (`setCapacityKey` merges one key into `meta.capacity`).
- REVIEW OF DELEGATED WORK LIVES IN THE ADMIN BLOCKS (backend 2026-09-18.5, UI 2026-09-18.5, per
  Durand 2026-09-17 22:50 EDT: "wasn't meant to be a 30 min block each, fit into either the SOD or
  EOD administrative block"). The 0.5 h per-delegated-step confirm cost (roll-up and scheduler) and
  the Claude review minutes as capacity are RETIRED; every earlier note about them is history.
  Dashboard: `delegatedReviewItems(date, 'on'|'before')` lists open delegated items (steps and
  whole tasks) by scheduled end, costed by `reviewPersonMin` / `reviewClaudeMin` (Settings >
  Capacity, default 5 each; legacy `claudeReviewMin` still read); Evening Wrap-Up carries the ones
  ending that day, Morning Admin the older unconfirmed ones (plus the "Confirm delegated work (N
  pending)" roll-up line, evening no longer). A block stretches past 30 min once the load exceeds
  `REVIEW_FREE_MIN` (15) and past `REVIEW_SPLIT_MIN` (45) the list becomes its own `kind: 'review'`
  "Review delegated work" block beside it (rendered like admin). Only real work still costs
  capacity: a Claude item flagged `needsApproval` reserves `postReviewUpdateMin` after
  `approvalWaitDays` (`tsgReserveReviewSlices_`); `tsgHandoffConfirmNeeded_` /
  `tsgTaskHandoffConfirmNeeded_` / `tsgConfirmHoursFor_` are deleted. Live data 2026-09-17: 29 open
  delegated items, 1-3 finishing per day, so the evening block absorbs them at 5 min each.
- Deployed 2026-09-17 23:04 EDT: web app @67 = backend 2026-09-18.5 / UI 2026-09-18.5 = commit
  303357e; `main` fast-forwarded to it. The cloud git proxy refuses `push -f` (403) and appears
  to drop tag refs (`ls-remote --tags` hangs up), so the `live` tag is best-effort and `main`
  is the record of what is deployed; deploy.js now pushes main first and treats the tag as
  optional. Stored `ts` values stay UTC ISO (`...Z`, the format every history line and
  comparison uses); only chat and reports use America/New_York.
- Due-date floor (backend 2026-09-18.6, per Durand 2026-09-17 23:15 EDT on task 288: "it's after
  work hours so how could it be due today"): `tsgEarliestDueIso_` = today while the script-TZ
  clock is before 16:30 on a workday, else the next workday; `tsgApplyEstimateToTask_` pushes any
  proposed `due` below it to the floor with a history note. The Routine session runs on a UTC
  clock, so README/skill now say dates are America/New_York.
- Deployed 2026-09-17 23:30 EDT: web app @68 = backend 2026-09-18.6 (due-date floor), `main` at
  ae02dd5. GitHub reports the repository RENAMED to `tsg-homes/TSG-Task-Tracker` (old name
  redirects); the session's git remote and the CCR repo scope still use `tsg-homes/task-tracker`,
  and Settings > Team > Claude Code repo should say the new name if it is set.
- Settings tabs (UI 2026-09-18.6, per Durand "why is all of that on Team"): Rulesets | Threads |
  Team (roster only) | General (`renderGeneralTab`: Home base, Reminder notifications, Claude Code
  repo, Inbox errors) | Capacity (`renderCapacityTab`: review minutes, approval wait, post-review
  session). The inbox-errors alert opens Settings on General. Backend 2026-09-18.7: filed
  `FAILED-`/`PARTIAL-`/`MALFORMED-` inbox files are trashed by the tracker after
  `TSG_INBOX_KEEP_DAYS` (7); the `meta.inboxErrors` record stays. The session can also trash a
  file itself with the Drive connector (done for the 2026-09-17 test file).
- Time picker (UI 2026-09-18.7, per Durand "the time picker sucks"): every `<input type="time">`
  (modal Due row, subtask rows, the meeting form's Start) is a `timeSelectHtml_` select: "no
  time", quarter-hours 6:00 AM–8:00 PM in 12-hour labels, an off-grid stored value as its own
  option, and "other…" which prompts free text parsed by `parseTimeInput_` (h:mm, hmm, am/pm,
  24-hour). Values stay `HH:mm` 24-hour in the data.
- UI 2026-09-18.8 (per Durand): the Enable-notifications button now reports its outcome
  (`enableNotificationsClick_`, `notifyStateText_`): Chrome refuses notification prompts from
  the Apps Script cross-origin frame, so the request resolves without a prompt and the page says
  toasts plus email reminders are what fire; the button hides once granted. Inbox error messages
  wrap (`.inbox-err`, `pre-wrap`). The "inbox patches failed" alert opens Settings and lands on
  the General tab with the tab highlighted (`openSettings().then(setSettingsTab('general'))`).
- Comments channel (README "Comments are the Durand-to-Claude channel", skill "Comments"): the
  Judge-now prompt's step 4 has every queue-answering session read unresolved non-Claude comments,
  act, reply with add_comment (author Claude, replyTo) and resolve with update_comment. The
  Routine's own prompt is Durand's to edit (agents cannot); it needs the same step. Time select
  is narrower (`select.time-select`, 92 px max).
- UI 2026-09-18.9 / backend 2026-09-18.8 (per Durand): the time picker is two short lists
  (`timeSelectHtml_`: hour none/6 AM–8 PM, minutes :00/:15/:30/:45, off-grid values kept,
  `timePickValue_`, `onTimePick_`, `setTimePick_` for the meeting form's hidden `mfStart`); the
  notifications block is a status line (Enable shows only when the page is top-level and
  undecided: Chrome never prompts inside the Apps Script frame, so a reload cannot trigger it
  either); inbox error rows carry Retry (`retry_filed {file}`: re-applies only the failed sub-ops
  of the filed PARTIAL-/FAILED- copy, trashes it and drops the record on success) and Dismiss
  (`dismiss_inbox_error {file}`), both in `TSG_DATA_OPS`.
- UI 2026-09-18.10 (per Durand): the time picker is a button + pop-over (`openTimePop_`,
  `.time-pop`, hour and minute columns capped at 168 px with scrolling, "no time"; `setTimePick_`
  for the meeting form), never the browser's dropdown. Notifications status line tells how to
  allow the frame's origin by hand (chrome://settings/content/notifications, Add `location.origin`)
  with a Copy-address button and a Test button once granted. Comments panel has "Send N open to
  Claude" (`commentsPromptFor_`, `sendCommentsToClaude`: Cowork deep link, shift = cloud Code)
  carrying every unresolved non-Claude comment with its anchor and the act / reply / resolve rules.
