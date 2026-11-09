'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
const suites = require('./ui-suites.cjs');
const root = path.resolve(__dirname, '..');

(async () => {
  for (const name of suites) {
    const started = Date.now();
    console.log(`[ui] Running ${name}`);
    const child = spawn(process.execPath, ['--no-warnings', `scripts/${name}.cjs`], {
      cwd: root, stdio: 'inherit',
      env: { ...process.env, MAINTENANCE_MODE: '0', TZ: process.env.TZ || 'Asia/Shanghai' },
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10 * 60 * 1000);
    const result = await new Promise(resolve => {
      child.once('error', error => resolve({ code: null, error }));
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timer);
    if (timedOut || result.code !== 0) throw new Error(`${name} failed${timedOut ? ' (timeout)' : ''}: ${result.error?.message || result.signal || result.code}`);
    console.log(`[ui] ${name}: PASS (${Date.now() - started}ms)`);
  }
  console.log(`[ui] All ${suites.length} browser suites passed.`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
