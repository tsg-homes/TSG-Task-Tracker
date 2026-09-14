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
  enforces it). Under `ANONYMOUS`, any `Session.getActiveUser()` call aborts the request
  with Google's "Sorry, unable to open the file" page (verified live 2026-09-14). Under
  `DOMAIN`, every request carries the signed-in TSG account: `tsgIsOwnerEmail_` gets the
  full dashboard, every other organization account gets `tsgPersonPlaceholderHtml_` (later:
  the per-person view). thestawaszgroup.com and tsg.homes are one Workspace (alias).
- Roster mapping: explicit roster `email` wins, else `firstname@<tsg domain>` matches the
  roster name case-insensitively (`tsgRosterNameForEmail_`).
- DOMAIN switch runbook (first deploy of 2026-09-14.10): (1) `npm run deploy`; (2) Durand
  opens the Apps Script editor, Run > `tsgInstallInboxTrigger`, accepts the new scopes —
  this both authorizes the deployment and installs the 1-minute `tsgInboxTick` trigger;
  (3) Durand loads the exec URL signed in and sees the dashboard; (4) a teammate loads it
  and sees the placeholder. Rollback: `clasp deploy -i <id> -V <previous version>`.
- After the switch, automation must not use the exec URL: read the Data/Rulesets files
  from Drive by id and write via `_Inbox` patches, which the trigger applies within a
  minute. `?api=sync` is no longer needed or reachable without a Google login.

## Cloud (Claude Code on the web) session facts

- clasp credentials do not persist between cloud sessions. Each session needs
  `clasp login --no-localhost`: Claude prints the URL, Durand authorizes as
  durand@thestawaszgroup.com, and pastes back the `http://localhost:8888/?...code=...` URL.
- The cloud session's outbound proxy blocks `script.google.com`. The exec URL cannot be
  smoke-tested from a cloud session; ask Durand to load it. clasp works because it uses
  googleapis.com.
- Work on the branch the session names; never push to main without being told.
