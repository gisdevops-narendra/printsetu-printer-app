// Assembles the shop-agnostic release bundles — one per OS — each holding
// the packaged agent binary plus that OS's install/uninstall scripts. The
// backend (printsetu-backend/src/printers) reads these folders at download
// time, drops in a per-shop agent.config.json, and archives it for the
// shopkeeper:
//   release/bundle        Windows  (npm run build:exe)
//   release/bundle-linux  Linux    (npm run build:exe:linux)
// Bundles whose binary hasn't been built are skipped, so re-runs during
// development of just one OS stay fast; this script never repackages the
// binaries itself.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const serviceDir = path.join(root, 'service');

const targets = [
  {
    name: 'Windows',
    binary: path.join(root, 'release', 'PrintSetuAgent.exe'),
    binaryName: 'PrintSetuAgent.exe',
    bundleDir: path.join(root, 'release', 'bundle'),
    scriptsDir: serviceDir,
    scripts: ['Install.bat', 'Uninstall.bat', 'Install-Task.ps1', 'Uninstall-Task.ps1', 'Check-Connection.ps1', 'README.txt'],
    buildCommand: 'npm run build:exe',
  },
  {
    name: 'Linux',
    binary: path.join(root, 'release', 'printsetu-agent-linux'),
    binaryName: 'printsetu-agent',
    bundleDir: path.join(root, 'release', 'bundle-linux'),
    scriptsDir: path.join(serviceDir, 'linux'),
    scripts: ['install.sh', 'uninstall.sh', 'README.txt'],
    buildCommand: 'npm run build:exe:linux',
  },
];

function readBuildVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'build-info.json'), 'utf8')).version || 'dev';
  } catch {
    return 'dev';
  }
}

let built = 0;
for (const target of targets) {
  if (!fs.existsSync(target.binary)) {
    console.warn(`Skipping ${target.name} bundle: ${target.binary} not found (run "${target.buildCommand}").`);
    continue;
  }

  fs.rmSync(target.bundleDir, { recursive: true, force: true });
  fs.mkdirSync(target.bundleDir, { recursive: true });

  const binaryDest = path.join(target.bundleDir, target.binaryName);
  fs.copyFileSync(target.binary, binaryDest);
  fs.chmodSync(binaryDest, 0o755);
  for (const file of target.scripts) {
    fs.copyFileSync(path.join(target.scriptsDir, file), path.join(target.bundleDir, file));
  }

  // Signed before its hash is taken below, so the update check matches the signed file.
  if (target.binaryName.endsWith('.exe')) {
    require('child_process').execFileSync('sh', [path.join(__dirname, 'sign-windows.sh'), binaryDest], { stdio: 'inherit' });
  }

  // What Printer Apps update to automatically (backend: GET /api/agent/update).
  // The version is the one build-info.json gave this binary at build time.
  const binary = fs.readFileSync(binaryDest);
  const version = readBuildVersion();
  fs.writeFileSync(
    path.join(target.bundleDir, 'version.json'),
    JSON.stringify({ version, sha256: crypto.createHash('sha256').update(binary).digest('hex'), size: binary.length }, null, 2) + '\n',
  );
  console.log(`  version ${version}${version === 'dev' ? ' (not offered as an automatic update)' : ''}`);

  console.log(`${target.name} release bundle assembled at ${target.bundleDir}`);
  built++;
}

if (built === 0) {
  console.error('\nERROR: no agent binaries found. Run "npm run build:exe" and/or "npm run build:exe:linux" first.');
  process.exit(1);
}
