'use strict';
// Read-only Azure DevOps client. The token comes from the signed-in Azure CLI, lives only in memory,
// and is never logged or written to disk.
const { execFile } = require('child_process');
const cfg = require('../config');

const ADO_RESOURCE = cfg.adoResource; // Azure DevOps application id used by `az account get-access-token` (a public constant, see config.js)
const BASE = cfg.org.replace(/\/+$/, '');
let token = null; let tokenAt = 0; let tokenLoading = null;

function azToken() {
  return new Promise((resolve, reject) => {
    const azArgs = ['account', 'get-access-token', '--resource', ADO_RESOURCE, '--query', 'accessToken', '-o', 'tsv'];
    const [bin, args] = process.platform === 'win32' ? ['cmd', ['/c', 'az', ...azArgs]] : ['az', azArgs]; // az is a .cmd file on Windows
    execFile(bin, args,
      { timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
        const t = (stdout || '').toString().trim();
        if (err || !t) {
          const msg = /az login|AADSTS|Please run|not logged/i.test(String(stderr)) ? 'Azure CLI is not signed in. Run: az login' : 'Could not get an Azure DevOps token from the Azure CLI.';
          const e = new Error(msg); e.code = 'AUTH'; return reject(e);
        }
        resolve(t);
      });
  });
}

async function getToken(force) {
  if (!force && token && Date.now() - tokenAt < 40 * 60 * 1000) return token;
  if (!tokenLoading) tokenLoading = azToken().then((t) => { token = t; tokenAt = Date.now(); return t; }).finally(() => { tokenLoading = null; });
  return tokenLoading;
}

// READ-ONLY GUARD. The hub never creates, updates or deletes anything in Azure DevOps, and nothing the AI planner does can.
// Every request passes through checkRequest() before any network call. Allowed: GET, and POST only to the two search
// endpoints, which read work items (WIQL query, batch get) and cannot change them. Everything else is refused.
const READ_ONLY_POSTS = [
  { re: /^\/[^/]+\/[^/]+\/_apis\/wit\/wiql$/i, keys: ['query'], check: (b) => typeof b.query === 'string' && /^\s*select\b/i.test(b.query) },
  { re: /^\/[^/]+\/[^/]+\/_apis\/wit\/workitemsbatch$/i, keys: ['ids', 'fields', 'errorPolicy', 'asOf', '$expand'], check: (b) => Array.isArray(b.ids) && !Array.isArray(b) },
];
function checkRequest(method, urlStr, body) {
  const refuse = (why) => { const e = new Error('Blocked by the read-only guard: ' + why); e.code = 'READ_ONLY'; throw e; };
  if (!BASE) refuse('Azure DevOps is not configured (set organization and project in hub.config.json)');
  let u; try { u = new URL(urlStr); } catch { refuse('invalid address'); }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 'dev.azure.com') refuse('only dev.azure.com is allowed');
  if (u.pathname.toLowerCase().split('/')[1] !== new URL(BASE).pathname.split('/')[1].toLowerCase()) refuse('only the ' + cfg.org.split('/').pop() + ' organization is allowed');
  if (method === 'GET') { if (body !== undefined) refuse('a GET cannot carry a body'); return; }
  if (method !== 'POST') refuse(method + ' is never allowed');
  const rule = READ_ONLY_POSTS.find((r) => r.re.test(u.pathname));
  if (!rule) refuse('POST ' + u.pathname.replace(/^\/[^/]+\/[^/]+/, '') + ' is not a read-only search');
  if (!body || typeof body !== 'object' || Array.isArray(body)) refuse('unexpected request body');
  if (Object.keys(body).some((k) => !rule.keys.includes(k)) || !rule.check(body)) refuse('the request body is not a plain search');
}

// withHeaders: the result also carries __token, the continuation token of a paged list (read from a response header).
async function ado(pathOrUrl, body, withHeaders) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${BASE}/${cfg.project}/${pathOrUrl}`;
  const method = body ? 'POST' : 'GET'; // the caller cannot choose any other method
  checkRequest(method, url, body);
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await getToken(attempt > 0);
    const res = await fetch(url, {
      method,
      headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
    if (res.status === 401 && attempt === 0) continue; // token expired: refresh once
    if (res.status === 203 || res.status === 401) { const e = new Error('Azure DevOps rejected the sign-in. Run: az login'); e.code = 'AUTH'; throw e; }
    if (!res.ok) throw new Error(`Azure DevOps ${res.status} for ${url.replace(BASE, '').split('?')[0]}`);
    const j = await res.json();
    if (withHeaders) j.__token = res.headers.get('x-ms-continuationtoken');
    return j;
  }
  throw new Error('Azure DevOps request failed');
}

module.exports = { ado, BASE, checkRequest };
