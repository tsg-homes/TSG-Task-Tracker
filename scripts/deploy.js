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
execFileSync(clasp, ['push'], { stdio: 'inherit', shell: process.platform === 'win32' });
execFileSync(clasp, ['deploy', '-i', id], { stdio: 'inherit', shell: process.platform === 'win32' });
