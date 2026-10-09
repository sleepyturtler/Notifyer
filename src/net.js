// HTTP helpers (postForm/postJson/fetchJson/fetchText) and the shared XML parser.
// All four go through one request() so timeouts, size caps and mid-response
// connection drops are handled in exactly one place.

const { URL } = require('url');
const https = require('https');
const http = require('http');
const { XMLParser } = require('fast-xml-parser');

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;

// Realistic browser UA: a UA that announces itself as a bot is an easy anti-bot signal
// (this was swapped in while chasing the YouTube 404s of Sept 2026).
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Resolves { status, headers, text }. Rejects on timeout (a hard deadline for the whole
// request, not an idle timer), oversized bodies, socket errors, and a connection that
// closes before the response finished. `redirects` is how many 3xx hops to follow
// (default 0: the 3xx is returned as-is); relative Location headers are resolved.
function request(urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = 15000, redirects = 0 } = {}) {
    return new Promise((resolve, reject) => {
        let u;
        try { u = new URL(urlStr); } catch (e) { return reject(e); }
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return reject(new Error(`Unsupported protocol ${u.protocol}`));

        let settled = false, req;
        const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
        const timer = setTimeout(() => { req?.destroy(); done(reject, new Error('Timeout')); }, timeoutMs);

        const hdrs = { ...headers };
        if (body !== null) hdrs['Content-Length'] = Buffer.byteLength(body);
        req = (u.protocol === 'https:' ? https : http).request(u, { method, headers: hdrs }, res => {
            if (redirects > 0 && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                let next;
                try { next = new URL(res.headers.location, u).toString(); } catch (e) { return done(reject, e); }
                return done(resolve, request(next, { method, headers, body, timeoutMs, redirects: redirects - 1 }));
            }
            const chunks = []; let size = 0;
            res.on('data', c => {
                size += c.length;
                if (size > MAX_BODY_BYTES) { req.destroy(); return done(reject, new Error('Response too large')); }
                chunks.push(c);
            });
            res.on('end', () => done(resolve, { status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
            res.on('error', e => done(reject, e));
            res.on('close', () => { if (!res.complete) done(reject, new Error('Connection closed mid-response')); });
        });
        req.on('error', e => done(reject, e));
        if (body !== null) req.write(body);
        req.end();
    });
}

async function asJson(promise) {
    const { status, text } = await promise;
    try { return { status, json: JSON.parse(text) }; }
    catch { return { status, json: null, text }; }
}

function postForm(urlStr, formData, extraHeaders = {}, timeoutMs = 15000) {
    return asJson(request(urlStr, {
        method: 'POST', timeoutMs, body: new URLSearchParams(formData).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...extraHeaders },
    }));
}

function postJson(urlStr, bodyObj, extraHeaders = {}, timeoutMs = 15000) {
    return asJson(request(urlStr, {
        method: 'POST', timeoutMs, body: JSON.stringify(bodyObj),
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
    }));
}

function fetchJson(urlStr, headers = {}, timeoutMs = 15000) {
    return asJson(request(urlStr, { headers, timeoutMs }));
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

async function fetchText(url, headers = {}) {
    const { status, text } = await request(url, { headers: { 'User-Agent': BROWSER_UA, ...headers }, redirects: MAX_REDIRECTS });
    if (status >= 300 && status < 400) throw new Error('Too many redirects');
    if (status !== 200) throw new Error(`HTTP ${status}`);
    return text;
}

module.exports = { fetchJson, fetchText, postForm, postJson, xmlParser };
