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
- `dashboard_final.html` — the single-file dashboard (HTML/CSS/JS) served by `doGet`. Stored
  as a file in the tracker's Drive folder, not bound to the Apps Script project itself — it
  already deploys with a plain `curl` (see **Deploying** below), no manual step needed.
- `test/test_codegs.js` — Node `vm`-based unit tests for `Code.gs`. Loads the file into a
  sandboxed context with stubbed Apps Script globals (`DriveApp`, `CalendarApp`, `Utilities`,
  `PropertiesService`, etc.) and a controllable fake Claude responder, so `applyDataPatch` and
  friends can be exercised without touching the live Drive/Calendar/Anthropic API.
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

**`dashboard_final.html`** already has a zero-friction deploy path — push it straight to Drive
with:

```
curl "<exec URL>?target=html" --data-binary @dashboard_final.html -H 'Content-Type: text/plain'
```

**`Code.gs`** is the one that has historically required a manual round-trip: paste it into the
Apps Script editor, then *Manage deployments → Edit → New version → Deploy*. That friction —
and the fact that a Claude session has no way to confirm a `Code.gs` change actually went live
after handing over the file — is exactly what moving this repo under Claude Code + `clasp`
(Google's official Apps Script CLI) is meant to close: `clasp push` uploads `Code.gs` straight
into the live Apps Script project, and `clasp deploy -i <deploymentId>` republishes the
*existing* deployment (same exec URL) instead of minting a new one.

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
there's no reason to commit it). `.claspignore` limits what `clasp push` uploads to `Code.gs`
and `appsscript.json` — the dashboard HTML and `test/` must never be pushed into the script
project. After
cloning, this repo's `Code.gs` is the version to keep — overwrite the cloned copy with it, then:

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
cloud session's outbound proxy blocks `script.google.com`, so the `curl ... ?target=html`
dashboard deploy and any exec-URL smoke test have to run from a local machine.

**Version indicator.** `Code.gs` carries `TSG_CODE_VERSION` and `dashboard_final.html`
carries `UI_VERSION` (both `YYYY-MM-DD.n`). Bump the one you're deploying, every time. The
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
