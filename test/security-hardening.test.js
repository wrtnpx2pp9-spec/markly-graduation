'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createClientIpResolver } = require('../src/client-ip');
const { parseRequestUrl } = require('../server');

function rawHttp(port, host) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, '127.0.0.1'); let data = '';
    socket.setTimeout(4000, () => { socket.destroy(); reject(new Error('HTTP test timeout')); });
    socket.on('error', reject).on('data', chunk => { data += chunk; }).on('close', () => resolve(data));
    socket.on('connect', () => socket.write(`GET ${host.path || '/'} HTTP/1.1\r\nHost: ${host.name || host}\r\nConnection: close\r\n\r\n`));
  });
}

test('malformed Host URL is rejected without throwing, valid URL still parses', () => {
  assert.equal(parseRequestUrl({ url: '/', headers: { host: '[' } }), null);
  assert.equal(parseRequestUrl({ url: '/health?ok=1', headers: { host: 'localhost:8787' } }).pathname, '/health');
});

test('HTTP malformed Host returns 400 and the subprocess remains usable', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-http-url-'));
  const child = spawn(process.execPath, ['--no-warnings', 'server.js'], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, DB_PATH: path.join(tmp, 'app.db'), PORT: '0', HOST: '127.0.0.1', ILINK_STATE_DIR: tmp },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server startup timeout')), 5000);
      child.stdout.on('data', chunk => { const match = String(chunk).match(/本机访问:\s+http:\/\/127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(Number(match[1])); } });
      child.once('error', reject); child.once('exit', code => reject(new Error(`server exited ${code}`)));
    });
    assert.match(await rawHttp(port, { name: '[', path: '/api/tasks' }), /^HTTP\/1\.1 400 /);
    assert.match(await rawHttp(port, { name: 'localhost', path: '/api/tasks' }), /^HTTP\/1\.1 401 /);
    assert.equal(child.exitCode, null);
  } finally {
    if(child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited;}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('forwarded client IP is used only through configured trusted proxy', () => {
  const direct = createClientIpResolver();
  assert.equal(direct({ socket: { remoteAddress: '203.0.113.10' }, headers: { 'x-forwarded-for': '198.51.100.2' } }), '203.0.113.10');
  const proxied = createClientIpResolver({ config: '10.0.0.0/8' });
  assert.equal(proxied({ socket: { remoteAddress: '10.2.3.4' }, headers: { 'x-forwarded-for': '198.51.100.2, 10.1.1.1' } }), '198.51.100.2');
});

test('IPv6 CIDR boundaries, invalid config and forged invalid chains are conservative', () => {
  const edge = createClientIpResolver({ config: '2001:db8::/127,not-an-ip/99' });
  const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': xff } });
  assert.equal(edge(req('2001:db8::1', '198.51.100.5')), '198.51.100.5');
  assert.equal(edge(req('2001:db8::2', '198.51.100.5')), '2001:db8::2');
  assert.equal(edge(req('2001:db8::2', '198.51.100.5')), '2001:db8::2');
  const half = createClientIpResolver({ config: '8000::/1' });
  assert.equal(half(req('8000::1', '198.51.100.5')), '198.51.100.5');
  assert.equal(half(req('7fff::1', '198.51.100.5')), '7fff::1');
  assert.equal(edge(req('2001:db8::1', '198.51.100.5,not-an-ip')), '2001:db8::1');
  assert.equal(edge(req('2001:db8::1', '198.51.100.5, ')), '2001:db8::1');
});

test('malformed CIDR suffixes do not expand trust and equivalent addresses share keys',()=>{
  const req=(peer)=>({socket:{remoteAddress:peer},headers:{'x-forwarded-for':'198.51.100.8'}});
  for(const config of ['127.0.0.1/','127.0.0.1/0x0','fe80::1%eth0'])assert.equal(createClientIpResolver({config})(req('127.0.0.1')),'127.0.0.1');
  const direct=createClientIpResolver({config:''});
  assert.equal(direct(req('0:0:0:0:0:ffff:c000:201')),'192.0.2.1');
  assert.equal(direct(req('2001:0db8:0:0:0:0:0:1')),'2001:db8::1');
});
