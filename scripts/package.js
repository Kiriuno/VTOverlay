// Builds Windows apps into dist/.
//   node scripts/package.js full     -> dist/VTOverlay-win32-x64          (broadcast + view)
//   node scripts/package.js viewer   -> dist/VTOverlay-Viewer-win32-x64   (view only, smaller, no webcam code)
//   node scripts/package.js full viewer   -> both
//   add --zip to also write release zips (dist/VTOverlay-win32-x64.zip, …), what GitHub releases need
//   add --platform=linux to build for another OS (used to test the updater)
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

// paths are relative to the project root and start with "/"
const ALWAYS_IGNORED = [/^\/dist(\/|$)/, /^\/out(\/|$)/, /^\/scripts(\/|$)/, /^\/\.git(\/|$)/, /\.map$/];
const VIEWER_IGNORED = [/^\/src\/sender\.(html|js)$/, /^\/node_modules\/@mediapipe(\/|$)/];

const TARGETS = {
  full: { name: 'VTOverlay', ignore: ALWAYS_IGNORED, receiverOnly: false },
  viewer: { name: 'VTOverlay-Viewer', ignore: [...ALWAYS_IGNORED, ...VIEWER_IGNORED], receiverOnly: true },
};

const PLATFORM = (process.argv.find((a) => a.startsWith('--platform=')) || '--platform=win32').split('=')[1];
const ZIP = process.argv.includes('--zip');

async function build(key) {
  const { packager } = await import('@electron/packager');
  const t = TARGETS[key];
  if (!t) throw new Error(`Unknown target "${key}" (use: ${Object.keys(TARGETS).join(', ')})`);
  console.log(`\n▶ Building ${t.name} …`);
  const [out] = await packager({
    dir: ROOT,
    name: t.name,
    executableName: t.name,
    platform: PLATFORM,
    arch: 'x64',
    out: path.join(ROOT, 'dist'),
    overwrite: true,
    prune: true,
    asar: true,
    appVersion: pkg.version,
    icon: path.join(ROOT, 'assets', 'icon.ico'),
    win32metadata: { ProductName: t.name.replace('-', ' '), FileDescription: t.name.replace('-', ' '), CompanyName: 'VTOverlay' },
    ignore: (p) => t.ignore.some((re) => re.test(p.replace(/\\/g, '/'))),
    afterCopy: [async ({ buildPath }) => {
      // mark the build so main.js knows whether to offer "Broadcast"
      const file = path.join(buildPath, 'package.json');
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      json.vtReceiverOnly = t.receiverOnly;
      json.productName = t.name.replace('-', ' ');
      fs.writeFileSync(file, JSON.stringify(json, null, 2));
    }],
  });
  fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(out, 'README.md'));
  console.log(`✔ ${t.name} → ${path.relative(ROOT, out)}`);
  if (ZIP) {
    // zip = one top-level folder, named exactly as the updater expects: <Name>-<platform>-<arch>.zip
    const zipFile = out + '.zip';
    fs.rmSync(zipFile, { force: true });
    const { execFileSync } = require('child_process');
    if (process.platform === 'win32') {
      // Windows 10+ ships bsdtar; unlike Compress-Archive it always writes forward slashes in zip paths
      execFileSync('tar', ['-a', '-c', '-f', zipFile, path.basename(out)], { cwd: path.dirname(out), stdio: 'inherit' });
    } else {
      execFileSync('zip', ['-qry', zipFile, path.basename(out)], { cwd: path.dirname(out), stdio: 'inherit' });
    }
    console.log(`✔ zipped → ${path.relative(ROOT, zipFile)}`);
  }
}

(async () => {
  const keys = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  for (const k of keys.length ? keys : ['full']) await build(k);
})().catch((err) => { console.error(err); process.exit(1); });
