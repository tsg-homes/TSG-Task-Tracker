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
- The dashboard is a Drive file (`FILE_IDS.html` in Code.gs, id
  `1gvrLx4RcVh3mrnVOeiD5ExSbK9mKUnkv`), not part of the script project. It CANNOT be
  deployed from a cloud session: the exec URL is proxy-blocked, the Google Drive
  connector's update_file only changes title/parent, clasp's token has only `drive.file`
  scope, and Google blocks clasp's OAuth client from requesting the full drive scope
  ("This app is blocked"). Do not add a fetch-from-URL endpoint to Code.gs to work around
  this (denied 2026-09-14 as a remote-code-loading surface). Durand deploys it from his
  machine with the README curl; give him the exact commands with the commit sha.

- `npm run push` = `clasp push` (Code.gs + appsscript.json only; see .claspignore).
- `npm run deploy` = push + `clasp deploy -i <web-app deployment ID>`. Never run bare
  `clasp deploy`; it mints a new deployment with a new URL.
- Deploying changes live behavior for the team. Confirm with Durand before running it
  unless the task explicitly asks for a deploy.
- `.clasp.json` is gitignored. In a fresh clone, recreate it with
  `clasp clone <Script ID>` into a scratch folder and copy the `.clasp.json` over, or
  write it by hand with the Script ID above.

## Cloud (Claude Code on the web) session facts

- clasp credentials do not persist between cloud sessions. Each session needs
  `clasp login --no-localhost`: Claude prints the URL, Durand authorizes as
  durand@thestawaszgroup.com, and pastes back the `http://localhost:8888/?...code=...` URL.
- The cloud session's outbound proxy blocks `script.google.com`. The exec URL cannot be
  smoke-tested from a cloud session, and the README's `curl ... ?target=html` dashboard
  deploy must run from a local machine. clasp works because it uses googleapis.com.
- Work on the branch the session names; never push to main without being told.

## Email and other outward actions

- **Draft, never send.** An email goes out only when Durand's message for that specific
  email says "send". Choosing a recipient, a channel or a method is not a send instruction;
  "draft", "write", "prepare" and silence all mean draft — create it in Gmail and say where
  it is. Same bar for any outward action that cannot be undone: a post, a share, a delete.
  (Established 2026-09-18 after a session sent a brief to Marj and Ryan when Durand had only
  picked the send method for a different email.)
