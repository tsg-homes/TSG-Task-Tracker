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

## Cloud (Claude Code on the web) session facts

- clasp credentials do not persist between cloud sessions. Each session needs
  `clasp login --no-localhost`: Claude prints the URL, Durand authorizes as
  durand@thestawaszgroup.com, and pastes back the `http://localhost:8888/?...code=...` URL.
- The cloud session's outbound proxy blocks `script.google.com`. The exec URL cannot be
  smoke-tested from a cloud session; ask Durand to load it. clasp works because it uses
  googleapis.com.
- Work on the branch the session names; never push to main without being told.
