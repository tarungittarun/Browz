// Dependency policy: the stack must not silently drift back onto versions with known
// advisories. Every rule here was added because the repo actually shipped the bad pin.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const pkg = JSON.parse(read('package.json'));

let pass = 0;
const failures = [];
const check = (ok, msg) => { if (ok) pass++; else failures.push(msg); };

const majorOf = (range) => {
  const m = String(range).match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [+m[1], +m[2], +m[3]] : null;
};
const atLeast = (range, min) => {
  const v = majorOf(range);
  if (!v) return false;
  const [a, b, c] = v;
  const [x, y, z] = min;
  return a > x || (a === x && (b > y || (b === y && c >= z)));
};

// Electron ships the whole renderer. Anything below 42.11.16 lacks the eMudhra
// intermediate-certificate mitigation (CVE-2026-115570) plus dozens of other fixes.
check(atLeast(pkg.devDependencies.electron, [42, 11, 16]),
  `electron must be >= 42.11.16, found ${pkg.devDependencies.electron}`);
check(atLeast(pkg.devDependencies['electron-builder'], [26, 15, 0]),
  `electron-builder must be >= 26.15.0, found ${pkg.devDependencies['electron-builder']}`);

// Without a lockfile every install resolves fresh and the ^ ranges float.
check(fs.existsSync(path.join(root, 'package-lock.json')),
  'package-lock.json is required for reproducible installs');
if (fs.existsSync(path.join(root, 'package-lock.json'))) {
  const lock = JSON.parse(read('package-lock.json'));
  const locked = lock.packages && lock.packages['node_modules/electron'];
  check(Boolean(locked), 'the lockfile must pin electron');
  if (locked) {
    check(atLeast(locked.version, [42, 11, 16]),
      `the lockfile pins electron ${locked.version}, below the fixed line`);
  }
}

// The Android build toolchain compiles the APK that users install.
const agp = read('android/build.gradle').match(/com\.android\.application' version '([\d.]+)'/);
check(Boolean(agp), 'AGP version not found');
if (agp) {
  check(atLeast(agp[1], [8, 7, 0]),
    `Android Gradle Plugin must be >= 8.7.0, found ${agp[1]}`);
}

// GitHub Actions run with repo write access; stale majors are a supply-chain risk.
const workflows = fs.readdirSync(path.join(root, '.github/workflows'))
  .filter((f) => f.endsWith('.yml'));
check(workflows.length > 0, 'no workflows found');

const actionFloor = {
  'actions/checkout': 7,
  'actions/setup-node': 7,
  'actions/setup-java': 6,
  'actions/upload-artifact': 7,
  'gradle/actions/setup-gradle': 6
};
let sawAction = 0;
for (const file of workflows) {
  const src = read(`.github/workflows/${file}`);
  for (const line of src.split('\n')) {
    const m = line.match(/uses:\s*([\w./-]+)@v(\d+)/);
    if (!m) continue;
    sawAction++;
    const [, name, ver] = m;
    if (actionFloor[name] && Number(ver) < actionFloor[name]) {
      failures.push(`${file} uses ${name}@v${ver}; minimum is v${actionFloor[name]}`);
    }
  }
  const nodeMatch = src.match(/node-version:\s*['"]?(\d+)/);
  if (nodeMatch && Number(nodeMatch[1]) < 24) {
    failures.push(`${file} runs Node ${nodeMatch[1]}; Node 20 is end-of-life, use 24+`);
  }
}
check(sawAction > 0, 'no action pins were inspected');

console.log(`Dependency policy: ${pass} checks passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
