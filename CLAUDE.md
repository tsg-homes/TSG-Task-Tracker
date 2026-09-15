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
  dashboard; owner + `?person=<Name>` previews that person's page; the parameter was `as` until 2026-09-15, which Google's front end rejected before doGet ran, showing "Sorry, unable to open the file"). Placeholders stamped at
  serve time: `__TSG_PERSON__`, `__TSG_AS__`, `__TSG_CODE_VERSION__`. No token, no URL.
- Server decides everything: `tsgPersonSlice_` (own tasks by `owner`, tasks by `assignee`,
  subitems by `delegate`), `tsgPersonRpc(action, payloadJson)` with `load | update | add |
  version`. Own tasks: title/status/priority/progress/due/notes. Delegated: status/
  progress/notes only; anything else is refused server-side. Writes are single-item ops
  through `tsgQueueDataPatch_` (`update_task`, new `update_subitem` with an `expectTitle`
  guard, `add_task` with `skipEnrich`/`skipDedup`). Person-created tasks: owner and
  assignee = name, group = name, tag `Self-created`.
- Bump `PERSON_UI_VERSION` in person.html when it changes. Tests: `test/test_person.js`.

## Cloud (Claude Code on the web) session facts

- clasp credentials do not persist between cloud sessions. Each session needs
  `clasp login --no-localhost`: Claude prints the URL, Durand authorizes as
  durand@thestawaszgroup.com, and pastes back the `http://localhost:8888/?...code=...` URL.
- The cloud session's outbound proxy blocks `script.google.com`. The exec URL cannot be
  smoke-tested from a cloud session; ask Durand to load it. clasp works because it uses
  googleapis.com.
- Work on the branch the session names; never push to main without being told.
