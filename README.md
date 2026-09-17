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

- **Reads**: fetch `Systems — Task Tracker Data — TSG.json` (`1SRdNiNhHdAfaB-agj9OcXRIPA5xNLidt`)
  or `Systems — Task Tracker Rulesets.json` (`1RKkNUEfh6Q0qlQXbNlME7aIfh_h8FE-R`) directly
  from Drive. `?api=data` / `?api=rulesets` are for the signed-in dashboard only.
- **Writes**: unchanged — drop a patch file into `_Inbox` (`1-xBA0xRiqAcJ8btUAPUOouwNGKXY2_Pi`).
  A one-minute time-driven trigger (`tsgInboxTick`) applies it; nothing needs to poke
  `?api=sync` any more. Verify by re-reading the Drive file after a minute.
- **No curl to the exec URL from anything that isn't a browser session.** It will get a
  Google sign-in page, not JSON.

Switching the access mode: change `TSG_ACCESS_MODE` in `Code.gs` AND `webapp.access` in
`appsscript.json` together (`npm test` fails if they disagree), deploy, then run
`tsgInstallInboxTrigger` once from the Apps Script editor to authorize the new scopes and
install the trigger.

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
  Candidates are gathered on EVERY pass, whatever is already linked (2026-09-17).
  Read `EXISTING_GROUPS` / `OPEN_TASK_TITLES` / `EXISTING_TAGS` from the data file itself.
- `kind: "progress"` — legacy; answer `{progress}` from the notes only.

**Answer op** (one per request, in a `bulk` data patch dropped into `_Inbox`):

```json
{"target":"data","op":"bulk","source":"Claude (queue)","ops":[
  {"op":"judgment","id":"J17","answer":{"title":"Send Farina the listing agreement for signature",
   "notes":"Current state: …\n\nLog:\n- 2026-09-16: …","estHours":0.5,"taskType":"Email",
   "subitems":[{"title":"Chase the signed copy","estHours":0.25,"taskType":"Email","priority":"High"}],
   "steps":[{"index":0,"title":"Draft the agreement","notes":"Current state: drafted.","estHours":0.5,"taskType":"Actionable Task","priority":"High","tags":[],"progress":100,"location":null,"due":null}],
   "priority":"High","group":"Ops","dependsOnTitle":null,"tags":["Listings"],
   "progress":25,"location":"Farina Di Vita, Media PA","due":"2026-09-19","needsConfirmation":false,
   "driveMatch":{"index":1,"confident":true,"rationale":"…"},"meetingMatch":null,
   "mailMatch":{"index":2,"confident":true,"rationale":"…"},
   "webLinks":[{"url":"https://www.usps.com/business/web-tools-apis/address-information-api.htm","label":"USPS Address API"}],"rationale":"…"}},
  {"op":"judgment","id":"J18","answer":{"progress":60}}
]}
```

Rules are the estimator's own (`TSG_ESTIMATE_SYSTEM` in `Code.gs`): only fields in `need`;
`title` one imperative line, max 80 chars, derived from a free-flow note when the title is a
placeholder; `notes` rewritten as "Current state" + dated "Log" keeping every fact verbatim;
hours are hands-on time from the calibration table; `taskType` one of Email | Call |
Text/Chat | Meeting | Claude | Actionable Task; `priority` one of Critical | High | Medium |
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
