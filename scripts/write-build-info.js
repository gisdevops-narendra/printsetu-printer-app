// Writes build-info.json (bundled into the Printer App by pkg) with this
// build's version: package.json's version plus the last commit that touched
// the Printer App, e.g. "1.0.0+a89e38fe". deploy.sh passes AGENT_BUILD_ID
// (the build container has no .git). Without either, the version is "dev",
// which never updates itself and is never offered as an update.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));
let build = process.env.AGENT_BUILD_ID || '';
if (!build) {
  try {
    build = execSync('git log -1 --format=%h -- .', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    build = '';
  }
}
const info = { version: build ? `${version}+${build}` : 'dev', builtAt: new Date().toISOString() };
fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log(`Printer App version: ${info.version}`);
