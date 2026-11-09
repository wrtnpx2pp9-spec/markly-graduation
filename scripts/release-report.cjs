'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function acquireRunLock(root) {
  const output = path.join(root, 'output', 'release');
  fs.mkdirSync(output, { recursive: true });
  const lock = path.join(output, '.run.lock');
  const owner = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: crypto.randomUUID() });
  try { fs.writeFileSync(lock, owner, { flag: 'wx' }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Release check already locked: ' + lock + '. If a previous run was interrupted, verify its PID has exited before removing this lock.');
    throw error;
  }
  return () => {
    try { if (fs.readFileSync(lock, 'utf8') === owner) fs.unlinkSync(lock); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}

function sourceDigest(root) {
  const hash = crypto.createHash('sha256');
  function visit(relative) {
    const full = path.join(root, relative);
    if (!fs.existsSync(full)) return;
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(full).sort()) visit(path.join(relative, name));
    } else if (stat.isFile()) {
      hash.update(relative.replaceAll(path.sep, '/') + '\0');
      hash.update(fs.readFileSync(full));
      hash.update('\0');
    }
  }
  // Deployment inputs are part of the verified release; never hash the real .env or runtime data.
  for (const name of ['package.json', 'package-lock.json', 'server.js', 'src', 'public', 'scripts', 'test', 'deploy', 'Dockerfile', 'compose.yaml', '.dockerignore', '.env.example']) visit(name);
  return hash.digest('hex');
}

function createReport(root, skipUI = false) {
  const startedAt = new Date().toISOString();
  const runId = startedAt.replace(/[:.]/g, '-') + '-' + process.pid + '-' + crypto.randomBytes(3).toString('hex');
  const output = path.join(root, 'output', 'release');
  const directory = path.join(output, 'runs', runId);
  fs.mkdirSync(directory, { recursive: true });
  const relative = full => path.relative(root, full).replaceAll(path.sep, '/');
  const report = {
    runId, startedAt, node: process.version, platform: process.platform,
    status: 'running', passed: false, uiRequired: true, uiSkipped: skipUI,
    sourceDigest: null, evidenceDirectory: relative(directory), steps: [],
  };
  function atomicWrite(destination, contents) {
    const temporary = destination + '.' + runId + '.tmp';
    fs.writeFileSync(temporary, contents);
    fs.renameSync(temporary, destination);
  }
  function save(initial = false) {
    const contents = JSON.stringify(report, null, 2) + '\n';
    atomicWrite(path.join(directory, 'report.json'), contents);
    const latest = path.join(output, 'report.json');
    // release-check holds an exclusive run lock for the entire verification.
    // This extra check also avoids sequential updates from an older handle.
    let current;
    try { current = JSON.parse(fs.readFileSync(latest, 'utf8')); } catch {}
    if (initial || !current || current.runId === runId) atomicWrite(latest, contents);
  }
  function finish(error) {
    report.finishedAt = new Date().toISOString();
    report.finalSourceDigest = sourceDigest(root);
    if (error) report.error = error.message || String(error);
    if (report.finalSourceDigest !== report.sourceDigest) report.error = 'Source changed during verification; rerun against a stable working tree.';
    report.passed = !report.error && !skipUI;
    report.status = report.error ? 'failed' : skipUI ? 'incomplete' : 'passed';
    save();
    return report.passed;
  }
  // Invalidate the old PASS even if reading the source fails or is interrupted.
  save(true);
  try {
    report.sourceDigest = sourceDigest(root);
    save();
  } catch (error) {
    report.status = 'failed';
    report.error = 'Cannot snapshot source: ' + error.message;
    report.finishedAt = new Date().toISOString();
    save();
    throw error;
  }
  return { report, directory, relative, save, finish };
}
module.exports = { createReport, sourceDigest, acquireRunLock };
