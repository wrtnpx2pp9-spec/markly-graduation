'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const skipUI = process.argv.includes('--skip-ui');
const { createReport, acquireRunLock } = require('./release-report.cjs');
const uiSuites = require('./ui-suites.cjs');
let unlock;
try { unlock = acquireRunLock(root); }
catch (error) { console.error(error.message); process.exit(1); }
let evidence, temp;
try {
  evidence = createReport(root, skipUI);
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-release-'));
} catch (error) { unlock(); throw error; }
const { report, directory: output } = evidence;
const steps = [
  ['unit', ['--test', '--test-force-exit']],
  ['preflight', ['scripts/preflight.js']],
  ['operations', ['scripts/ops-smoke.cjs']],
  ...(!skipUI ? uiSuites.map(name => [name, [`scripts/${name}.cjs`]]) : []),
];
async function run(name, args) {
  console.log('[release] Running ' + name);
  const log = fs.createWriteStream(path.join(output, name + '.log'));
  const started = Date.now();
  const child = spawn(process.execPath, ['--no-warnings', ...args], {
    cwd: root,
    env: { ...process.env, DB_PATH: path.join(temp, 'preflight.db'), ILINK_STATE_DIR: path.join(temp, 'ilink'), MARKLY_TEST_OUTPUT_DIR: path.join(output, 'screenshots'), MAINTENANCE_MODE: '0', TZ: process.env.TZ || 'Asia/Shanghai' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10 * 60 * 1000);
  const result = await new Promise(resolve => {
    child.once('error', error => resolve({ code: null, error: error.message }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  await new Promise(resolve => log.end(resolve));
  report.steps.push({ name, ...result, timedOut, elapsedMs: Date.now() - started, log: evidence.relative(path.join(output, name + '.log')) });
  evidence.save();
  console.log(`[release] ${name}: ${result.code === 0 && !timedOut ? 'PASS' : 'FAIL'} (${Date.now() - started}ms)`);
  if (result.code !== 0 || timedOut) throw new Error(name + ' failed; inspect ' + evidence.relative(path.join(output, name + '.log')));
}
(async () => {
  let failure;
  try {
    for (const [name, args] of steps) await run(name, args);
    if (skipUI) console.log('[release] Backend checks passed; UI skipped, full release gate NOT satisfied.');
  } catch (error) {
    failure = error;
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    try {
      evidence.finish(failure);
      if (report.error) process.exitCode = 1;
      console.log('[release] Report: ' + evidence.relative(path.join(output, 'report.json')));
      fs.rmSync(temp, { recursive: true, force: true });
    } finally { unlock(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
