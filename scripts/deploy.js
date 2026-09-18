// Push Code.gs and republish the EXISTING web-app deployment (same exec URL).
//
// The deployment id IS the exec URL (…/macros/s/<id>/exec), and the exec URL is the only
// credential an anonymous-access web app really has — so it is deliberately not committed.
// It lives in .tracker-ids.json (gitignored) next to this repo's package.json:
//   { "webAppDeploymentId": "<id>" }
// To recover it: `clasp deployments` lists two ids; take the one that is NOT "@HEAD".
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const idsPath = path.join(__dirname, '..', '.tracker-ids.json');
if (!fs.existsSync(idsPath)) {
  console.error('deploy: missing ' + idsPath + '\n' +
    '  Run `clasp deployments`, take the id that is NOT @HEAD, and write\n' +
    '  {"webAppDeploymentId":"<id>"} to that file (it is gitignored).');
  process.exit(1);
}
const ids = JSON.parse(fs.readFileSync(idsPath, 'utf8'));
const id = ids && ids.webAppDeploymentId;
if (!id || !/^[A-Za-z0-9_-]{20,}$/.test(id)) {
  console.error('deploy: .tracker-ids.json has no valid webAppDeploymentId');
  process.exit(1);
}
const clasp = process.platform === 'win32' ? 'clasp.cmd' : 'clasp';
// -f: clasp prompts before overwriting a changed manifest (appsscript.json) and, with no
// TTY, silently answers "no" and still exits 0 — which once deployed stale code as a new
// version (2026-09-14). The manifest in this repo is the source of truth, so always force.
// Git must match what is live (Durand, 2026-09-17): a deploy from a dirty tree would put
// code in production that no commit holds, so it is refused unless --allow-dirty is given.
// After a successful deploy the commit is tagged `live` (moved each time, pushed with -f)
// and `main` is fast-forwarded to it, so `main` == the deployed script at all times.
const allowDirty = process.argv.includes('--allow-dirty');
const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
let dirty = '';
try { dirty = git(['status', '--porcelain', '--', 'Code.gs', 'appsscript.json', 'dashboard_final.html', 'person.html']); } catch (e) { dirty = ''; }
if (dirty && !allowDirty) {
  console.error('deploy: refused, uncommitted changes in the files clasp pushes:\n' + dirty + '\n  Commit first (git must match live), or pass --allow-dirty.');
  process.exit(1);
}
execFileSync(clasp, ['push', '-f'], { stdio: 'inherit', shell: process.platform === 'win32' });
execFileSync(clasp, ['deploy', '-i', id], { stdio: 'inherit', shell: process.platform === 'win32' });
if (!dirty) {
  // main first (the part that matters: main == the deployed script), tag second and
  // best-effort: the git proxy in cloud sessions refuses force pushes and drops tag
  // refs, so a failed tag push is logged, never fatal.
  const head = git(['rev-parse', 'HEAD']);
  try {
    execFileSync('git', ['push', 'origin', head + ':main'], { stdio: 'inherit' });
    console.log('deploy: main fast-forwarded to ' + head.slice(0, 7));
  } catch (e) {
    console.error('deploy: could not fast-forward main to ' + head.slice(0, 7) + ' (diverged?). Merge main by hand.');
  }
  try {
    git(['tag', '-f', 'live', head]);
    execFileSync('git', ['push', 'origin', ':refs/tags/live'], { stdio: 'ignore' });
    execFileSync('git', ['push', 'origin', 'refs/tags/live'], { stdio: 'ignore' });
    console.log('deploy: tag live moved to ' + head.slice(0, 7));
  } catch (e) {
    console.error('deploy: tag live could not be pushed (' + (e.message || e).split('\n')[0] + '); main is the record.');
  }
}
