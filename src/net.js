// HTTP helpers (postForm/postJson/fetchJson/fetchText) and the shared XML parser.
// Moved verbatim out of the former single-file index.js; only the require/export lines are new.

const { URL } = require('url');
const https = require('https');
const { XMLParser } = require('fast-xml-parser');
const http = require('http');

function postForm(urlStr, formData, extraHeaders = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams(formData).toString();
        const u = new URL(urlStr);
        const req = https.request({
            hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), ...extraHeaders },
        }, res => {
            const chunks = []; res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                try { resolve({ status: res.statusCode, json: JSON.parse(text) }); }
                catch { resolve({ status: res.statusCode, json: null, text }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => req.destroy(new Error('Timeout')));
        req.write(body); req.end();
    });
}

function postJson(urlStr, bodyObj, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(bodyObj);
        const u = new URL(urlStr);
        const req = https.request({
            hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extraHeaders },
        }, res => {
            const chunks = []; res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                try { resolve({ status: res.statusCode, json: JSON.parse(text) }); }
                catch { resolve({ status: res.statusCode, json: null, text }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('Timeout')));
        req.write(body); req.end();
    });
}

function fetchJson(urlStr, headers = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers }, res => {
            const chunks = []; res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                try { resolve({ status: res.statusCode, json: JSON.parse(text) }); }
                catch { resolve({ status: res.statusCode, json: null, text }); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('Timeout')));
        req.end();
    });
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function fetchText(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        // Was a self-identifying "SocialNotifyBot/1.0" UA — swapped to a realistic
        // browser string as a test against the YouTube 404s (Sept 2026), since a
        // UA that announces itself as a bot is an easy, obvious anti-bot signal.
        const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36', ...headers } }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchText(res.headers.location, headers).then(resolve, reject);
            }
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
            const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('Timeout')));
    });
}

module.exports = { fetchJson, fetchText, postForm, postJson, xmlParser };
