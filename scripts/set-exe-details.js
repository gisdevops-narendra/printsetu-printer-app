// Gives PrintSetuAgent.exe its Windows "Details" (product name, version,
// company, description), which Windows shows in Properties and code-signing
// services such as SignPath require.
//
// pkg builds the exe by appending the app to a prebuilt Node binary and
// remembers where the app starts, so the finished exe can't be edited
// afterwards. Instead this edits the Node binary BEFORE pkg uses it: pkg-fetch
// uses a "built-*" binary (without checking its hash) when there is no
// "fetched-*" one, so the edited copy is saved as built-* and fetched-* is
// removed. The untouched download is kept as built-*.orig and every run starts
// again from it, so the version is always current.
//
//   node scripts/set-exe-details.js   (npm run build:exe runs it)
const fs = require('fs');
const path = require('path');
const ResEdit = require('resedit');
const { need } = require('pkg-fetch');
const { cachePath } = require('pkg-fetch/lib-es5/places');

const NODE_RANGE = 'node18';
const PLATFORM = 'win';
const ARCH = 'x64';

const root = path.join(__dirname, '..');
const { version } = require(path.join(root, 'package.json'));

// The untouched Node binary for Windows, downloaded (and hash-checked) by
// pkg-fetch the first time and then kept as built-*.orig.
async function pristineBinary() {
  const tag = `v${require('pkg-fetch/package.json').version.split('.').slice(0, 2).join('.')}`;
  const dir = path.join(cachePath, tag);
  const pattern = new RegExp(`^built-v18\\.[\\d.]+-${PLATFORM}-${ARCH}\\.orig$`);
  const kept = fs.existsSync(dir) && fs.readdirSync(dir).find((name) => pattern.test(name));
  if (kept) return path.join(dir, kept);
  const fetched = await need({ nodeRange: NODE_RANGE, platform: PLATFORM, arch: ARCH, forceFetch: true });
  const pristine = path.join(path.dirname(fetched), `${path.basename(fetched).replace(/^fetched-/, 'built-')}.orig`);
  fs.copyFileSync(fetched, pristine);
  return pristine;
}

async function main() {
  const pristinePath = await pristineBinary();
  const builtPath = pristinePath.replace(/\.orig$/, '');
  const fetchedPath = path.join(path.dirname(builtPath), path.basename(builtPath).replace(/^built-/, 'fetched-'));

  const exe = ResEdit.NtExecutable.from(fs.readFileSync(pristinePath));
  const res = ResEdit.NtExecutableResource.from(exe);
  const infos = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const info = infos[0] || ResEdit.Resource.VersionInfo.createEmpty();
  const [major, minor, patch] = version.split('.').map((n) => parseInt(n, 10) || 0);
  const lang = { lang: 1033, codepage: 1200 }; // English (US), Unicode
  // Replace Node.js's own details (it ships with "Node.js" as the product).
  for (const existing of info.getAllLanguagesForStringValues()) info.removeAllStringValues(existing);
  info.setStringValues(lang, {
    ProductName: 'PrintSetu Printer App',
    FileDescription: 'PrintSetu Printer App',
    CompanyName: 'PrintSetu',
    LegalCopyright: 'Copyright 2026 PrintSetu. Apache License 2.0.',
    OriginalFilename: 'PrintSetuAgent.exe',
    InternalName: 'PrintSetuAgent',
    ProductVersion: version,
    FileVersion: version,
  });
  info.setFileVersion(major, minor, patch, 0, lang.lang);
  info.setProductVersion(major, minor, patch, 0, lang.lang);
  info.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(builtPath, Buffer.from(exe.generate()));
  // Without a fetched-* binary, pkg uses the edited built-* one.
  if (fs.existsSync(fetchedPath)) fs.unlinkSync(fetchedPath);
  console.log(`Printer App exe details: PrintSetu Printer App ${version}`);
}

main().catch((error) => {
  console.error('set-exe-details:', error.message || error);
  process.exit(1);
});

