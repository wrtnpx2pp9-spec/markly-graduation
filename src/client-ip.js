'use strict';

const net = require('net');

function normalizeIp(value) {
  if (typeof value !== 'string') return null;
  let ip = value.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  if (ip.toLowerCase().startsWith('::ffff:') && net.isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  if(net.isIP(ip)===4)return ip;
  if(net.isIP(ip)!==6||ip.includes('%'))return null;
  const value128=ipv6BigInt(ip);
  if(value128===null)return null;
  if((value128>>32n)===0xffffn){const tail=Number(value128&0xffffffffn);return [24,16,8,0].map(shift=>(tail>>>shift)&255).join('.');}
  return new URL('http://['+ip+']/').hostname.slice(1,-1).toLowerCase();
}

function ipv4Number(ip) { return ip.split('.').reduce((n, part) => (n * 256) + Number(part), 0) >>> 0; }

function ipv6BigInt(ip) {
  const tail = ip.match(/(^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const n = ipv4Number(tail[2]);
    if (tail[2].split('.').some(part => Number(part) > 255)) return null;
    ip = ip.slice(0, tail.index + tail[1].length) + ((n >>> 16).toString(16)) + ':' + (n & 0xffff).toString(16);
  }
  const pieces = ip.toLowerCase().split('::');
  if (pieces.length > 2) return null;
  const parse = part => part ? part.split(':') : [];
  const left = parse(pieces[0]), right = pieces.length === 2 ? parse(pieces[1]) : [];
  if (left.some(x => !/^[0-9a-f]{1,4}$/.test(x)) || right.some(x => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  if (left.length + right.length > 8 || (pieces.length === 2 && left.length + right.length === 8)) return null;
  const groups = pieces.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  if (groups.length !== 8) return null;
  return groups.reduce((n, group) => (n << 16n) | BigInt(`0x${group}`), 0n);
}

function parseNetwork(value) {
  const parts = String(value).trim().split('/');
  if (parts.length > 2) return null;
  if(parts[1]!==undefined&&!/^\d+$/.test(parts[1]))return null;
  const ip = normalizeIp(parts[0]);
  if (!ip) return null;
  const version = net.isIP(ip);
  const bits = parts[1] === undefined ? (version === 4 ? 32 : 128) : Number(parts[1]);
  const max = version === 4 ? 32 : 128;
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  if (version === 4) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return { ip, version, bits, mask, network: ipv4Number(ip) & mask };
  }
  const value128 = ipv6BigInt(ip);
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
  return { ip, version, bits, mask, network: value128 & mask };
}

function inNetwork(ip, network) {
  if (net.isIP(ip) !== network.version) return false;
  if (network.version === 4) return (ipv4Number(ip) & network.mask) === network.network;
  const value = ipv6BigInt(ip);
  return value !== null && (value & network.mask) === network.network;
}

function configuredTrustedProxies(value = process.env.TRUSTED_PROXY_IPS || '') {
  return String(value).split(',').map(parseNetwork).filter(Boolean);
}

function createClientIpResolver(options = {}) {
  const trusted = options.trustedProxies || configuredTrustedProxies(options.config);
  const isTrusted = ip => !!ip && trusted.some(network => inNetwork(ip, network));
  return req => {
    const rawPeer = typeof req?.socket?.remoteAddress === 'string' ? req.socket.remoteAddress.trim() : '';
    const peer = normalizeIp(rawPeer);
    if (!peer || !isTrusted(peer)) return peer || rawPeer || 'unknown';
    const rawHeader = req?.headers?.['x-forwarded-for'];
    if (rawHeader === undefined) return peer;
    const rawEntries = String(rawHeader).split(',').map(entry => entry.trim());
    const forwarded = rawEntries.map(normalizeIp);
    // An invalid hop makes the complete assertion unverifiable; never skip it.
    if (rawEntries.some((entry, i) => !entry || !forwarded[i])) return peer;
    const chain = [...forwarded, peer];
    for (let i = chain.length - 1; i >= 0; i--) if (!isTrusted(chain[i])) return chain[i];
    return chain[0] || peer;
  };
}

module.exports = { createClientIpResolver, configuredTrustedProxies, normalizeIp };
