// Fetching URLs that USERS supplied (RSS feeds). Everything else in the bot only fetches addresses we chose, so
// this is the one place that has to defend against SSRF: requests to localhost, private networks, link-local and
// cloud-metadata addresses, and redirects or DNS tricks that lead there.
//
// The connection is made to the exact IP we validated (custom `lookup`), so DNS rebinding can't swap in a private
// address between the check and the connect. Redirects are followed by hand so every hop is re-validated.

const dns = require('dns');
const { BlockList, isIP } = require('net');
const { request } = require('./net.js');

const blocked = new BlockList();
for (const [addr, bits] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(addr, bits, 'ipv4');
for (const [addr, bits] of [
    ['::', 96], ['64:ff9b::', 96], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16],
    ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked.addSubnet(addr, bits, 'ipv6');

// IPv4-mapped IPv6 (::ffff:a.b.c.d) is checked against the IPv4 ranges by BlockList itself.
function isBlockedAddress(ip) {
    const fam = isIP(ip);
    if (!fam) return true; // not an IP at all: refuse rather than guess
    return blocked.check(ip, fam === 6 ? 'ipv6' : 'ipv4');
}

const NOT_ALLOWED = 'That feed address is not allowed';

// Throws for anything that isn't a plain public http(s) URL on port 80/443. Returns the parsed URL.
function checkUrl(urlStr) {
    let u;
    try { u = new URL(urlStr); } catch { throw new Error('Invalid feed URL'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(NOT_ALLOWED);
    if (u.username || u.password) throw new Error(NOT_ALLOWED);
    if (u.port && u.port !== '80' && u.port !== '443') throw new Error(NOT_ALLOWED);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!host) throw new Error(NOT_ALLOWED);
    // A literal IP never goes through `lookup`, so it has to be checked here. (The URL parser already rewrites
    // tricks like 2130706433 or 0x7f.1 into dotted form.)
    if (isIP(host) && isBlockedAddress(host)) throw new Error(NOT_ALLOWED);
    return u;
}

function guardedLookup(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
        if (err) return cb(err);
        if (!addrs.length || addrs.some(a => isBlockedAddress(a.address))) {
            const e = new Error(NOT_ALLOWED); e.code = 'EBLOCKED'; return cb(e);
        }
        if (options.all) return cb(null, addrs);
        cb(null, addrs[0].address, addrs[0].family);
    });
}

// Resolves { status, headers, text } like net.request, but only for public addresses and with a small body cap.
async function safeFetchText(urlStr, { headers = {}, maxBytes = 2 * 1024 * 1024, timeoutMs = 15000, maxMs = 30000, maxRedirects = 5 } = {}) {
    let current = urlStr;
    for (let hop = 0; hop <= maxRedirects; hop++) {
        const u = checkUrl(current);
        const res = await request(u.toString(), { headers, timeoutMs, maxMs, maxBytes, lookup: guardedLookup, redirects: 0 });
        if (res.status >= 300 && res.status < 400 && res.headers.location) {
            try { current = new URL(res.headers.location, u).toString(); } catch { throw new Error('Invalid redirect'); }
            continue;
        }
        return res;
    }
    throw new Error('Too many redirects');
}

module.exports = { safeFetchText, isBlockedAddress, checkUrl, guardedLookup };
