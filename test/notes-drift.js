// The notes are a document, and documents rot. This test fails if WORKING-NOTES.md
// stops matching the shipped code: every settings switch must be documented, and the
// persona table must agree with the persona constructor.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const notes = read('WORKING-NOTES.md');
const java = read('android/app/src/main/java/com/browz/mobile/MainActivity.java');

let pass = 0;
const failures = [];
const check = (ok, msg) => { if (ok) pass++; else failures.push(msg); };

// 1. Every switch in the UI must appear in the notes, verbatim.
const labels = [...java.matchAll(/makeCheck\("([^"]+)"/g)].map((m) => m[1]);
check(labels.length > 0, 'no settings switches found in the code');
const missing = labels.filter((l) => !notes.includes(l));
check(missing.length === 0,
  `settings switches missing from the notes: ${missing.join(' | ')}`);

// 2. Defaults documented as On/Off must match the compiled default.
const defaults = [
  ['WebSockets', 'blockWebSockets = false'],
  ['screenshots', 'screenSecurityFlag = true'],
  ['downloads', 'blockDownloads = true'],
  ['probe', 'probeStatuses = true'],
  ['url params', 'stripUrlParams = true'],
  ['https', 'forceHttps = true'],
  ['canvas', 'shieldCanvas = true'],
  ['fonts', 'shieldFonts = true'],
  ['webRTC', 'shieldWebRTC = true'],
  ['file picker', 'blockFileSystemAccess = true']
];
for (const [name, decl] of defaults) {
  check(java.includes(decl), `${name}: expected "${decl}" in MainActivity`);
}

// 3. The persona hardware table must agree with the constructor.
check(java.includes('this.cores = isMobile ? 8 : 16'), 'core counts changed; update the persona table');
check(java.includes('this.touchPoints = isMobile ? 5 : 0'), 'touch points changed; update the persona table');
check(java.includes('this.pixelRatio = isMobile ? "3" : "1"'), 'pixel ratio changed; update the persona table');
check(notes.includes('| 16 |'), 'the notes must show 16 cores for the desktop persona');
check(notes.includes('| 5 |'), 'the notes must show 5 touch points for mobile personas');

// 4. Limits.
check(java.includes('Limit of 12 containers reached') === notes.includes('up to 12'),
  'container limit documented differently from the code');

// 5. Stale claims: these must never come back.
for (const dead of ['__BROWZ_MOBILE_SHIELD_ACTIVE__', "Object.defineProperty(window, 'BrowzNative'"]) {
  check(!java.includes(dead), `removed marker returned to the code: ${dead}`);
}

// 6. The notes must keep an explicit unfinished list; a doc that hides TODOs is worse
//    than no doc.
check(/## 5\. Unfinished/.test(notes), 'the notes lost their unfinished section');
check((notes.match(/^### U\d+\./gm) || []).length >= 5,
  'the unfinished list shrank; keep the open options documented');

console.log(`Notes drift: ${pass} checks passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
