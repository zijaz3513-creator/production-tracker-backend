/*
  ============================================================
  Production Tracker — backend, running as a standalone Node/Express
  server instead of Google Apps Script.
  ============================================================
  This replaces Code.gs entirely. Supabase is untouched — it's still
  your database — the only thing being removed is the Google Apps
  Script layer that used to sit between the browser and Supabase.
  Every action (getOrders, addOrder, updateTailor, etc.) keeps the
  exact same name and the exact same {success, ...} response shape,
  so the rest of index.html barely needs to change — just how it
  reaches this server (see the updated apiCall() in index.html).

  ROW NUMBERING — unchanged from before.
    Orders:  row = database id + 2   (2 legacy header rows)
    Samples: row = database id + 1   (1 legacy header row)
  ============================================================
*/

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const PORT = process.env.PORT || 3000;

// One shared password per role/category, set as environment variables —
// never hardcoded here and never sent to the browser. Master, Tailor,
// Designer, and Pattern Master are NOT in this list — each person in
// those roles has their own individual password instead (managed from
// the Admin > Staff page, stored hashed in the "staff" table). If a
// shared role's env var isn't set, that role simply can't log in until
// an admin configures it.
const ROLE_PASSWORDS = {
  admin: process.env.ADMIN_PASSWORD,
  inventory: process.env.INVENTORY_PASSWORD,
  handemb: process.env.HANDEMB_PASSWORD,
  machemb: process.env.MACHEMB_PASSWORD,
  fulfillment: process.env.FULFILLMENT_PASSWORD,
  // Aeon Workstation supervisor — approves tailoring jobs only.
  atelier_supervisor: process.env.ATELIER_SUPERVISOR_PASSWORD
};

// Roles managed as individual people in the "staff" table instead of a
// single shared password. Tailors are capped (MAX_TAILOR_SLOTS) because
// of the order row layout; the others aren't.
const STAFF_ROLES = ['master', 'tailor', 'designer', 'patternmaster', 'samplemachemb', 'samplehandemb', 'handembworker'];

Object.keys(ROLE_PASSWORDS).forEach(role => {
  if (!ROLE_PASSWORDS[role]) {
    console.warn(`Warning: no password set for role "${role}" (set ${role.toUpperCase()}_PASSWORD in the environment) — that role cannot log in yet.`);
  }
});

// Static secret for external tools/integrations to call this API directly
// (e.g. from a script, another app, or Claude) without going through the
// browser login flow. Grants full admin-level access — keep it as secret
// as any password. Set API_KEY in the environment to enable it; if unset,
// this form of access is simply disabled.
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  console.warn('Warning: no API_KEY set in the environment — external API-key access is disabled until one is configured.');
}

// ============================================================
// Shopify sync — best-effort, fire-and-forget. Never blocks or breaks the
// tracker's own actions if Shopify is slow, misconfigured, or an order
// simply doesn't exist there.
//
// IMPORTANT PLATFORM LIMITATION: Shopify does not let any app — including
// custom/private ones — write into the native order Timeline shown in the
// admin. That's a hard restriction on Shopify's side, not something this
// code can work around. This instead keeps a running, timestamped log in
// an order metafield (production_tracker.timeline), and mirrors the
// latest status into the order's Note field for an at-a-glance view.
// Both show directly on the Shopify order page.
// ============================================================
const SHOPIFY_STORE = process.env.SHOPIFY_STORE_DOMAIN; // e.g. your-store.myshopify.com
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';
const SHOPIFY_ENABLED = !!(SHOPIFY_STORE && SHOPIFY_TOKEN);
if (!SHOPIFY_ENABLED) {
  console.warn('Shopify sync disabled — set SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN to enable it.');
}

async function shopifyGraphQL(query, variables) {
  const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_TOKEN },
    body: JSON.stringify({ query, variables })
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function findShopifyOrder(orderNo) {
  const clean = String(orderNo || '').trim().replace(/^#/, '');
  if (!clean) return null;
  const data = await shopifyGraphQL(
    `query($q: String!) {
      orders(first: 1, query: $q) {
        edges { node { id name
          metafield(namespace: "production_tracker", key: "timeline") { value }
        } }
      }
    }`,
    { q: `name:${clean} OR name:#${clean}` }
  );
  const edge = data && data.orders && data.orders.edges[0];
  return edge ? edge.node : null;
}

// Appends one timestamped line to the order's running log metafield, and
// mirrors the same line as the order's current Note. Swallows all errors —
// callers fire this without awaiting it, so a Shopify hiccup never slows
// down or breaks the tracker itself.
async function pushShopifyUpdate(orderNo, statusLine) {
  if (!SHOPIFY_ENABLED || !orderNo) return;
  try {
    const order = await findShopifyOrder(orderNo);
    if (!order) return; // no matching Shopify order — nothing to sync, not an error

    const ts = new Date().toLocaleString('en-GB', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
    const prevLog = (order.metafield && order.metafield.value) || '';
    const newLog = (prevLog ? prevLog + '\n' : '') + `[${ts}] ${statusLine}`;

    await shopifyGraphQL(
      `mutation($input: OrderInput!) {
        orderUpdate(input: $input) { userErrors { field message } }
      }`,
      { input: {
        id: order.id,
        note: statusLine,
        metafields: [{ namespace: 'production_tracker', key: 'timeline', type: 'multi_line_text_field', value: newLog }]
      } }
    );
  } catch (e) {
    console.error('Shopify sync failed for order ' + orderNo + ':', e.message);
  }
}

// Looks up an order's order_no from its internal row/id — used by the
// update handlers below to know what to sync to Shopify. Short-circuits
// instantly (no DB call) when Shopify sync isn't configured, so this adds
// zero latency for anyone who hasn't set it up.
async function getOrderNo(row) {
  if (!SHOPIFY_ENABLED) return null;
  const rows = await sbFetch('GET', `orders?id=eq.${row - 2}&select=order_no`);
  return (rows && rows[0]) ? rows[0].order_no : null;
}

// Stateless signed session tokens. A token is  base64url(JSON{role,name,iat}).HMAC
// and is verified with a server-side secret, so:
//   - it never expires on its own — people stay logged in until they press Logout;
//   - it survives server restarts / redeploys (nothing is kept in memory).
// Set SESSION_SECRET in the environment to a long random string. If it's missing
// we derive a stable secret from the Supabase key, so tokens still survive restarts.
// Changing the secret logs everybody out. Logout revokes the token (in memory).
const SESSION_SECRET = process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update('aeon-session|' + (process.env.SUPABASE_SECRET_KEY || '') + '|' + (process.env.ADMIN_PASSWORD || '')).digest('hex');
const revokedTokens = new Set();

function b64u(buf) { return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function signTokenPart(part) { return b64u(crypto.createHmac('sha256', SESSION_SECRET).update(part).digest()); }
function makeToken(role, name) {
  const part = b64u(JSON.stringify({ role, name: name || '', iat: Date.now(), n: crypto.randomBytes(6).toString('hex') }));
  return part + '.' + signTokenPart(part);
}
function getSession(token) {
  if (!token || typeof token !== 'string' || revokedTokens.has(token)) return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const part = token.slice(0, dot), sig = token.slice(dot + 1);
  const expect = signTokenPart(part);
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return { role: p.role, name: p.name || '', createdAt: p.iat };
  } catch (e) { return null; }
}

// --- Password hashing for individual master/tailor accounts (scrypt) ---
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, hash, salt) {
  try {
    const check = crypto.scryptSync(password, salt, 64);
    const stored = Buffer.from(hash, 'hex');
    return check.length === stored.length && crypto.timingSafeEqual(check, stored);
  } catch (e) {
    return false;
  }
}

async function doLoginAction(params) {
  const role = (params.role || '').toString();
  const password = (params.password || '').toString();
  const name = (params.name || '').toString();

  // Masters, tailors, designers, and pattern masters each have their own
  // individual password, stored (hashed) in the "staff" table and managed
  // from the Admin > Staff page.
  if (STAFF_ROLES.indexOf(role) !== -1) {
    if (!name) return { success: false, error: 'Please select your name.' };
    const rows = await sbFetch(
      'GET',
      `staff?select=id,name,password_hash,password_salt&role=eq.${role}&name=eq.${encodeURIComponent(name)}&active=eq.true&limit=1`
    );
    const rec = rows && rows[0];
    if (!rec || !verifyPassword(password, rec.password_hash, rec.password_salt)) {
      return { success: false, error: 'Incorrect name or password.' };
    }
    const token = makeToken(role, name);
    return { success: true, token };
  }

  if (!(role in ROLE_PASSWORDS)) {
    return { success: false, error: 'Unknown role: ' + role };
  }
  const expected = ROLE_PASSWORDS[role];
  if (!expected) {
    return { success: false, error: 'This role has no password configured yet — ask your admin to set it up.' };
  }
  if (password !== expected) {
    return { success: false, error: 'Incorrect password.' };
  }

  const token = makeToken(role, name);
  return { success: true, token };
}

// Comma-separated list, e.g. "https://yourdomain.com,https://www.yourdomain.com"
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY in environment (.env). Exiting.');
  process.exit(1);
}

const MAX_TAILOR_SLOTS = Infinity; // no limit on tailors
const MAX_FABRIC_SLOTS = 6;

// Which actions each role may call. Admin bypasses this check entirely.
const ROLE_PERMISSIONS = {
  inventory: ['getOrders', 'getOrder', 'getOrderByOrderNo', 'getOrderTimeline', 'updateFabric', 'updateFabricDetails', 'updateMachEmb', 'updateHandEmb', 'markDone'],
  master: ['getOrders', 'getOrder', 'getOrderByOrderNo', 'getOrderTimeline', 'updateTailor', 'embReady', 'embMasterReceive', 'masterStart', 'masterPause', 'masterResume', 'masterFinish', 'masterReturn'],
  tailor: [
    'getOrders', 'getOrder', 'getOrderByOrderNo', 'getOrderTimeline', 'markDone', 'sendOrderEmb', 'getSamples', 'markSampleDone', 'sendSampleEmb',
    // Aeon Workstation — tailor floor
    'atelierMyOrders', 'atelierStartJob', 'atelierPauseJob', 'atelierResumeJob', 'atelierFinishJob', 'atelierReturnJob',
    'atelierMechanicCall', 'atelierMyToday', 'atelierMyHistory', 'atelierMyEarnings', 'atelierGetWorkingTimeConfig'
  ],
  // Aeon Workstation supervisor: APPROVALS ONLY (list, approve, reject,
  // revert & reassign, scan-to-approve). Team today, standard times,
  // payroll, mechanic calls and find-job live in the Admin panel and are
  // deliberately not granted here.
  atelier_supervisor: [
    'atelierApprovalsList', 'atelierApproveJob', 'atelierRejectJob', 'atelierRevertJob',
    'atelierFindPendingByCode', 'atelierGetWorkingTimeConfig',
    // Ready-made items: supervisor scans, then approves or rejects
    'readyMadeList', 'readyMadeFindByCode', 'readyMadeApprove', 'readyMadeReject'
  ],
  // Order embroidery desks: scan to receive, scan to start the timer, then
  // pause / finish / return. Each role is locked to its own kind server-side.
  handemb: ['getOrders', 'getOrder', 'getOrderByOrderNo', 'getOrderTimeline', 'embReceive', 'embAssignWorker', 'embStart', 'embPause', 'embResume', 'embFinish', 'embReturn'],
  machemb: ['getOrders', 'getOrder', 'getOrderByOrderNo', 'getOrderTimeline', 'embReceive', 'embStart', 'embPause', 'embResume', 'embFinish', 'embReturn'],
  designer: ['getSamples', 'addSample'],
  patternmaster: ['getSamples', 'assignSampleTailor'],
  samplemachemb: ['getSamples', 'receiveSampleEmb'],
  samplehandemb: ['getSamples', 'receiveSampleEmb'],
  // Same access as Admin, except it cannot delete orders/samples or remove
  // staff — those three stay Admin-only.
  fulfillment: [
    'getOrders', 'getOrder', 'getOrderByOrderNo', 'getOrderTimeline', 'addOrder', 'updateFabric', 'updateFabricDetails',
    'updateMachEmb', 'updateHandEmb', 'updateMaster', 'updateTailor',
    'masterStart', 'masterPause', 'masterResume', 'masterFinish', 'masterReturn',
    'setEmbPerson', 'embAdminReceive', 'embReady', 'embMasterReceive', 'embAssignWorker',
    'markDone', 'undoMarkDone', 'updateUrgent', 'atelierJobsForLine',
    'getSamples', 'addSample', 'assignSampleTailor', 'assignSampleMaster',
    'markSampleDone', 'undoSampleDone', 'sendSampleEmb', 'receiveSampleEmb',
    'listStaff', 'addStaff', 'reorderStaff',
    // Live tailor timers (read-only)
    'atelierLiveJobs',
    // QC-style approvals: approve when QC is not available, or send a piece
    // back (Tailor / Master / Fabric) — including ones QC approved by mistake.
    'atelierApprovalsList', 'atelierApproveJob', 'atelierRejectJob', 'atelierRevertJob',
    'atelierRecentApproved',
    'readyMadeList', 'readyMadeFindByCode', 'readyMadeApprove', 'readyMadeReject'
  ]
};

// ============================================================
// Supabase REST helpers (same shape as the old sbFetch/sbSelectAll/etc.)
// ============================================================
async function sbFetch(method, path, body, extraHeaders) {
  const url = SUPABASE_URL + '/rest/v1/' + path;
  const headers = Object.assign(
    {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: 'Bearer ' + SUPABASE_SECRET_KEY,
      'Content-Type': 'application/json'
    },
    extraHeaders || {}
  );
  const opts = { method, headers };
  if (body !== undefined && body !== null) opts.body = JSON.stringify(body);

  const resp = await fetch(url, opts);
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error('Supabase ' + method + ' ' + path + ' failed (' + resp.status + '): ' + text);
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return text; }
}

// Pages through a table 1000 rows at a time until exhausted.
async function sbSelectAll(table, orderCol) {
  const all = [];
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const path = table + '?select=*&order=' + orderCol + '.asc&limit=' + pageSize + '&offset=' + offset;
    const page = (await sbFetch('GET', path)) || [];
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

async function sbInsertOne(table, obj) {
  const result = await sbFetch('POST', table, obj, { Prefer: 'return=representation' });
  return Array.isArray(result) ? result[0] : result;
}

async function sbInsertMany(table, arr) {
  if (!arr.length) return;
  await sbFetch('POST', table, arr, { Prefer: 'return=minimal' });
}

async function sbUpdate(table, id, patch) {
  await sbFetch('PATCH', table + '?id=eq.' + id, patch, { Prefer: 'return=minimal' });
}

async function sbGetMaxId(table) {
  const rows = await sbFetch('GET', table + '?select=id&order=id.desc&limit=1');
  return (rows && rows.length) ? rows[0].id : 0;
}

// ============================================================
// Staff (masters + tailors) — dynamic roster stored in Supabase, managed
// from the Admin > Staff page. Deactivating someone (removeStaff) is a
// soft-delete so past orders still show their name correctly. Display
// order is controlled by sort_order (lower = shown first), which the
// Admin > Staff page lets you change with up/down buttons.
// ============================================================
async function getActiveStaff(staffRole) {
  return (await sbFetch(
    'GET',
    `staff?select=id,name,sort_order&role=eq.${staffRole}&active=eq.true&order=sort_order.asc,created_at.asc`
  )) || [];
}
async function getActiveStaffNames(staffRole) {
  return (await getActiveStaff(staffRole)).map(s => s.name);
}

// Display names: a real name shown in front of the machine-number name (e.g. "Ayesha (M1)").
// Stored in staff.display_name (ALTER TABLE staff ADD COLUMN IF NOT EXISTS display_name text).
async function getDisplayNames() {
  try {
    const rows = (await sbFetch('GET', 'staff?select=id,name,display_name&active=eq.true&display_name=not.is.null')) || [];
    const byName = {}, byId = {};
    rows.forEach(r => { if (r.display_name) { byName[r.name] = r.display_name; byId[r.id] = r.display_name; } });
    return { byName, byId };
  } catch (e) { return { byName: {}, byId: {} }; }
}
async function doSetDisplayName(params) {
  const id = parseInt(params.id, 10);
  const dn = (params.displayName || '').toString().trim();
  if (!id) return { success: false, error: 'Invalid id.' };
  try { await sbUpdate('staff', id, { display_name: dn || null }); }
  catch (e) { return { success: false, error: 'Could not save — run the SQL line: ALTER TABLE staff ADD COLUMN IF NOT EXISTS display_name text;' }; }
  return { success: true, displayName: dn };
}
async function doGetRoster() {
  const [masters, tailors, designers, patternmasters, sampleMachEmb, sampleHandEmb, handEmbWorkers] = await Promise.all([
    getActiveStaffNames('master'),
    getActiveStaffNames('tailor'),
    getActiveStaffNames('designer'),
    getActiveStaffNames('patternmaster'),
    getActiveStaffNames('samplemachemb'),
    getActiveStaffNames('samplehandemb'),
    getActiveStaffNames('handembworker')
  ]);
  const dn = await getDisplayNames();
  return { success: true, masters, tailors, designers, patternmasters, sampleMachEmb, sampleHandEmb, handEmbWorkers, displayNames: dn.byName };
}

async function doListStaff(params) {
  const staffRole = (params.staffRole || '').toString();
  if (STAFF_ROLES.indexOf(staffRole) === -1) {
    return { success: false, error: 'Invalid staff role.' };
  }
  const dn = await getDisplayNames();
  return { success: true, staff: (await getActiveStaff(staffRole)).map(x => Object.assign({}, x, { display_name: dn.byId[x.id] || '' })) };
}

async function doAddStaff(params) {
  const staffRole = (params.staffRole || '').toString();
  const name = (params.name || '').toString().trim();
  const password = (params.password || '').toString();

  if (STAFF_ROLES.indexOf(staffRole) === -1) {
    return { success: false, error: 'Invalid staff role.' };
  }
  if (!name) return { success: false, error: 'Name is required.' };
  if (!password || password.length < 4) {
    return { success: false, error: 'Password must be at least 4 characters.' };
  }

  const current = await getActiveStaff(staffRole);
  // No cap on the number of tailors — the tailor name is stored directly on each order.

  const existing = await sbFetch(
    'GET',
    `staff?select=id&role=eq.${staffRole}&name=eq.${encodeURIComponent(name)}&active=eq.true&limit=1`
  );
  if (existing && existing.length) {
    return { success: false, error: 'That name is already on the list.' };
  }

  const nextOrder = current.reduce((max, s) => Math.max(max, s.sort_order || 0), 0) + 1;
  const { hash, salt } = hashPassword(password);
  await sbInsertOne('staff', {
    role: staffRole, name,
    password_hash: hash, password_salt: salt,
    active: true, sort_order: nextOrder
  });
  return { success: true };
}

async function doRemoveStaff(params) {
  const id = parseInt(params.id, 10);
  if (!id) return { success: false, error: 'Invalid id.' };
  await sbFetch('PATCH', `staff?id=eq.${id}`, { active: false }, { Prefer: 'return=minimal' });
  return { success: true };
}

// Rename a staff member everywhere (staff list + every record that stores the name as text).
const RENAME_CASCADE = {
  tailor: [['orders', 'tailor'], ['design_samples', 'tailor'], ['atelier_jobs', 'tailor'], ['atelier_calls', 'tailor']],
  master: [['orders', 'master'], ['atelier_jobs', 'master']],
  patternmaster: [['design_samples', 'master']],
  handembworker: [['orders', 'hand_emb_person']]
};
async function doRenameStaff(params) {
  const id = parseInt(params.id, 10);
  const newName = (params.newName || '').toString().trim();
  if (!id) return { success: false, error: 'Invalid id.' };
  if (!newName) return { success: false, error: 'Enter the new name.' };
  const rows = await sbFetch('GET', `staff?select=id,name,role&id=eq.${id}&limit=1`);
  const rec = rows && rows[0];
  if (!rec) return { success: false, error: 'Not found.' };
  if (rec.name === newName) return { success: true, unchanged: true };
  const dup = await sbFetch('GET', `staff?select=id&role=eq.${rec.role}&name=eq.${encodeURIComponent(newName)}&active=eq.true&limit=1`);
  if (dup && dup.length) return { success: false, error: 'That name is already on the list.' };
  await sbUpdate('staff', id, { name: newName });
  const failed = [];
  for (const [table, col] of (RENAME_CASCADE[rec.role] || [])) {
    try {
      await sbFetch('PATCH', `${table}?${col}=eq.${encodeURIComponent(rec.name)}`, { [col]: newName }, { Prefer: 'return=minimal' });
    } catch (e) { failed.push(table + '.' + col); }
  }
  return { success: true, oldName: rec.name, newName, role: rec.role, failed };
}

async function doReorderStaff(params) {
  const id = parseInt(params.id, 10);
  const direction = (params.direction || '').toString();
  if (!id || (direction !== 'up' && direction !== 'down')) {
    return { success: false, error: 'Invalid request.' };
  }

  const me = await sbFetch('GET', `staff?select=id,role&id=eq.${id}&limit=1`);
  const rec = me && me[0];
  if (!rec) return { success: false, error: 'Not found.' };

  const list = await getActiveStaff(rec.role);
  const idx = list.findIndex(s => s.id === id);
  if (idx === -1) return { success: false, error: 'Not found.' };
  const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= list.length) return { success: true }; // already at the edge

  const a = list[idx], b = list[swapIdx];
  const aOrder = (a.sort_order != null) ? a.sort_order : idx;
  const bOrder = (b.sort_order != null) ? b.sort_order : swapIdx;
  await Promise.all([
    sbUpdate('staff', a.id, { sort_order: bOrder }),
    sbUpdate('staff', b.id, { sort_order: aOrder })
  ]);
  return { success: true };
}

// ============================================================
// Express app
// ============================================================
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(
  cors({
    origin: ALLOWED_ORIGINS.includes('*') ? true : ALLOWED_ORIGINS,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
  })
);

app.get('/health', (req, res) => res.json({ ok: true }));

// Accept both GET (query string) and POST (JSON body) — merged the same
// way Apps Script's e.parameter + postData used to be, so you can switch
// the frontend to POST without breaking anything mid-migration.
app.all('/api', async (req, res) => {
  const params = Object.assign({}, req.query, req.body || {});
  const action = params.action;

  try {
    if (action === 'login') {
      return res.json(await doLoginAction(params));
    }
    if (action === 'logout') {
      if (params.token) revokedTokens.add(params.token);
      return res.json({ success: true });
    }
    if (action === 'getRoster') {
      // Just names, needed to populate the login screen before anyone is
      // logged in — no session required, nothing sensitive returned.
      return res.json(await doGetRoster());
    }
    if (action === 'atelierListTailors') {
      // Names for the tailor sign-in grid — no session yet, nothing sensitive.
      return res.json(await doAtelierListTailors());
    }
    if (action === 'atelierTailorLogin') {
      return res.json(await doAtelierTailorLogin(params));
    }

    // API key auth — for external tools/integrations (Claude, scripts,
    // other apps), as an alternative to the browser's password/session
    // login. Grants full admin-level access, so the key must be treated
    // as a secret exactly like any of the role passwords.
    const apiKey = (req.headers['x-api-key'] || params.apiKey || '').toString();
    let role;
    let authenticatedName = '';
    if (API_KEY && apiKey && apiKey === API_KEY) {
      role = 'admin';
    } else {
      // Every other action requires a valid session from a successful
      // password login. The role (and, for individually-logged-in staff,
      // their real name) used for permission/ownership checks comes from
      // the session set at login time, never from whatever the browser
      // sends, so a client can't just claim to be someone else.
      const session = getSession(params.token);
      if (!session) {
        return res.json({ success: false, error: 'Session expired. Please log in again.' });
      }
      role = session.role;
      authenticatedName = session.name || '';
    }

    const permissionError = checkPermission(action, role);
    const result = permissionError || (await routeAction(action, Object.assign({}, params, { role, authenticatedName })));
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(200).json({ success: false, error: err.toString() });
  }
});

function checkPermission(action, role) {
  if (action === 'getOrders' || action === 'getSamples') return null;
  if (!action) return { success: false, error: 'Missing action.' };
  if (!role) return { success: false, error: 'Missing role — please log in again.' };
  if (role === 'admin') return null;

  const allowed = ROLE_PERMISSIONS[role];
  if (!allowed) return { success: false, error: 'Unknown role: ' + role };
  if (allowed.indexOf(action) === -1) {
    return { success: false, error: 'Role "' + role + '" is not permitted to perform "' + action + '".' };
  }
  return null;
}

// ============================================================
// ORDER TIMELINE — a permanent, local history of every step an order goes
// through (added, fabric, cutting, tailoring, QC, embroidery, done...).
// Stored in the Supabase table `order_events` (see order_events.sql).
// Logging is best-effort: it can never block or break the action itself.
// ============================================================
function actorOf(params) {
  return ((params && (params.authenticatedName || params.role)) || '').toString();
}

// Fire-and-forget insert. `line` = { orderId?, orderNo, sku }.
function logOrderEvent(line, kind, text, actor) {
  if (!line || (!line.orderId && !line.orderNo)) return;
  sbFetch('POST', 'order_events', {
    order_id: line.orderId || null,
    order_no: line.orderNo || null,
    sku: line.sku || null,
    kind, text: String(text || ''), actor: actor || null,
    at: new Date().toISOString()
  }, { Prefer: 'return=minimal' }).catch(e => console.error('order_events insert failed:', e.message));
}

// For handlers that only know order_no + sku (Atelier jobs): resolve the row id.
async function logLineEvent(orderNo, sku, kind, text, actor) {
  try {
    if (!orderNo) return;
    let id = null;
    if (sku) {
      const r = await sbFetch('GET', `orders?order_no=eq.${encodeURIComponent(orderNo)}&sku=eq.${encodeURIComponent(sku)}&select=id&limit=1`);
      id = r && r[0] ? r[0].id : null;
    }
    logOrderEvent({ orderId: id, orderNo, sku }, kind, text, actor);
  } catch (e) { console.error('logLineEvent failed:', e.message); }
}

const EMB_WORD = { mach: 'Machine embroidery', hand: 'Hand embroidery' };
function describeEmbValue(kindWord, value, params) {
  const code = (value || '').split('|')[0];
  if (value === 'CLEAR') return ['embroidery', `${kindWord} — reset`];
  if (code === 'NEED') return ['embroidery', `${kindWord} — marked as needed`];
  if (code === 'SKIP') return ['embroidery', `${kindWord} — skipped (not needed)`];
  if (code === 'RED') {
    const bits = [];
    if (params.person) bits.push('to ' + params.person);
    if (params.metersSent) bits.push(params.metersSent + 'm sent');
    return ['embroidery', `${kindWord} — sent out${bits.length ? ' (' + bits.join(', ') + ')' : ''}`];
  }
  if (code === 'GREEN') {
    return ['embroidery', `${kindWord} — received back${params.metersReceived ? ' (' + params.metersReceived + 'm)' : ''}`];
  }
  return ['embroidery', `${kindWord} — ${value}`];
}

// Turns a successful action into a human-readable timeline entry.
// Returns [kind, text] or null when the action is not a status change.
function describeAction(action, p, result) {
  const kindWord = (p.kind === 'hand' ? EMB_WORD.hand : EMB_WORD.mach);
  switch (action) {
    case 'updateFabric':
      if (p.value === 'Not Available') return ['fabric', `Fabric: Not Available (${p.source}, ${p.purchaseStatus})`];
      return ['fabric', `Fabric: ${p.value}`];
    case 'updateFabricDetails': {
      const bits = [p.fabricName, p.fabricColor, p.meters ? p.meters + ' m' : ''].filter(Boolean).join(', ');
      return ['fabric', bits ? `Fabric details set: ${bits}` : 'Fabric details cleared'];
    }
    case 'updateMachEmb': return describeEmbValue(EMB_WORD.mach, p.value, p);
    case 'updateHandEmb': return describeEmbValue(EMB_WORD.hand, p.value, p);
    case 'sendOrderEmb': return ['embroidery', `Machine embroidery — tailor${result.tailor ? ' ' + result.tailor : ''} sent it to ${result.person}`];
    case 'setEmbPerson': return ['embroidery', result.person ? `Machine embroidery — admin chose ${result.person}` : 'Machine embroidery — person cleared'];
    case 'embReady': return ['embroidery', 'Hand embroidery — cutting done, ready for hand embroidery (Akil)' + (result.totalMs ? ` · master cutting time stopped (${Math.max(1, Math.round(result.totalMs / 60000))} min)` : '')];
    case 'embAssignWorker': return ['embroidery', `Hand embroidery — assigned to ${result.person}`];
    case 'embAdminReceive': return ['embroidery', `Machine embroidery — admin received it back from ${result.person || 'Abdullah'}`];
    case 'embMasterReceive': return ['embroidery', `Hand embroidery — master received the item${result.person ? ' from ' + result.person : ''}`];
    case 'embReceive': return result.already ? null : ['embroidery', `${kindWord} — received at the embroidery desk`];
    case 'embStart': return result.already ? null : ['embroidery', `${kindWord}${result.person ? ' (' + result.person + ')' : ''} — work started`];
    case 'embPause': return ['embroidery', `${kindWord}${result.person ? ' (' + result.person + ')' : ''} — paused (${p.reason})`];
    case 'embResume': return result.already ? null : ['embroidery', `${kindWord}${result.person ? ' (' + result.person + ')' : ''} — resumed`];
    case 'embFinish': return ['embroidery', `${kindWord}${result.person ? ' (' + result.person + ')' : ''} — finished${result.backTo ? ' — back with ' + result.backTo : result.readyFor ? ' — ready for ' + result.readyFor : ''}`];
    case 'embReturn': return ['embroidery', `${kindWord} — returned, needs to be picked up again`];
    case 'masterStart': return result.already ? null : ['cutting', `Cutting started — Master ${result.master || ''}`];
    case 'masterPause': return ['cutting', `Cutting paused — Master ${result.master || ''} (${result.reason || 'no reason'})`];
    case 'masterResume': return result.already ? null : ['cutting', `Cutting resumed — Master ${result.master || ''}`];
    case 'masterFinish': return result.already ? null : ['cutting', `Cutting finished — Master ${result.master || ''}${result.totalMs ? ' (took ' + Math.max(1, Math.round(result.totalMs / 60000)) + ' min)' : ''}`];
    case 'masterReturn': return ['cutting', `Returned by master ${result.master || ''} — ${result.reason}; back to unassigned`];
    case 'updateMaster':
      return p.master ? ['cutting', `In cutting — assigned to Master: ${p.master}`] : ['cutting', 'Master unassigned'];
    case 'updateTailor':
      return p.tailor ? ['tailoring', `Assigned to Tailor: ${p.tailor}`] : ['tailoring', 'Tailor unassigned'];
    case 'markDone': return ['done', 'Marked Done — production complete'];
    case 'undoMarkDone': return ['reopened', 'Done status undone — order reopened'];
    case 'updateUrgent':
      return p.urgent === 'Yes' ? ['urgent', `Marked URGENT — produce by ${p.urgentDate}`] : ['urgent', 'Urgent flag removed'];
    case 'readyMadeApprove': return ['done', 'Ready-made approved — production complete'];
    case 'readyMadeReject': {
      const to = p.reason === 'tailor' ? `Tailor ${p.person}` : p.reason === 'master' ? `Master ${p.person}` : 'the fabric step';
      return ['rework', `Ready-made rejected — sent back to ${to}`];
    }
    default: return null;
  }
}

async function routeAction(action, params) {
  const result = await routeActionInner(action, params);
  try {
    if (result && result.success) {
      if (action === 'addOrder' && result.row) {
        const bits = [params.sku && ('SKU ' + params.sku), params.garmentType, params.orderType].filter(Boolean).join(' · ');
        logOrderEvent({ orderId: result.row - 2, orderNo: (params.orderNo || '').toString().trim(), sku: (params.sku || '').toString().trim() },
          'added', `Order added to production${bits ? ' (' + bits + ')' : ''}` + (params.urgent === 'Yes' ? ` — URGENT, produce by ${params.urgentDate}` : ''),
          actorOf(params));
      } else {
        const d = describeAction(action, params, result);
        const row = parseInt(params.row, 10);
        if (d && row >= 2) {
          sbFetch('GET', `orders?id=eq.${row - 2}&select=order_no,sku&limit=1`).then(r => {
            const rec = r && r[0];
            if (rec) logOrderEvent({ orderId: row - 2, orderNo: rec.order_no, sku: rec.sku }, d[0], d[1], actorOf(params));
          }).catch(e => console.error('order event lookup failed:', e.message));
        }
      }
    }
  } catch (e) { console.error('order event hook failed:', e.message); }
  return result;
}

async function routeActionInner(action, params) {
  switch (action) {
    case 'getOrders': return doGetOrders();
    case 'getOrder': return doGetOrder(params);
    case 'getOrderByOrderNo': return doGetOrderByOrderNo(params);
    case 'getOrderTimeline': return doGetOrderTimeline(params);
    case 'addOrder': return doAddOrder(params);
    case 'updateFabric': return doUpdateFabric(params);
    case 'updateFabricDetails': return doUpdateFabricDetails(params);
    case 'updateMachEmb': return doUpdateMachEmb(params);
    case 'updateHandEmb': return doUpdateHandEmb(params);
    case 'sendOrderEmb': return doSendOrderEmb(params);
    case 'setEmbPerson': return doSetEmbPerson(params);
    case 'embReady': return doEmbReady(params);
    case 'embAssignWorker': return doEmbAssignWorker(params);
    case 'embAdminReceive': return doEmbAdminReceive(params);
    case 'embMasterReceive': return doEmbMasterReceive(params);
    case 'embReceive': return doEmbReceive(params);
    case 'embStart': return doEmbStart(params);
    case 'embPause': return doEmbPause(params);
    case 'embResume': return doEmbResume(params);
    case 'embFinish': return doEmbFinish(params);
    case 'embReturn': return doEmbReturn(params);
    case 'updateMaster': return doUpdateMaster(params);
    case 'masterStart': return doMasterStart(params);
    case 'masterPause': return doMasterPause(params);
    case 'masterResume': return doMasterResume(params);
    case 'masterFinish': return doMasterFinish(params);
    case 'masterReturn': return doMasterReturn(params);
    case 'updateTailor': return doUpdateTailor(params);
    case 'markDone': return doMarkDone(params);
    case 'readyMadeList': return doReadyMadeList();
    case 'readyMadeFindByCode': return doReadyMadeFindByCode(params);
    case 'readyMadeApprove': return doReadyMadeApprove(params);
    case 'readyMadeReject': return doReadyMadeReject(params);
    case 'undoMarkDone': return doUndoMarkDone(params);
    case 'deleteOrder': return doDeleteOrder(params);
    case 'updateUrgent': return doUpdateUrgent(params);
    case 'getSamples': return doGetSamples();
    case 'addSample': return doAddSample(params);
    case 'assignSampleTailor': return doAssignSampleTailor(params);
    case 'assignSampleMaster': return doAssignSampleMaster(params);
    case 'sendSampleEmb': return doSendSampleEmb(params);
    case 'receiveSampleEmb': return doReceiveSampleEmb(params);
    case 'markSampleDone': return doMarkSampleDone(params);
    case 'undoSampleDone': return doUndoSampleDone(params);
    case 'deleteSample': return doDeleteSample(params);
    case 'listStaff': return doListStaff(params);
    case 'addStaff': return doAddStaff(params);
    case 'removeStaff': return doRemoveStaff(params);
    case 'renameStaff': return doRenameStaff(params);
    case 'setDisplayName': return doSetDisplayName(params);
    case 'reorderStaff': return doReorderStaff(params);

    // Aeon Workstation — tailor floor
    case 'atelierMyOrders': return doAtelierMyOrders(params);
    case 'atelierStartJob': return doAtelierStartJob(params);
    case 'atelierPauseJob': return doAtelierPauseJob(params);
    case 'atelierResumeJob': return doAtelierResumeJob(params);
    case 'atelierFinishJob': return doAtelierFinishJob(params);
    case 'atelierReturnJob': return doAtelierReturnJob(params);
    case 'atelierMechanicCall': return doAtelierMechanicCall(params);
    case 'atelierMyToday': return doAtelierMyToday(params);
    case 'atelierMyHistory': return doAtelierMyHistory(params);
    case 'atelierMyEarnings': return doAtelierMyEarnings(params);
    case 'atelierGetWorkingTimeConfig': return doAtelierGetWorkingTimeConfig();
    // Aeon Workstation — supervisor / admin
    case 'atelierApprovalsList': return doAtelierApprovalsList();
    case 'atelierApproveJob': return doAtelierApproveJob(params);
    case 'atelierRejectJob': return doAtelierRejectJob(params);
    case 'atelierRevertJob': return doAtelierRevertJob(params);
    case 'atelierTeamToday': return doAtelierTeamToday();
    case 'atelierLiveJobs': return doAtelierLiveJobs();
    case 'atelierRecentApproved': return doAtelierRecentApproved(params);
    case 'atelierTimeReport': return doAtelierTimeReport(params);
    case 'atelierStandardsList': return doAtelierStandardsList();
    case 'atelierMechanicCallsList': return doAtelierMechanicCallsList();
    case 'atelierMechanicResolve': return doAtelierMechanicResolve(params);
    case 'atelierPayrollReport': return doAtelierPayrollReport();
    case 'atelierFindPendingByCode': return doAtelierFindPendingByCode(params);
    case 'atelierJobsForLine': return doAtelierJobsForLine(params);
    case 'atelierCancelJob': return doAtelierCancelJob(params);
    // Aeon Workstation — admin only (not in any role's permission list above,
    // so only the admin bypass in checkPermission() can reach these)
    case 'atelierSetStandard': return doAtelierSetStandard(params);
    case 'atelierUseFastStandard': return doAtelierUseFastStandard(params);
    case 'atelierSetTypeDefault': return doAtelierSetTypeDefault(params);
    case 'atelierGetSettings': return doAtelierGetSettings();
    case 'atelierSetSettings': return doAtelierSetSettings(params);
    case 'atelierSetPin': return doAtelierSetPin(params);
    case 'atelierListPins': return doAtelierListPins();
    default: return { success: false, error: 'Unknown action: ' + action };
  }
}

function parseRow(params) {
  const row = parseInt(params.row, 10);
  return (!isNaN(row) && row >= 2) ? row : null;
}

// ============================================================
// ORDERS — reconstructs the exact same 34-column array shape the
// frontend's parseOrders() already expects.
// ============================================================
function buildOrderRowArray(rec, inQC, workMs, pausedReason) {
  const row = new Array(42).fill('');
  if (!rec) return row;

  row[0] = rec.sr_no || '';
  row[1] = rec.order_no || '';
  row[2] = rec.sku || '';
  row[3] = rec.fabric_status || '';
  row[4] = rec.master || '';
  row[5] = rec.master_assigned_at || '';
  row[6] = rec.machine_emb || '';
  row[7] = rec.fabric_name || '';
  row[8] = rec.hand_emb || '';
  row[9] = rec.fabric_made_in || '';

  // Tailor is written directly by name (columns 10/11), the same way
  // `master` is above — NOT by position in the active-tailor roster.
  // The old scheme placed rec.tailor_assigned_at into row[10 + idx],
  // where idx was the tailor's index in the currently-active tailor
  // list. That's unsafe: the frontend decoded it back using its own
  // separately-cached TAILORS array, and the two orderings only stay
  // in sync until someone adds/removes/reorders a tailor in Admin >
  // Staff. The instant they diverge, every order's tailor decodes to
  // whichever name happens to now sit at that same slot — which is
  // exactly the "everything shows the same tailor" bug this replaces.
  row[10] = rec.tailor || '';
  row[11] = rec.tailor_assigned_at || '';
  row[12] = rec.rework_note || '';
  // Whether the tailor has already finished this line and it's sitting
  // in QC awaiting supervisor approval (an atelier_jobs row with status
  // 'pending' for this order_no+sku). Lets the main order dashboard show
  // "QC" as its own stage instead of still lumping it in with "With tailor".
  // inQC is the pending atelier job id (number) when in QC, so the admin
  // Edit Order modal can revert it; any truthy value still means "in QC".
  row[13] = inQC ? String(inQC === true ? 'QC' : inQC) : '';
  row[14] = rec.mach_emb_person || '';
  row[15] = rec.hand_emb_person || '';
  // Total tailor working time on this line, in seconds (all finished attempts).
  row[16] = workMs ? String(Math.round(workMs / 1000)) : '';
  // The tailor has this line open in the Atelier app but the timer is paused.
  // pausedReason is the pause reason text, or true when no reason was stored.
  // Lets Admin/Fulfillment see "Paused" instead of just "With tailor".
  row[17] = pausedReason ? 'Paused' : '';
  row[18] = (pausedReason && pausedReason !== true) ? String(pausedReason) : '';

  row[21] = rec.remarks || '';
  row[22] = rec.is_done ? 'Done' : '';
  row[23] = rec.notes || '';
  row[24] = rec.chest || '';
  row[25] = rec.sleeve || '';
  row[26] = rec.shoulder || '';
  row[27] = rec.armfit || '';
  row[28] = rec.length || '';
  row[29] = rec.size || '';
  row[30] = rec.urgent ? 'Yes' : '';
  row[31] = rec.urgent_due_date || '';
  row[32] = rec.created_at || '';
  row[33] = rec.done_at || '';
  row[34] = rec.garment_type || '';
  row[35] = rec.mach_emb_fabric || '';
  row[36] = (rec.mach_emb_meters_sent != null) ? String(rec.mach_emb_meters_sent) : '';
  row[37] = (rec.mach_emb_meters_received != null) ? String(rec.mach_emb_meters_received) : '';
  row[38] = rec.order_type || '';
  row[39] = rec.fabric_source || '';
  row[40] = rec.fabric_purchase_status || '';
  row[41] = rec.master_work || '';
  return row;
}

async function doGetOrders() {
  const records = await sbSelectAll('orders', 'id');
  const byId = {};
  let maxId = 0;
  records.forEach(rec => {
    byId[rec.id] = rec;
    if (rec.id > maxId) maxId = rec.id;
  });

  // Which (order_no, sku) lines are currently sitting in QC — an
  // atelier_jobs row with status 'pending' — so the dashboard can show
  // "QC" as its own stage instead of lumping it in with "With tailor".
  // Same query also totals each line's finished tailor time (see below).
  const lineInfo = await getAtelierLineInfoMap();

  const data = [new Array(41).fill(''), new Array(41).fill('')];
  for (let id = 1; id <= maxId; id++) {
    const rec = byId[id];
    const info = rec ? lineInfo.get((rec.order_no || '') + '|' + (rec.sku || '')) : null;
    data.push(isBlankOrder_(rec) ? null : buildOrderRowArray(rec, (info && info.qc) || false, info ? info.ms : 0, (info && info.paused) || false));
  }
  return { success: true, data };
}

// Every finished Atelier attempt (pending QC, approved, or sent back for
// rework) keeps the exact time the tailor's timer showed when they hit
// Finish. Adding those up per order line means the time is visible the
// moment the tailor finishes — not only once QC approves — and a redo after
// a rejection simply adds its extra time on top of the earlier attempt(s).
async function getAtelierLineInfoMap() {
  const map = new Map();
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const page = (await sbFetch('GET',
      `atelier_jobs?status=in.(pending,approved,rework,active)&select=*&order=id.asc&limit=${pageSize}&offset=${offset}`)) || [];
    page.forEach(j => {
      const key = (j.order_no || '') + '|' + (j.sku || '');
      const e = map.get(key) || { ms: 0, qc: false, paused: false };
      if (j.status === 'active') {
        // In progress on the tailor's tablet: paused when its timer isn't running.
        if (!j.run_since) e.paused = j.pause_reason || true;
        map.set(key, e);
        return;
      }
      e.ms += Number(j.duration_ms || 0);
      if (j.status === 'pending') e.qc = j.id;
      map.set(key, e);
    });
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return map;
}

// Single-order version, used when just one order is refreshed.
async function getOrderLineInfo(orderNo, sku) {
  if (!orderNo) return { qc: false, ms: 0 };
  let q = `atelier_jobs?order_no=eq.${encodeURIComponent(orderNo)}&status=in.(pending,approved,rework,active)&select=id,status,duration_ms,run_since,pause_reason`;
  if (sku) q += `&sku=eq.${encodeURIComponent(sku)}`;
  const rows = (await sbFetch('GET', q)) || [];
  const pend = rows.find(r => r.status === 'pending');
  const act = rows.find(r => r.status === 'active' && !r.run_since);
  return { qc: pend ? pend.id : false, paused: act ? (act.pause_reason || true) : false,
    ms: rows.filter(r => r.status !== 'active').reduce((a, r) => a + Number(r.duration_ms || 0), 0) };
}

// Single-order version of the QC check used in doGetOrders — is there a
// pending (QC) atelier job for this exact order line right now?
async function isOrderInQC(orderNo, sku) {
  if (!orderNo) return false;
  let q = `atelier_jobs?order_no=eq.${encodeURIComponent(orderNo)}&status=eq.pending&select=id&limit=1`;
  if (sku) q = `atelier_jobs?order_no=eq.${encodeURIComponent(orderNo)}&sku=eq.${encodeURIComponent(sku)}&status=eq.pending&select=id&limit=1`;
  const rows = await sbFetch('GET', q);
  return !!(rows && rows[0]);
}

// Fetches just ONE order (instead of the whole table) — used to refresh a
// single scanned/looked-up order without re-pulling every order in the
// system. This is the main thing that keeps Supabase egress low: scanning
// is by far the most frequent action in the app, and it used to trigger a
// full-table reload every single time.
async function doGetOrder(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const recs = await sbFetch('GET', `orders?id=eq.${row - 2}&select=*&limit=1`);
  const rec = recs && recs[0];
  if (!rec || isBlankOrder_(rec)) return { success: false, error: 'Order not found.' };
  const info = await getOrderLineInfo(rec.order_no, rec.sku);
  return { success: true, row, data: buildOrderRowArray(rec, info.qc, info.ms, info.paused) };
}

// Same idea as doGetOrder, but for when the caller only has the order
// number/SKU (e.g. a fresh QR scan or manual lookup not yet in the local
// cache) and doesn't know the internal row id yet.
async function doGetOrderByOrderNo(params) {
  const orderNo = (params.orderNo || '').toString().trim();
  if (!orderNo) return { success: false, error: 'Order number is required.' };
  const res = await resolveScannedLine(params);
  if (!res.ok) return { success: false, error: res.error, ambiguous: !!res.ambiguous };
  const recs = await sbFetch('GET', `orders?id=eq.${res.rec.id}&select=*&limit=1`);
  const rec = recs && recs[0];
  if (!rec) return { success: false, error: 'Order "' + orderNo + '" not found.' };
  const info = await getOrderLineInfo(rec.order_no, rec.sku);
  return { success: true, row: rec.id + 2, data: buildOrderRowArray(rec, info.qc, info.ms, info.paused) };
}

// Full timeline for one order line: recorded events, plus (for anything that
// happened before logging existed) milestones rebuilt from the timestamps
// already saved on the order and its tailoring jobs — flagged `legacy`.
async function doGetOrderTimeline(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const id = row - 2;
  const recs = await sbFetch('GET', `orders?id=eq.${id}&select=*&limit=1`);
  const rec = recs && recs[0];
  if (!rec || isBlankOrder_(rec)) return { success: false, error: 'Order not found.' };

  let events = [];
  let loggingReady = true;
  try {
    events = (await sbFetch('GET', `order_events?order_id=eq.${id}&select=at,kind,text,actor&order=at.asc,id.asc&limit=1000`)) || [];
  } catch (e) {
    loggingReady = false;
    console.error('order_events read failed (table missing?):', e.message);
  }
  events = events.map(e => ({ at: e.at, kind: e.kind, text: e.text, actor: e.actor || '', legacy: false }));

  // Rebuild what we can from saved timestamps, only for the period before
  // the first recorded event (so nothing is ever shown twice).
  const firstLogged = events.length ? new Date(events[0].at).getTime() : Infinity;
  const legacy = [];
  const push = (at, kind, text, actor) => {
    if (!at) return;
    const t = new Date(at).getTime();
    if (isNaN(t) || t >= firstLogged) return;
    legacy.push({ at: new Date(t).toISOString(), kind, text, actor: actor || '', legacy: true });
  };
  push(rec.created_at, 'added', 'Order added to production', '');
  if (rec.master) push(rec.master_assigned_at, 'cutting', `In cutting — assigned to Master: ${rec.master}`, '');
  if (rec.tailor) push(rec.tailor_assigned_at, 'tailoring', `Assigned to Tailor: ${rec.tailor}`, '');
  try {
    if (rec.order_no && rec.sku) {
      const jobs = (await sbFetch('GET', `atelier_jobs?order_no=eq.${encodeURIComponent(rec.order_no)}&sku=eq.${encodeURIComponent(rec.sku)}&select=*&order=start_at.asc`)) || [];
      jobs.forEach(j => {
        push(j.start_at, 'tailoring', `Tailoring started by ${j.tailor}`, j.tailor);
        push(j.end_at, 'qc', `Tailoring finished by ${j.tailor} — sent to QC`, j.tailor);
        if (j.approved_at) push(j.approved_at, 'qc', `QC approved by ${j.approved_by || 'supervisor'}`, j.approved_by);
        if (j.rework_at) push(j.rework_at, 'rework', `QC rejected${j.rejected_by ? ' by ' + j.rejected_by : ''} — ${j.reject_reason || 'rework'}`, j.rejected_by);
      });
    }
  } catch (e) { /* jobs are a bonus — never fail the timeline over them */ }
  if (rec.is_done && rec.done_at) push(rec.done_at, 'done', 'Marked Done — production complete', '');

  // Show how long the tailor actually spent stitching. Every finished attempt
  // (a job with a duration) gets its time attached to its "finished" event;
  // events written before this feature (or by the old "worked N min" wording)
  // are matched to their job by tailor + finish time.
  try {
    if (rec.order_no && rec.sku) {
      const jobs = (await sbFetch('GET', `atelier_jobs?order_no=eq.${encodeURIComponent(rec.order_no)}&sku=eq.${encodeURIComponent(rec.sku)}&duration_ms=not.is.null&select=tailor,end_at,duration_ms,status&order=end_at.asc`)) || [];
      const all0 = legacy.concat(events);
      let total = 0;
      jobs.forEach(j => {
        const dur = fmtDurationMs(j.duration_ms);
        total += Number(j.duration_ms || 0);
        const endT = j.end_at ? new Date(j.end_at).getTime() : NaN;
        const ev = all0.find(e => !e._durDone && /^Tailoring finished by/.test(e.text || '') && (e.text || '').indexOf(j.tailor) !== -1 &&
          !isNaN(endT) && Math.abs(new Date(e.at).getTime() - endT) < 120000);
        if (ev) {
          ev._durDone = true;
          ev.text = ev.text.replace(/\s*\(worked \d+ min\)/, '').replace(/\s*— stitching time .*$/, '') + ` — stitching time ${dur}`;
        } else if (!isNaN(endT)) {
          all0.push({ at: new Date(endT).toISOString(), kind: 'tailoring', text: `Stitching time by ${j.tailor}: ${dur}`, actor: j.tailor, legacy: true, _durDone: true });
          events.push(all0[all0.length - 1]);
        }
      });
      if (jobs.length > 1) {
        const last = all0.slice().reverse().find(e => e._durDone);
        if (last) last.text += ` (total across ${jobs.length} attempts: ${fmtDurationMs(total)})`;
      }
    }
  } catch (e) { /* timing is a bonus — never fail the timeline over it */ }

  const all = legacy.concat(events).filter((e, i, arr) => arr.indexOf(e) === i).sort((a, b) => new Date(a.at) - new Date(b.at));
  all.forEach(e => { delete e._durDone; });
  return {
    success: true, loggingReady,
    order: {
      orderNo: rec.order_no, sku: rec.sku, garmentType: rec.garment_type || '', orderType: rec.order_type || '',
      createdAt: rec.created_at || null, isDone: !!rec.is_done, urgent: !!rec.urgent
    },
    events: all
  };
}

function isBlankOrder_(rec) {
  return !rec || (!rec.order_no && !rec.sku);
}

async function doAddOrder(params) {
  const orderNo = (params.orderNo || '').toString().trim();
  const sku = (params.sku || '').toString().trim();
  if (!orderNo || !sku) return { success: false, error: 'Order # and SKU are required.' };

  const GARMENT_TYPES = ['Abaya', 'Vest', 'Pant', 'Skirt', 'Dress', 'Bisht', 'Blouse'];
  const garmentType = (params.garmentType || '').toString().trim();
  if (GARMENT_TYPES.indexOf(garmentType) === -1) {
    return { success: false, error: 'Please select a valid garment type.' };
  }

  const ORDER_TYPES = ['Simple', 'Hand Embroidery', 'Machine Embroidery'];
  const orderType = (params.orderType || '').toString().trim();
  if (ORDER_TYPES.indexOf(orderType) === -1) {
    return { success: false, error: 'Please select a valid order type.' };
  }

  const notes = (params.notes || '').toString();
  const chest = (params.chest || '').toString();
  const sleeve = (params.sleeve || '').toString();
  const shoulder = (params.shoulder || '').toString();
  const armfit = (params.armfit || '').toString();
  const length = (params.length || '').toString();
  const size = (params.size || '').toString();
  const urgent = (params.urgent === 'Yes');
  const urgentDate = urgent ? (params.urgentDate || '').toString() : '';

  if (urgent && !urgentDate) {
    return { success: false, error: 'Urgent orders require a "Produce by" date.' };
  }

  const srNo = (await sbGetMaxId('orders')) + 1;

  const created = await sbInsertOne('orders', {
    sr_no: srNo, order_no: orderNo, sku, garment_type: garmentType, order_type: orderType,
    notes, chest, sleeve, shoulder,
    armfit, length, size,
    urgent, urgent_due_date: urgentDate || null
  });

  pushShopifyUpdate(orderNo, `Order added to production — awaiting fabric check (SKU ${sku})`);

  return { success: true, row: created.id + 2, srNo };
}

const FABRIC_STATUSES = [
  'Available', 'Not Available',
  'Ready Made - Found in Factory', 'Ready Made - Stock'
];
const FABRIC_SOURCES = ['Kuwait', 'China'];
const FABRIC_PURCHASE_STATUSES = ['In Purchase', 'Not In Purchase'];

// A ready-made piece needs no cutting or sewing at all — it skips the
// master/tailor stage entirely and goes straight to "ready to mark Done."
function isReadyMadeStatus(value) {
  return value === 'Ready Made - Found in Factory' || value === 'Ready Made - Stock';
}

async function doUpdateFabric(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const value = params.value;
  if (FABRIC_STATUSES.indexOf(value) === -1) {
    return { success: false, error: 'Invalid fabric status.' };
  }

  const patch = { fabric_status: value, rework_note: null };

  if (value === 'Not Available') {
    const source = (params.source || '').toString();
    const purchaseStatus = (params.purchaseStatus || '').toString();
    if (FABRIC_SOURCES.indexOf(source) === -1) {
      return { success: false, error: 'Please pick where the fabric is being sourced from (Kuwait or China).' };
    }
    if (FABRIC_PURCHASE_STATUSES.indexOf(purchaseStatus) === -1) {
      return { success: false, error: 'Please pick the purchase status.' };
    }
    patch.fabric_source = source;
    patch.fabric_purchase_status = purchaseStatus;
  } else {
    // Switching away from Not Available clears those two fields — they're
    // meaningless for Available or either Ready Made status.
    patch.fabric_source = null;
    patch.fabric_purchase_status = null;
  }

  if (isReadyMadeStatus(value)) {
    // No cutting/sewing needed — clear any master/tailor assignment so the
    // order doesn't get stuck waiting on a step that will never happen.
    patch.master = null;
    patch.master_assigned_at = null; patch.master_work = null;
    patch.tailor = null;
    patch.tailor_assigned_at = null;
  }

  await sbUpdate('orders', row - 2, patch);

  const orderNo = await getOrderNo(row);
  let statusLine;
  if (value === 'Not Available') {
    statusLine = `Fabric: Not Available (${patch.fabric_source}, ${patch.fabric_purchase_status})`;
  } else {
    statusLine = `Fabric: ${value}`;
  }
  pushShopifyUpdate(orderNo, statusLine);

  return { success: true };
}

async function doUpdateFabricDetails(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const fabricName = (params.fabricName || '').toString().trim();
  const color = (params.fabricColor || '').toString().trim().replace(/\|/g, '/');
  const metersRaw = (params.meters || '').toString().trim();
  const meters = metersRaw !== '' && !isNaN(parseFloat(metersRaw)) ? String(parseFloat(metersRaw)) : '';
  // Color + meters are packed into the existing fabric_made_in column (no DB change).
  await sbUpdate('orders', row - 2, {
    fabric_name: fabricName || null,
    fabric_made_in: (color || meters) ? 'C:' + color + '|M:' + meters : null
  });
  return { success: true };
}

async function doUpdateMachEmb(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const value = params.value;

  if (value === 'CLEAR') {
    // Undo a "skip" — back to the same blank state a never-touched order
    // starts in, so it can be sent for real from here.
    await sbUpdate('orders', row - 2, {
      mach_emb_person: null,
      machine_emb: null, mach_emb_fabric: null,
      mach_emb_meters_sent: null, mach_emb_meters_received: null
    });
    return { success: true };
  }

  if (!/^(NEED|RED|GREEN|SKIP)\|/.test(value || '')) {
    return { success: false, error: 'Invalid machine embroidery value format.' };
  }

  const patch = { machine_emb: value, mach_emb_person: value.startsWith('RED|') ? ((params.person || '').toString() || null) : null };
  let match = null;

  if (value.startsWith('RED|')) {
    // A fresh "send" — record what's going out, and clear any previous
    // received figure so it can't be mistaken for this trip's numbers.
    const fabric = (params.fabric || '').toString().trim();
    const metersSentRaw = params.metersSent;
    const metersSent = (metersSentRaw !== undefined && metersSentRaw !== '' && !isNaN(parseFloat(metersSentRaw)))
      ? parseFloat(metersSentRaw) : null;
    patch.mach_emb_fabric = fabric || null;
    patch.mach_emb_meters_sent = metersSent;
    patch.mach_emb_meters_received = null;
  } else if (value.startsWith('GREEN|')) {
    const metersReceivedRaw = params.metersReceived;
    const metersReceived = (metersReceivedRaw !== undefined && metersReceivedRaw !== '' && !isNaN(parseFloat(metersReceivedRaw)))
      ? parseFloat(metersReceivedRaw) : null;
    patch.mach_emb_meters_received = metersReceived;

    const existing = await sbFetch('GET', `orders?id=eq.${row - 2}&select=mach_emb_meters_sent`);
    const sentVal = (existing && existing[0]) ? existing[0].mach_emb_meters_sent : null;
    if (sentVal != null && metersReceived != null) {
      match = (Number(sentVal) === Number(metersReceived));
    }
  }

  await sbUpdate('orders', row - 2, patch);
  return { success: true, match };
}

// Masters and tailors can hand an order to a named embroiderer. The person
// is stored alongside the usual sent ("RED|time") marker so the admin list
// can show exactly who has it — Abdullah/Asif for machine, Akil for hand.
// ── Machine embroidery person (admin choice) ─────────────────────────────
// Fulfillment marks machine embroidery as needed; the ADMIN decides whether
// Abdullah (before cutting) or Asif (after the tailor has stitched) does it.
const MACH_PEOPLE = ['Abdullah', 'Asif'];
async function loadEmbRec(row) {
  const rows = await sbFetch('GET', `orders?id=eq.${row - 2}&select=id,order_no,sku,master,tailor,is_done,machine_emb,hand_emb,mach_emb_person,hand_emb_person,master_work&limit=1`);
  return rows && rows[0];
}
async function doSetEmbPerson(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const person = (params.person || '').toString();
  if (person && MACH_PEOPLE.indexOf(person) === -1) return { success: false, error: 'Choose Abdullah or Asif.' };
  const rec = await loadEmbRec(row);
  if (!rec) return { success: false, error: 'Order not found.' };
  const cur = parseEmbValue(rec.machine_emb).code;
  if (['NEED', 'RED'].indexOf(cur) === -1) return { success: false, error: 'Machine embroidery is not waiting to be assigned (it has already started, finished or is not needed).' };
  await sbUpdate('orders', row - 2, { machine_emb: 'NEED|' + embStampNow(), mach_emb_person: person || null });
  return { success: true, kind: 'mach', person };
}

// Tailor (after stitching) scans and hands the piece to Asif.
async function doSendOrderEmb(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const person = (params.person || '').toString();
  if (person === 'Akil') return { success: false, error: 'Hand embroidery is sent by the master once cutting is done.' };
  if (person !== 'Asif') return { success: false, error: person === 'Abdullah' ? 'Abdullah works before cutting — the admin receives it from him.' : 'Unknown embroidery person: ' + person };
  const rec = await loadEmbRec(row);
  if (!rec) return { success: false, error: 'Order not found.' };
  if (!rec.tailor) return { success: false, error: 'No tailor is assigned to this order yet.' };
  const cur = parseEmbValue(rec.machine_emb).code;
  if (['NEED', 'RED'].indexOf(cur) === -1) return { success: false, error: 'This order is not waiting for machine embroidery.' };
  if (rec.mach_emb_person !== 'Asif') return { success: false, error: rec.mach_emb_person ? 'Admin chose ' + rec.mach_emb_person + ' for this order, not Asif.' : 'The admin has not chosen Asif for this order yet.' };
  const value = 'SENT|' + embStampNow();
  await sbUpdate('orders', row - 2, { machine_emb: value });
  pushShopifyUpdate(rec.order_no, 'Machine embroidery — with Asif');
  return { success: true, kind: 'mach', person, tailor: rec.tailor, value };
}

// Master scans when cutting is done → ready for hand embroidery (Akil).
async function doEmbReady(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const rec = await loadEmbRec(row);
  if (!rec) return { success: false, error: 'Order not found.' };
  if (!rec.master) return { success: false, error: 'No master is assigned to this order yet.' };
  const cur = parseEmbValue(rec.hand_emb).code;
  if (cur === 'READY') return { success: true, already: true, kind: 'hand' };
  if (['NEED', 'RED'].indexOf(cur) === -1) return { success: false, error: 'This order is not waiting for hand embroidery.' };
  const value = 'READY|' + embStampNow();
  const patch = { hand_emb: value };
  // Handing over to hand embroidery ends the master's cutting time (timer stops here).
  const mw = parseMasterWork(rec.master_work);
  let totalMs = 0;
  if (mw.st === 'WORK' || mw.st === 'PAUSE') {
    const acc = (Number(mw.acc) || 0) + (mw.st === 'WORK' ? Math.max(0, Date.now() - Number(mw.run || Date.now())) : 0);
    const w = Object.assign({}, mw, { st: 'DONE', fin: new Date().toISOString(), acc, run: 0, reason: '' });
    patch.master_work = JSON.stringify(w);
    totalMs = mwTotal(w);
  }
  await sbUpdate('orders', row - 2, patch);
  pushShopifyUpdate(rec.order_no, 'Hand embroidery — ready for Akil');
  return { success: true, kind: 'hand', value, totalMs };
}

// Akil (hand desk) picks the person who will do the work.
async function doEmbAssignWorker(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const worker = (params.worker || '').toString().trim();
  const names = await getActiveStaffNames('handembworker');
  if (names.indexOf(worker) === -1) return { success: false, error: 'Unknown hand-embroidery person: ' + worker };
  const rec = await loadEmbRec(row);
  if (!rec) return { success: false, error: 'Order not found.' };
  if (parseEmbValue(rec.hand_emb).code !== 'RCVD') return { success: false, error: 'Receive the order first, then assign a person.' };
  await sbUpdate('orders', row - 2, { hand_emb_person: worker });
  return { success: true, kind: 'hand', person: worker };
}

// Admin receives Abdullah's finished piece; the master can be chosen after this.
async function doEmbAdminReceive(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const rec = await loadEmbRec(row);
  if (!rec) return { success: false, error: 'Order not found.' };
  const cur = parseEmbValue(rec.machine_emb).code;
  if (cur === 'AREC') return { success: true, already: true, kind: 'mach' };
  if (['DONE', 'GREEN'].indexOf(cur) === -1) return { success: false, error: 'Machine embroidery is not finished yet.' };
  const value = 'AREC|' + embStampNow();
  await sbUpdate('orders', row - 2, { machine_emb: value });
  pushShopifyUpdate(rec.order_no, 'Machine embroidery — received by admin');
  return { success: true, kind: 'mach', person: rec.mach_emb_person, value };
}

// Master receives the piece back from hand embroidery; then assigns the tailor.
async function doEmbMasterReceive(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const rec = await loadEmbRec(row);
  if (!rec) return { success: false, error: 'Order not found.' };
  const cur = parseEmbValue(rec.hand_emb).code;
  if (cur === 'MREC') return { success: true, already: true, kind: 'hand' };
  if (['DONE', 'GREEN'].indexOf(cur) === -1) return { success: false, error: 'Hand embroidery is not finished yet.' };
  const value = 'MREC|' + embStampNow();
  await sbUpdate('orders', row - 2, { hand_emb: value });
  pushShopifyUpdate(rec.order_no, 'Hand embroidery — received by master');
  return { success: true, kind: 'hand', person: rec.hand_emb_person, value };
}

// ============================================================
// EMBROIDERY WORKFLOW (hand + machine desks)
// Stored as text in orders.hand_emb / orders.machine_emb — no new columns:
//   NEED|<stamp>                         needs embroidery (set when the order is added)
//   RED|<stamp>                          legacy "sent out" — treated exactly like NEED
//   RCVD|<stamp>                         desk scanned it and received it
//   WORK|<startStamp>|<accumMs>|<runSinceEpochMs>   timer running
//   PAUSE|<stamp>|<accumMs>|<reason>     timer paused with a reason
//   DONE|<stamp>|<totalMs>               finished
//   GREEN|<stamp>                        legacy "returned" — treated like DONE
//   SKIP|<stamp>                         not needed
// ============================================================
const EMB_PAUSE_REASONS = {
  hand: ['No Material', 'Break', 'Need Fabric'],
  mach: ['No Thread', "Designer's Confirmation", 'Break']
};
function embStampNow() {
  return new Date().toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function parseEmbValue(val) {
  const p = (val || '').toString().split('|');
  const code = p[0] || '';
  if (code === 'WORK')  return { code, stamp: p[1] || '', accumMs: Number(p[2]) || 0, runSince: Number(p[3]) || 0 };
  if (code === 'PAUSE') return { code, stamp: p[1] || '', accumMs: Number(p[2]) || 0, reason: p[3] || '' };
  if (code === 'DONE')  return { code, stamp: p[1] || '', totalMs: Number(p[2]) || 0 };
  return { code, stamp: p[1] || '' };
}
// Server-side guard: an embroidery desk may only touch its own kind.
function embKindFor(params) {
  const kind = (params.kind || '').toString();
  if (kind !== 'mach' && kind !== 'hand') return { error: 'Invalid embroidery kind.' };
  const role = (params.role || '').toString();
  if (role === 'handemb' && kind !== 'hand') return { error: 'Hand embroidery desk can only work on hand embroidery.' };
  if (role === 'machemb' && kind !== 'mach') return { error: 'Machine embroidery desk can only work on machine embroidery.' };
  return { kind };
}
async function loadEmbOrder(params) {
  const row = parseRow(params);
  if (!row) return { error: 'Invalid row.' };
  const k = embKindFor(params);
  if (k.error) return { error: k.error };
  const col = k.kind === 'mach' ? 'machine_emb' : 'hand_emb';
  const rows = await sbFetch('GET', `orders?id=eq.${row - 2}&select=id,order_no,master,tailor,is_done,mach_emb_person,hand_emb_person,${col}&limit=1`);
  const rec = rows && rows[0];
  if (!rec) return { error: 'Order not found.' };
  const person = k.kind === 'mach' ? rec.mach_emb_person : rec.hand_emb_person;
  return { rec, col, kind: k.kind, id: row - 2, person: person || '', cur: parseEmbValue(rec[col]) };
}
async function saveEmb(ctx, value) {
  await sbUpdate('orders', ctx.id, { [ctx.col]: value });
}
const embKindWord = kind => (kind === 'mach' ? 'machine' : 'hand');

// New value codes (same text columns, no DB change):
//   SENT|<stamp>   machine: tailor handed the piece to Asif
//   READY|<stamp>  hand: master finished cutting, ready for Akil
//   AREC|<stamp>   machine: admin received Abdullah's finished piece
//   MREC|<stamp>   hand: master received the finished piece
async function doEmbReceive(params) {
  const ctx = await loadEmbOrder(params);
  if (ctx.error) return { success: false, error: ctx.error };
  if (ctx.kind === 'mach') return { success: false, error: 'Machine embroidery starts directly — scan the label to start work.' };
  if (ctx.cur.code === 'RCVD') return { success: true, already: true };
  if (ctx.cur.code !== 'READY') {
    return { success: false, error: ['NEED', 'RED'].indexOf(ctx.cur.code) !== -1
      ? 'Not ready yet — the master must scan it first once cutting is done.'
      : 'This order is not waiting to be received for hand embroidery.' };
  }
  const value = 'RCVD|' + embStampNow();
  await saveEmb(ctx, value);
  pushShopifyUpdate(ctx.rec.order_no, 'hand embroidery — received');
  return { success: true, value };
}

async function doEmbStart(params) {
  const ctx = await loadEmbOrder(params);
  if (ctx.error) return { success: false, error: ctx.error };
  if (ctx.cur.code === 'WORK') return { success: true, already: true, person: ctx.person };
  const code = ctx.cur.code;
  if (ctx.kind === 'mach') {
    if (!ctx.person) return { success: false, error: 'The admin has not chosen Abdullah or Asif for this order yet.' };
    if (ctx.person === 'Abdullah' && ['NEED', 'RED', 'RCVD'].indexOf(code) === -1) return { success: false, error: 'This order cannot be started right now.' };
    if (ctx.person === 'Asif' && ['SENT', 'RCVD'].indexOf(code) === -1) {
      return { success: false, error: ['NEED', 'RED'].indexOf(code) !== -1 ? 'Waiting for the tailor to hand this to Asif first.' : 'This order cannot be started right now.' };
    }
  } else {
    if (code !== 'RCVD') return { success: false, error: ['NEED', 'RED', 'READY'].indexOf(code) !== -1 ? 'Receive this order first (the master must have marked it ready).' : 'This order cannot be started right now.' };
    if (!ctx.person) return { success: false, error: 'Assign a person to this order before starting.' };
  }
  const value = `WORK|${embStampNow()}|0|${Date.now()}`;
  await saveEmb(ctx, value);
  pushShopifyUpdate(ctx.rec.order_no, `${embKindWord(ctx.kind)} embroidery — working${ctx.person ? ' (' + ctx.person + ')' : ''}`);
  return { success: true, value, person: ctx.person };
}

async function doEmbPause(params) {
  const ctx = await loadEmbOrder(params);
  if (ctx.error) return { success: false, error: ctx.error };
  const reason = (params.reason || '').toString().trim();
  if (EMB_PAUSE_REASONS[ctx.kind].indexOf(reason) === -1) {
    return { success: false, error: 'Please choose a reason to pause.' };
  }
  if (ctx.cur.code !== 'WORK') return { success: false, error: 'Nothing is running to pause.' };
  const accum = ctx.cur.accumMs + (ctx.cur.runSince ? Date.now() - ctx.cur.runSince : 0);
  const value = `PAUSE|${embStampNow()}|${Math.round(accum)}|${reason}`;
  await saveEmb(ctx, value);
  return { success: true, value, person: ctx.person };
}

async function doEmbResume(params) {
  const ctx = await loadEmbOrder(params);
  if (ctx.error) return { success: false, error: ctx.error };
  if (ctx.cur.code === 'WORK') return { success: true, already: true, person: ctx.person };
  if (ctx.cur.code !== 'PAUSE') return { success: false, error: 'This order is not paused.' };
  const value = `WORK|${embStampNow()}|${ctx.cur.accumMs}|${Date.now()}`;
  await saveEmb(ctx, value);
  return { success: true, value, person: ctx.person };
}

async function doEmbFinish(params) {
  const ctx = await loadEmbOrder(params);
  if (ctx.error) return { success: false, error: ctx.error };
  if (ctx.cur.code !== 'WORK' && ctx.cur.code !== 'PAUSE') {
    return { success: false, error: 'Start this order before finishing it.' };
  }
  const total = ctx.cur.accumMs + (ctx.cur.code === 'WORK' && ctx.cur.runSince ? Date.now() - ctx.cur.runSince : 0);
  const value = `DONE|${embStampNow()}|${Math.round(total)}`;
  await saveEmb(ctx, value);
  pushShopifyUpdate(ctx.rec.order_no, `${embKindWord(ctx.kind)} embroidery — done ✅`);
  const out = { success: true, value, person: ctx.person };
  if (ctx.kind === 'mach' && ctx.person === 'Asif') out.backTo = 'tailor' + (ctx.rec.tailor ? ' ' + ctx.rec.tailor : '');
  else if (ctx.kind === 'mach') out.readyFor = 'admin to receive';
  else out.readyFor = 'master' + (ctx.rec.master ? ' ' + ctx.rec.master : '');
  return out;
}

// Gives the order back to the start of this desk's step. The timer for that
// attempt is dropped.
async function doEmbReturn(params) {
  const ctx = await loadEmbOrder(params);
  if (ctx.error) return { success: false, error: ctx.error };
  if (['RCVD', 'WORK', 'PAUSE'].indexOf(ctx.cur.code) === -1 && !(ctx.kind === 'mach' && ctx.cur.code === 'SENT') && !(ctx.kind === 'hand' && ctx.cur.code === 'READY')) {
    return { success: false, error: 'Nothing to return — this order is not with you.' };
  }
  let value;
  if (ctx.kind === 'mach') value = (ctx.person === 'Asif' ? 'SENT|' : 'NEED|') + embStampNow();
  else value = 'READY|' + embStampNow();
  if (ctx.kind === 'hand') await sbUpdate('orders', ctx.id, { hand_emb: value, hand_emb_person: null });
  else await saveEmb(ctx, value);
  return { success: true, value, person: ctx.person };
}

async function doUpdateHandEmb(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const value = params.value;

  if (value === 'CLEAR') {
    await sbUpdate('orders', row - 2, { hand_emb: null, hand_emb_person: null });
    return { success: true };
  }

  if (!/^(NEED|RED|GREEN|SKIP)\|/.test(value || '')) {
    return { success: false, error: 'Invalid hand embroidery value format.' };
  }
  await sbUpdate('orders', row - 2, { hand_emb: value, hand_emb_person: value.startsWith('RED|') ? ((params.person || '').toString() || null) : null });
  return { success: true };
}

async function doUpdateMaster(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const master = (params.master || '').toString();
  const id = row - 2;

  if (master === '') {
    await sbUpdate('orders', id, { master: null, master_assigned_at: null, master_work: null, master_work: null });
    pushShopifyUpdate(await getOrderNo(row), 'Master unassigned');
    return { success: true };
  }
  const masters = await getActiveStaffNames('master');
  if (masters.indexOf(master) === -1) {
    return { success: false, error: 'Unknown master: ' + master };
  }
  {
    const rec = await loadEmbRec(row);
    if (rec && !rec.master && rec.mach_emb_person === 'Abdullah' && ['NEED', 'RED', 'RCVD', 'WORK', 'PAUSE', 'DONE', 'GREEN'].indexOf(parseEmbValue(rec.machine_emb).code) !== -1) {
      return { success: false, error: 'Abdullah must finish the machine embroidery and the admin must receive it before a master is chosen.' };
    }
  }
  await sbUpdate('orders', id, { master, master_assigned_at: new Date().toISOString(), master_work: null });
  pushShopifyUpdate(await getOrderNo(row), `In cutting — assigned to Master: ${master}`);
  return { success: true };
}

// ── MASTER CUTTING TIMER (scan to start / finish) ────────────────────────
// Stored as JSON in orders.master_work (needs: ALTER TABLE orders ADD COLUMN master_work text).
// {st:'WORK'|'PAUSE'|'DONE', start:iso, fin:iso, acc:ms, run:epochMs, reason, prev:ms (earlier attempts)}
function parseMasterWork(v) {
  try { const o = JSON.parse(v || '{}'); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; }
}
function mwTotal(w) {
  if (!w) return 0;
  return (Number(w.prev) || 0) + (Number(w.acc) || 0) + (w.st === 'WORK' && w.run ? Math.max(0, Date.now() - Number(w.run)) : 0);
}
const MASTER_RETURN_REASONS = ['Fabric damage', 'Fabric not available'];
const MASTER_PAUSE_REASONS = ['Break', 'No Material', 'Need Fabric', 'Other'];
async function loadMasterCtx(params) {
  const row = parseRow(params);
  if (!row) return { error: 'Invalid row.' };
  const rec = await loadEmbRec(row);
  if (!rec) return { error: 'Order not found.' };
  if (!rec.master) return { error: 'No cutting master is assigned to this order yet.' };
  const role = (params.role || '').toString(), name = (params.authenticatedName || '').toString();
  if (role === 'master' && name && rec.master !== name) return { error: 'This order is assigned to master ' + rec.master + ', not you.' };
  return { rec, row, id: row - 2, w: parseMasterWork(rec.master_work) };
}
async function saveMw(ctx, w) {
  await sbUpdate('orders', ctx.id, { master_work: JSON.stringify(w) });
  return w;
}
async function doMasterStart(params) {
  const c = await loadMasterCtx(params); if (c.error) return { success: false, error: c.error };
  if (c.w.st === 'WORK') return { success: true, already: true, work: c.w };
  if (c.w.st === 'PAUSE') return doMasterResume(params);
  if (c.w.st === 'DONE') return { success: false, error: 'Cutting is already finished for this order.' };
  if (c.rec.mach_emb_person === 'Abdullah' && ['NEED', 'RED', 'RCVD', 'WORK', 'PAUSE', 'DONE', 'GREEN'].indexOf(parseEmbValue(c.rec.machine_emb).code) !== -1) {
    return { success: false, error: 'Abdullah must finish the machine embroidery and the admin must receive it first.' };
  }
  const w = await saveMw(c, { st: 'WORK', start: new Date().toISOString(), acc: 0, run: Date.now(), prev: Number(c.w.prev) || 0 });
  pushShopifyUpdate(c.rec.order_no, `Cutting started — Master ${c.rec.master}`);
  return { success: true, work: w, master: c.rec.master };
}
async function doMasterPause(params) {
  const c = await loadMasterCtx(params); if (c.error) return { success: false, error: c.error };
  const reason = (params.reason || '').toString().trim();
  if (!reason) return { success: false, error: 'Please choose a reason to pause.' };
  if (c.w.st !== 'WORK') return { success: false, error: 'The timer is not running.' };
  const w = await saveMw(c, Object.assign({}, c.w, { st: 'PAUSE', acc: (Number(c.w.acc) || 0) + Math.max(0, Date.now() - Number(c.w.run || Date.now())), run: 0, reason }));
  return { success: true, work: w, master: c.rec.master, reason };
}
async function doMasterResume(params) {
  const c = await loadMasterCtx(params); if (c.error) return { success: false, error: c.error };
  if (c.w.st === 'WORK') return { success: true, already: true, work: c.w };
  if (c.w.st !== 'PAUSE') return { success: false, error: 'Nothing to resume.' };
  const w = await saveMw(c, Object.assign({}, c.w, { st: 'WORK', run: Date.now(), reason: '' }));
  return { success: true, work: w, master: c.rec.master };
}
async function doMasterFinish(params) {
  const c = await loadMasterCtx(params); if (c.error) return { success: false, error: c.error };
  if (c.w.st === 'DONE') return { success: true, already: true, work: c.w };
  if (c.w.st !== 'WORK' && c.w.st !== 'PAUSE') return { success: false, error: 'Start cutting before finishing.' };
  const acc = (Number(c.w.acc) || 0) + (c.w.st === 'WORK' ? Math.max(0, Date.now() - Number(c.w.run || Date.now())) : 0);
  const w = await saveMw(c, Object.assign({}, c.w, { st: 'DONE', fin: new Date().toISOString(), acc, run: 0, reason: '' }));
  pushShopifyUpdate(c.rec.order_no, `Cutting finished — Master ${c.rec.master}`);
  return { success: true, work: w, master: c.rec.master, totalMs: mwTotal(w) };
}
// Master cannot cut (fabric damaged / not available): order goes back to unassigned.
async function doMasterReturn(params) {
  const c = await loadMasterCtx(params); if (c.error) return { success: false, error: c.error };
  const reason = (params.reason || '').toString().trim();
  if (MASTER_RETURN_REASONS.indexOf(reason) === -1) return { success: false, error: 'Choose Fabric damage or Fabric not available.' };
  if (c.w.st === 'DONE') return { success: false, error: 'Cutting is already finished — it cannot be returned.' };
  const patch = { master: null, master_assigned_at: null, master_work: null, master_work: null,
    rework_note: `↩ Returned by master ${c.rec.master} — ${reason}. ${new Date().toLocaleString()}` };
  patch.fabric_status = reason === 'Fabric not available' ? 'Not Available' : null;
  await sbUpdate('orders', c.id, patch);
  pushShopifyUpdate(c.rec.order_no, `Returned by master — ${reason}`);
  return { success: true, master: c.rec.master, reason };
}

async function doUpdateTailor(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const tailor = (params.tailor || '').toString();
  const id = row - 2;

  if (tailor === '') {
    await sbUpdate('orders', id, { tailor: null, tailor_assigned_at: null });
    pushShopifyUpdate(await getOrderNo(row), 'Tailor unassigned');
    return { success: true };
  }
  const tailors = await getActiveStaffNames('tailor');
  if (tailors.indexOf(tailor) === -1) {
    return { success: false, error: 'Unknown tailor: ' + tailor };
  }
  if ((params.role || '') === 'master') {
    const rec = await loadEmbRec(row);
    const mw = parseMasterWork(rec && rec.master_work);
    if (mw.st !== 'DONE') {
      return { success: false, error: mw.st === 'WORK' || mw.st === 'PAUSE' ? 'Finish your cutting first (scan the label again or tap Finish), then assign the tailor.' : 'Scan the label to start cutting first, then finish it before assigning the tailor.' };
    }
    const mc = rec ? parseEmbValue(rec.machine_emb).code : '';
    if (rec && rec.mach_emb_person === 'Abdullah' && ['NEED', 'RED', 'RCVD', 'WORK', 'PAUSE', 'DONE', 'GREEN'].indexOf(mc) !== -1) {
      return { success: false, error: 'Machine embroidery (Abdullah) must be finished and received by the admin first.' };
    }
    const hc = rec ? parseEmbValue(rec.hand_emb).code : '';
    if (['NEED', 'RED', 'READY', 'RCVD', 'WORK', 'PAUSE', 'DONE', 'GREEN'].indexOf(hc) !== -1) {
      return { success: false, error: hc === 'DONE' || hc === 'GREEN' ? 'Receive the item from hand embroidery first, then assign the tailor.' : 'This order needs hand embroidery first — scan it as ready, then receive it back before assigning a tailor.' };
    }
  }
  await sbUpdate('orders', id, { tailor, tailor_assigned_at: new Date().toISOString(), rework_note: null });
  pushShopifyUpdate(await getOrderNo(row), `With Tailor: ${tailor}`);
  return { success: true };
}

async function doMarkDone(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const id = row - 2;

  const rec = await sbFetch('GET', 'orders?id=eq.' + id + '&select=tailor,fabric_status,order_no');
  const s = rec && rec[0];
  if (!s) return { success: false, error: 'Order not found.' };
  if (isReadyMadeStatus(s.fabric_status)) {
    return { success: false, error: 'Ready-made items must be scanned and approved by the supervisor.' };
  }
  if (!s.tailor) {
    return { success: false, error: 'Cannot mark Done — no tailor has been assigned yet.' };
  }
  await sbUpdate('orders', id, { is_done: true, done_at: new Date().toISOString() });
  pushShopifyUpdate(s.order_no, 'Production complete — Done ✅');
  return { success: true };
}

// ── READY-MADE APPROVALS (supervisor) ────────────────────────────────────
// Ready-made pieces never get a tailor job, so they can't be finished by
// anyone but the supervisor: scan → Approve (marks Done) or Reject (sends it
// back to a tailor, a master, or the fabric step).
function readyMadeLabelOf(fabric) {
  return fabric === 'Ready Made - Found in Factory' ? 'Ready made (Factory)' : 'Ready made (Stock)';
}
function formatReadyMade(r) {
  return { row: r.id + 2, orderNo: r.order_no, sku: r.sku, garmentType: r.garment_type || '',
           fabric: readyMadeLabelOf(r.fabric_status), urgent: !!r.urgent };
}
async function doReadyMadeList() {
  const rows = (await sbFetch('GET', `orders?is_done=eq.false&fabric_status=like.${encodeURIComponent('Ready Made*')}&select=id,order_no,sku,garment_type,fabric_status,urgent&order=id.asc`)) || [];
  const [tailors, masters] = await Promise.all([getActiveStaffNames('tailor'), getActiveStaffNames('master')]);
  return { success: true, items: rows.map(formatReadyMade), tailors, masters };
}
// ---- Resolve a scanned label to ONE exact order line ----------------------
// A label's QR holds order number, SKU and the row id. The same order number
// can exist on several lines (different SKUs, or "-ex" remakes), so matching
// on the order number alone can open the WRONG line. Resolution order:
//   1) row id (unique) — accepted only if its order number (and SKU, when the
//      label has one) agree with what the label says;
//   2) order number + SKU;
//   3) order number alone — only when exactly ONE line has that number.
// Otherwise the scan is refused (ambiguous) instead of guessing.
async function resolveScannedLine(params) {
  const norm = v => (v == null ? '' : String(v)).trim().toLowerCase();
  const orderNo = (params.orderNo || '').toString().trim();
  const sku = (params.sku || '').toString().trim();
  const rowId = parseInt(params.row, 10);
  const id = rowId > 2 ? rowId - 2 : null;
  if (id) {
    const r = ((await sbFetch('GET', `orders?id=eq.${id}&select=id,order_no,sku,garment_type,fabric_status,is_done,tailor&limit=1`)) || [])[0];
    if (r && norm(r.order_no) === norm(orderNo) && (!sku || norm(r.sku) === norm(sku))) return { ok: true, rec: r };
    // row didn't agree with the label -> don't trust it, fall through to order+sku
  }
  if (!orderNo) return { ok: false, error: "Scanned code didn't contain an order number." };
  let q = `orders?order_no=eq.${encodeURIComponent(orderNo)}&select=id,order_no,sku,garment_type,fabric_status,is_done,tailor&order=id.asc&limit=50`;
  if (sku) q += `&sku=eq.${encodeURIComponent(sku)}`;
  const rows = (await sbFetch('GET', q)) || [];
  if (!rows.length) return { ok: false, error: 'Order "' + orderNo + '"' + (sku ? ' / SKU ' + sku : '') + ' not found.' };
  if (rows.length === 1) return { ok: true, rec: rows[0] };
  // Several rows share this order number (+SKU). Prefer the only one that is still open.
  const open = rows.filter(r => !r.is_done);
  if (sku && open.length === 1) return { ok: true, rec: open[0] };
  const list = rows.map(r => (r.sku || '—') + (r.is_done ? ' (done)' : '')).join(', ');
  return { ok: false, ambiguous: true,
    error: `Order ${orderNo} has ${rows.length} lines (SKU: ${list}). This label can't identify which one — scan the label that includes the SKU, or open it from the list.` };
}

async function doReadyMadeFindByCode(params) {
  const res = await resolveScannedLine(params);
  if (!res.ok) return { success: false, error: res.error };
  const rec = res.rec;
  if (!isReadyMadeStatus(rec.fabric_status)) return { success: false, notReadyMade: true, error: 'Not a ready-made order.' };
  if (rec.is_done) return { success: false, error: 'This ready-made order is already approved.' };
  const [tailors, masters] = await Promise.all([getActiveStaffNames('tailor'), getActiveStaffNames('master')]);
  return { success: true, item: formatReadyMade(rec), tailors, masters };
}
async function getPendingReadyMade(params) {
  const row = parseRow(params);
  if (!row) return { error: 'Invalid row.' };
  const rec = ((await sbFetch('GET', 'orders?id=eq.' + (row - 2) + '&select=id,order_no,fabric_status,is_done')) || [])[0];
  if (!rec) return { error: 'Order not found.' };
  if (!isReadyMadeStatus(rec.fabric_status)) return { error: 'This order is not a ready-made item.' };
  if (rec.is_done) return { error: 'This order is already approved.' };
  return { rec };
}
async function doReadyMadeApprove(params) {
  const chk = await getPendingReadyMade(params);
  if (chk.error) return { success: false, error: chk.error };
  await sbUpdate('orders', chk.rec.id, { is_done: true, done_at: new Date().toISOString(), rework_note: null });
  pushShopifyUpdate(chk.rec.order_no, 'Production complete — Done ✅');
  return { success: true };
}
async function doReadyMadeReject(params) {
  const chk = await getPendingReadyMade(params);
  if (chk.error) return { success: false, error: chk.error };
  const reason = (params.reason || '').toString();
  const person = (params.person || '').toString().trim();
  const approver = (params.authenticatedName || params.role || '').toString();
  const stamp = new Date().toLocaleString();
  const now = new Date().toISOString();
  // Leaves the ready-made status so the piece re-enters normal production.
  const base = { fabric_source: null, fabric_purchase_status: null };
  let patch;
  if (reason === 'tailor') {
    if (!person) return { success: false, error: 'Please select the tailor number.' };
    if ((await getActiveStaffNames('tailor')).indexOf(person) === -1) return { success: false, error: 'Unknown tailor: ' + person };
    patch = Object.assign(base, { fabric_status: 'Available', tailor: person, tailor_assigned_at: now,
      rework_note: `⚠️ Ready-made rejected — Tailor's issue (${person}) — please redo. By ${approver}, ${stamp}.` });
  } else if (reason === 'master') {
    if (!person) return { success: false, error: 'Please select the master.' };
    if ((await getActiveStaffNames('master')).indexOf(person) === -1) return { success: false, error: 'Unknown master: ' + person };
    patch = Object.assign(base, { fabric_status: 'Available', master: person, master_assigned_at: now, master_work: null, tailor: null, tailor_assigned_at: null,
      rework_note: `⚠️ Ready-made rejected — Master's issue (${person}) — needs re-cut. By ${approver}, ${stamp}.` });
  } else if (reason === 'fabric') {
    // Back to the fabric-check step with "Remake" written on the order.
    patch = Object.assign(base, { fabric_status: null, master: null, master_assigned_at: null, master_work: null, tailor: null, tailor_assigned_at: null,
      rework_note: `⚠️ Remake — ready-made rejected (fabric). By ${approver}, ${stamp}.` });
  } else {
    return { success: false, error: 'Please choose Tailor, Master or Fabric.' };
  }
  await sbUpdate('orders', chk.rec.id, patch);
  return { success: true };
}

async function doUndoMarkDone(params) {
  // Admin-only escape hatch for orders accidentally marked Done (e.g. a
  // tailor scanned the wrong QR code) — puts it back to "not done" so it
  // can be scanned and completed for real. Not exposed to any other role.
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  await sbUpdate('orders', row - 2, { is_done: false, done_at: null });
  return { success: true };
}

async function doDeleteOrder(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  await sbUpdate('orders', row - 2, {
    sr_no: null, order_no: null, sku: null, fabric_status: null,
    fabric_name: null, fabric_made_in: null, garment_type: null, order_type: null,
    fabric_source: null, fabric_purchase_status: null,
    master: null, master_assigned_at: null, master_work: null, machine_emb: null, hand_emb: null,
    mach_emb_fabric: null, mach_emb_meters_sent: null, mach_emb_meters_received: null,
    tailor: null, tailor_assigned_at: null, remarks: null,
    is_done: false, done_at: null, notes: null,
    chest: null, sleeve: null, shoulder: null, armfit: null, length: null, size: null,
    urgent: false, urgent_due_date: null
  });
  return { success: true };
}

async function doUpdateUrgent(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const urgent = (params.urgent === 'Yes');
  const urgentDate = urgent ? (params.urgentDate || '').toString() : '';

  if (urgent && !urgentDate) {
    return { success: false, error: 'Urgent orders require a "Produce by" date.' };
  }
  await sbUpdate('orders', row - 2, { urgent, urgent_due_date: urgentDate || null });
  return { success: true };
}

// ============================================================
// DESIGN SAMPLES
// ============================================================
function buildSampleRowArray(rec, fabricsBySampleId) {
  const row = new Array(37).fill('');
  if (!rec) return row;

  row[0] = rec.sr_no || '';
  row[1] = rec.name || '';
  row[2] = rec.created_at || '';
  row[3] = rec.code || '';
  row[4] = rec.type || '';
  row[5] = rec.fabric_color || '';
  row[6] = rec.master || '';
  row[7] = rec.machine_emb ? 'Yes' : '';
  row[8] = rec.hand_emb ? 'Yes' : '';

  const fabrics = fabricsBySampleId[rec.id] || {};
  for (let slot = 1; slot <= 6; slot++) {
    const base = 9 + (slot - 1) * 3;
    const f = fabrics[slot];
    row[base] = f ? (f.fabric_name || '') : '';
    row[base + 1] = f ? (f.fabric_color || '') : '';
    row[base + 2] = f && f.meters != null ? String(f.meters) : '';
  }

  row[27] = rec.lining_color || '';
  row[28] = rec.piping_color || '';
  row[29] = rec.tailor || '';
  row[30] = rec.tailor_started_at || '';
  row[31] = rec.tailor_ended_at || '';
  row[32] = rec.is_done ? 'Done' : '';
  row[33] = rec.mach_emb_person || '';
  row[34] = rec.mach_emb_status || '';
  row[35] = rec.hand_emb_person || '';
  row[36] = rec.hand_emb_status || '';
  return row;
}

async function doGetSamples() {
  const records = await sbSelectAll('design_samples', 'id');
  const fabricRows = await sbSelectAll('sample_fabrics', 'id');

  const fabricsBySampleId = {};
  fabricRows.forEach(fr => {
    if (!fabricsBySampleId[fr.sample_id]) fabricsBySampleId[fr.sample_id] = {};
    fabricsBySampleId[fr.sample_id][fr.slot_no] = fr;
  });

  const byId = {};
  let maxId = 0;
  records.forEach(rec => {
    byId[rec.id] = rec;
    if (rec.id > maxId) maxId = rec.id;
  });

  const data = [new Array(37).fill('')];
  for (let id = 1; id <= maxId; id++) {
    data.push(buildSampleRowArray(byId[id], fabricsBySampleId));
  }
  return { success: true, data };
}

async function doAddSample(params) {
  const name = (params.name || '').toString().trim();
  const code = (params.code || '').toString().trim();
  const type = (params.type || '').toString().trim();

  const designers = await getActiveStaffNames('designer');
  if (designers.indexOf(name) === -1) return { success: false, error: 'Unknown designer: ' + name };
  if (!code || !type) return { success: false, error: 'Code and Type are required.' };

  const master = (params.master || '').toString().trim();
  const patternMasters = await getActiveStaffNames('patternmaster');
  if (patternMasters.indexOf(master) === -1) {
    return { success: false, error: 'Unknown pattern master: ' + master };
  }

  const fabricColor = (params.fabricColor || '').toString();
  const machEmb = (params.machEmb === 'Yes');
  const handEmb = (params.handEmb === 'Yes');
  const liningColor = (params.liningColor || '').toString();
  const pipingColor = (params.pipingColor || '').toString();

  let machEmbPerson = null;
  if (machEmb) {
    machEmbPerson = (params.machEmbPerson || '').toString().trim();
    const machStaff = await getActiveStaffNames('samplemachemb');
    if (machStaff.indexOf(machEmbPerson) === -1) {
      return { success: false, error: 'Please pick who should do the machine embroidery.' };
    }
  }
  let handEmbPerson = null;
  if (handEmb) {
    handEmbPerson = (params.handEmbPerson || '').toString().trim();
    const handStaff = await getActiveStaffNames('samplehandemb');
    if (handStaff.indexOf(handEmbPerson) === -1) {
      return { success: false, error: 'Please pick who should do the hand embroidery.' };
    }
  }

  const fabricSlots = [];
  let hasAnyFabric = false;
  for (let i = 1; i <= MAX_FABRIC_SLOTS; i++) {
    const fabric = (params['fabric' + i] || '').toString();
    const color = (params['fabricColor' + i] || '').toString();
    const meters = (params['meters' + i] || '').toString();
    if (fabric || color || meters) hasAnyFabric = true;
    fabricSlots.push({
      slot_no: i, fabric_name: fabric || null, fabric_color: color || null,
      meters: meters ? (parseFloat(meters) || null) : null
    });
  }
  if (!hasAnyFabric) return { success: false, error: 'At least one fabric is required.' };

  const srNo = (await sbGetMaxId('design_samples')) + 1;

  const created = await sbInsertOne('design_samples', {
    sr_no: srNo, name, code, type, fabric_color: fabricColor,
    master, machine_emb: machEmb, hand_emb: handEmb,
    mach_emb_person: machEmbPerson, hand_emb_person: handEmbPerson,
    lining_color: liningColor, piping_color: pipingColor
  });

  const slotsToInsert = fabricSlots
    .filter(f => f.fabric_name || f.fabric_color || f.meters != null)
    .map(f => Object.assign({ sample_id: created.id }, f));
  if (slotsToInsert.length) await sbInsertMany('sample_fabrics', slotsToInsert);

  return { success: true, row: created.id + 1, srNo };
}

async function doAssignSampleMaster(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const master = (params.master || '').toString();
  const patternMasters = await getActiveStaffNames('patternmaster');
  if (patternMasters.indexOf(master) === -1) {
    return { success: false, error: 'Unknown pattern master: ' + master };
  }
  await sbUpdate('design_samples', row - 1, { master });
  return { success: true };
}

async function doAssignSampleTailor(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const tailor = (params.tailor || '').toString();
  const sampleTailors = await getActiveStaffNames('tailor');
  if (sampleTailors.indexOf(tailor) === -1) {
    return { success: false, error: 'Unknown tailor: ' + tailor };
  }
  await sbUpdate('design_samples', row - 1, { tailor, tailor_started_at: new Date().toISOString() });
  return { success: true };
}

async function doSendSampleEmb(params) {
  // Tailor sends a cut piece out for machine/hand embroidery. Only makes
  // sense for a sample that actually needs it and has someone assigned.
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const kind = (params.kind || '').toString();
  if (kind !== 'mach' && kind !== 'hand') return { success: false, error: 'Invalid embroidery kind.' };
  const id = row - 1;

  const personCol = kind === 'mach' ? 'mach_emb_person' : 'hand_emb_person';
  const rec = await sbFetch('GET', `design_samples?id=eq.${id}&select=${personCol}`);
  const person = rec && rec[0] ? rec[0][personCol] : null;
  if (!person) {
    return { success: false, error: 'This sample has no ' + (kind === 'mach' ? 'machine' : 'hand') + ' embroidery person assigned.' };
  }

  const statusCol = kind === 'mach' ? 'mach_emb_status' : 'hand_emb_status';
  await sbUpdate('design_samples', id, { [statusCol]: 'RED|' + new Date().toLocaleString('en-GB', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }) });
  return { success: true };
}

async function doReceiveSampleEmb(params) {
  // The assigned machine/hand embroidery person marks their part finished
  // and hands it back to the tailor. Checked against the person actually
  // assigned so one embroidery worker can't clear someone else's queue.
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const kind = (params.kind || '').toString();
  if (kind !== 'mach' && kind !== 'hand') return { success: false, error: 'Invalid embroidery kind.' };
  const id = row - 1;
  const name = (params.authenticatedName || '').toString();

  const personCol = kind === 'mach' ? 'mach_emb_person' : 'hand_emb_person';
  const rec = await sbFetch('GET', `design_samples?id=eq.${id}&select=${personCol}`);
  const person = rec && rec[0] ? rec[0][personCol] : null;
  if (!person) {
    return { success: false, error: 'This sample has no ' + (kind === 'mach' ? 'machine' : 'hand') + ' embroidery person assigned.' };
  }
  const role = (params.role || '').toString();
  const isOverride = (role === 'admin' || role === 'fulfillment');
  if (!isOverride && name && person !== name) {
    return { success: false, error: 'This sample is assigned to ' + person + ', not you.' };
  }

  const statusCol = kind === 'mach' ? 'mach_emb_status' : 'hand_emb_status';
  await sbUpdate('design_samples', id, { [statusCol]: 'GREEN|' + new Date().toLocaleString('en-GB', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }) });
  return { success: true };
}

async function doMarkSampleDone(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const id = row - 1;

  const rec = await sbFetch('GET', 'design_samples?id=eq.' + id + '&select=tailor,mach_emb_person,mach_emb_status,hand_emb_person,hand_emb_status');
  const s = rec && rec[0];
  if (!s || !s.tailor) {
    return { success: false, error: 'Cannot mark Done — no tailor has been assigned yet.' };
  }
  if (s.mach_emb_person && !(s.mach_emb_status || '').startsWith('GREEN')) {
    return { success: false, error: 'Cannot mark Done — still waiting on machine embroidery (' + s.mach_emb_person + ').' };
  }
  if (s.hand_emb_person && !(s.hand_emb_status || '').startsWith('GREEN')) {
    return { success: false, error: 'Cannot mark Done — still waiting on hand embroidery (' + s.hand_emb_person + ').' };
  }
  await sbUpdate('design_samples', id, { tailor_ended_at: new Date().toISOString(), is_done: true });
  return { success: true };
}

async function doUndoSampleDone(params) {
  // Admin-only escape hatch, same idea as undoMarkDone for orders.
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  await sbUpdate('design_samples', row - 1, { is_done: false, tailor_ended_at: null });
  return { success: true };
}

async function doDeleteSample(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const id = row - 1;
  await sbFetch('DELETE', `sample_fabrics?sample_id=eq.${id}`, undefined, { Prefer: 'return=minimal' });
  await sbFetch('DELETE', `design_samples?id=eq.${id}`, undefined, { Prefer: 'return=minimal' });
  return { success: true };
}

// ============================================================
// AEON ATELIER — tailor floor module (tablet timers, mechanic calls,
// approvals, standard times, payroll). Sits on top of the same "orders"
// and "staff" tables above; its own tables are atelier_jobs, atelier_calls,
// atelier_standards and atelier_settings (single row, id=1). See the
// migration SQL supplied alongside this file.
//
// Roles: "tailor" (existing role, now also signs in here with a 4-digit
// PIN instead of the shared/individual password used elsewhere in the
// app) · "atelier_supervisor" (new shared-password role, view + approve
// only) · "admin" (full access, including pay settings and standard
// times, which must stay admin-only per spec).
// ============================================================

const ATELIER_GARMENT_TYPES = ['Abaya','Pant','Blouse','Skirt','Vest','Dress','Jumpsuit','Bisht','Trenchcoat','Blazer','Inner','Shayla','Set','Other'];

function atelierModelFromSku(sku) {
  const s = (sku || '').toString().trim();
  if (!s) return '';
  const i = s.indexOf('-');
  return i === -1 ? s : s.slice(0, i);
}

// Every order line is exactly ONE piece. If a customer needs more than one,
// staff create a separate order with its own order number. Anything written
// in the notes (e.g. "2 pcs") is for staff reference only and must never
// change the quantity, so the notes argument is intentionally ignored.
function atelierQtyFromNotes(_notes) {
  return 1;
}

// ---- Settings (single row, id=1) — cached in memory, invalidated on write ----
let atelierSettingsCache = null;
async function getAtelierSettings() {
  if (atelierSettingsCache) return atelierSettingsCache;
  const rows = await sbFetch('GET', 'atelier_settings?id=eq.1&select=*&limit=1');
  atelierSettingsCache = (rows && rows[0]) || {
    mode: 'trial', type_rates: {}, type_std: {}, hours_per_day: 10, days_per_month: 26, pay_rules: {}
  };
  return atelierSettingsCache;
}
function invalidateAtelierSettingsCache() { atelierSettingsCache = null; }

async function getStandardMinutes(model, garmentType) {
  if (model) {
    // Case-insensitive so "abc" and "ABC" are the same model (the Standard
    // Times list clubs them together). Backslash, % and _ are escaped so they match literally.
    const safe = model.toString().trim().replace(/[\\%_]/g, c => '\\' + c);
    const rows = await sbFetch('GET', `atelier_standards?model=ilike.${encodeURIComponent(safe)}&select=min_per_piece&limit=1`);
    if (rows && rows[0] && rows[0].min_per_piece != null) return Number(rows[0].min_per_piece);
  }
  const settings = await getAtelierSettings();
  const typeStd = settings.type_std || {};
  return Number(typeStd[garmentType] || 30); // generic fallback until admin sets real defaults
}

// ---- Shopify product catalog cache: model -> {title, productType, tags} ----
// Refreshed periodically in the background; a stale/empty cache never blocks
// the app — lines just show the raw SKU + backend garment type instead.
let shopifyCatalogByModel = {};
async function refreshShopifyCatalog() {
  if (!SHOPIFY_ENABLED) return;
  try {
    const byModel = {};
    let cursor = null, pages = 0;
    do {
      const data = await shopifyGraphQL(
        `query($cursor: String) {
          products(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            edges { node { title productType tags variants(first: 5) { edges { node { sku } } } } }
          }
        }`,
        { cursor }
      );
      const conn = data.products;
      conn.edges.forEach(({ node }) => {
        node.variants.edges.forEach(({ node: v }) => {
          const model = atelierModelFromSku(v.sku);
          if (model && !byModel[model]) byModel[model] = { title: node.title, productType: node.productType, tags: node.tags };
        });
      });
      cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
      pages++;
    } while (cursor && pages < 20);
    shopifyCatalogByModel = byModel;
    console.log(`Aeon Workstation: Shopify catalog cached (${Object.keys(byModel).length} models).`);
  } catch (e) {
    console.error('Aeon Workstation: Shopify catalog refresh failed:', e.message);
  }
}
if (SHOPIFY_ENABLED) {
  refreshShopifyCatalog();
  setInterval(refreshShopifyCatalog, 15 * 60 * 1000);
}

// ---- Tailor sign-in: name + 4-digit PIN (separate from the password login
// above). PINs live on the same "staff" row as the tailor's regular
// password, in atelier_pin_hash/atelier_pin_salt. ----
async function doAtelierListTailors() {
  return { success: true, names: await getActiveStaffNames('tailor') };
}

async function doAtelierTailorLogin(params) {
  const name = (params.name || '').toString();
  const pin = (params.pin || '').toString();
  if (!name || !/^\d{4}$/.test(pin)) return { success: false, error: 'Select your name and enter your 4-digit PIN.' };

  const rows = await sbFetch('GET', `staff?select=id,name,atelier_pin_hash,atelier_pin_salt&role=eq.tailor&name=eq.${encodeURIComponent(name)}&active=eq.true&limit=1`);
  const rec = rows && rows[0];
  if (!rec || !rec.atelier_pin_hash || !verifyPassword(pin, rec.atelier_pin_hash, rec.atelier_pin_salt)) {
    return { success: false, error: 'Incorrect name or PIN.' };
  }
  const token = makeToken('tailor', name);
  return { success: true, token, name };
}

// Admin-only: every active tailor (added under Staff) with whether a PIN is set.
async function doAtelierListPins() {
  const rows = (await sbFetch('GET', 'staff?select=id,name,atelier_pin_hash&role=eq.tailor&active=eq.true&order=sort_order.asc,created_at.asc')) || [];
  return { success: true, tailors: rows.map(r => ({ id: r.id, name: r.name, hasPin: !!r.atelier_pin_hash })) };
}

// Admin-only: set/change a tailor's PIN (Admin > Staff, or Atelier > Settings)
async function doAtelierSetPin(params) {
  const id = parseInt(params.staffId, 10);
  const pin = (params.pin || '').toString();
  if (!id) return { success: false, error: 'Invalid staff id.' };
  if (!/^\d{4}$/.test(pin)) return { success: false, error: 'PIN must be exactly 4 digits.' };
  const { hash, salt } = hashPassword(pin);
  await sbFetch('PATCH', `staff?id=eq.${id}`, { atelier_pin_hash: hash, atelier_pin_salt: salt }, { Prefer: 'return=minimal' });
  return { success: true };
}

// ---- Assigned order lines for the signed-in tailor ----
async function doAtelierMyOrders(params) {
  const tailor = (params.authenticatedName || '').toString();
  if (!tailor) return { success: false, error: 'Not signed in.' };

  const orders = (await sbFetch('GET', `orders?tailor=eq.${encodeURIComponent(tailor)}&is_done=eq.false&select=order_no,sku,garment_type,order_type,master,urgent,urgent_due_date,notes,created_at`)) || [];
  if (!orders.length) return { success: true, lines: [] };

  // Rule: a line is hidden only while a job for it is in progress or awaiting QC.
  // Approved jobs never hide a line: approving marks the order Done, and this
  // query only returns NOT-done orders, so an approved job here is stale (order
  // reopened / re-assigned / duplicate order_no+sku row). Hiding on it was the
  // bug where Orders showed "With tailor M4" but M4's Work screen was empty.
  const jobs = (await sbFetch('GET', `atelier_jobs?tailor=eq.${encodeURIComponent(tailor)}&status=in.(active,pending)&select=order_no,sku`)) || [];
  const blockKey = new Set();
  jobs.forEach(j => blockKey.add(j.order_no + '|' + j.sku));

  const lines = [];
  for (const o of orders) {
    if (blockKey.has(o.order_no + '|' + o.sku)) continue;
    const model = atelierModelFromSku(o.sku);
    const cat = shopifyCatalogByModel[model] || null;
    const qty = atelierQtyFromNotes(o.notes);
    const standardMin = (await getStandardMinutes(model, o.garment_type)) * qty;
    lines.push({
      orderNo: o.order_no, sku: o.sku, model,
      productTitle: cat ? cat.title : null, productType: cat ? cat.productType : null, tags: cat ? cat.tags : [],
      garmentType: o.garment_type, qty, master: o.master || null,
      urgent: !!o.urgent, urgentDueDate: o.urgent_due_date || null,
      notes: o.notes || '', createdAt: o.created_at, standardMinutes: standardMin
    });
  }
  lines.sort((a, b) => (b.urgent - a.urgent) || (new Date(a.createdAt) - new Date(b.createdAt)));
  return { success: true, lines };
}

// ---- Job lifecycle ----
// A tailor can have several jobs "in progress" (status 'active') at once —
// e.g. one paused for a mechanic call while another is picked up in the
// meantime — but only one of them ever has its timer ticking (run_since
// set) at a time, since a person can only physically work on one piece at
// once. getAtelierActiveJob returns that one *running* job (kept under its
// original name so callers that only care about "the current job" — the
// mechanic-call flow below — don't need to change); getAtelierActiveJobs
// returns the full in-progress list; getAtelierJobForTailor fetches one
// specific in-progress job by id, scoped to its tailor.
async function getAtelierActiveJob(tailor) {
  const rows = await sbFetch('GET', `atelier_jobs?tailor=eq.${encodeURIComponent(tailor)}&status=eq.active&run_since=not.is.null&select=*&limit=1`);
  return rows && rows[0];
}
async function getAtelierActiveJobs(tailor) {
  return (await sbFetch('GET', `atelier_jobs?tailor=eq.${encodeURIComponent(tailor)}&status=eq.active&select=*&order=start_at.asc`)) || [];
}
async function getAtelierJobForTailor(tailor, jobId) {
  if (!jobId) return null;
  const rows = await sbFetch('GET', `atelier_jobs?id=eq.${jobId}&tailor=eq.${encodeURIComponent(tailor)}&status=eq.active&select=*&limit=1`);
  return rows && rows[0];
}
// Pauses whichever job is currently running for this tailor (if any) and
// returns it, so callers can decide whether to touch it further.
async function atelierPauseRunning(tailor, exceptJobId) {
  const running = await getAtelierActiveJob(tailor);
  if (running && running.id !== exceptJobId) {
    const accum = Number(running.accum_ms || 0) + (Date.now() - new Date(running.run_since).getTime());
    await sbUpdate('atelier_jobs', running.id, { accum_ms: accum, run_since: null });
  }
  return running;
}

async function doAtelierStartJob(params) {
  const tailor = (params.authenticatedName || '').toString();
  if (!tailor) return { success: false, error: 'Not signed in.' };

  const manual = !!(params.manual === true || params.manual === 'true');
  const orderNo = (params.orderNo || '').toString().trim();
  const sku = (params.sku || '').toString().trim();
  if (!orderNo || !sku) return { success: false, error: 'Order number and SKU are required.' };

  let garmentType = (params.garmentType || '').toString().trim();
  let qty = 1; // fixed: one piece per order line
  let master = (params.master || '').toString().trim() || null;
  let notes = (params.notes || '').toString();
  let urgent = false;

  if (!manual) {
    // Re-verify against the assignment itself — never trust the client here.
    const rows = await sbFetch('GET', `orders?order_no=eq.${encodeURIComponent(orderNo)}&sku=eq.${encodeURIComponent(sku)}&tailor=eq.${encodeURIComponent(tailor)}&limit=1&select=*`);
    const rec = rows && rows[0];
    if (!rec) return { success: false, error: 'This order line is not assigned to you.' };
    garmentType = rec.garment_type; master = rec.master || null; notes = rec.notes || ''; urgent = !!rec.urgent;
    qty = atelierQtyFromNotes(notes);

    const blocked = await sbFetch('GET', `atelier_jobs?order_no=eq.${encodeURIComponent(orderNo)}&sku=eq.${encodeURIComponent(sku)}&status=in.(active,pending)&select=id&limit=1`);
    if (blocked && blocked.length) return { success: false, error: 'This order line already has a job in progress.' };
  } else if (!garmentType) {
    return { success: false, error: 'Garment type is required for a manual entry.' };
  }

  // Starting a new job automatically pauses whatever the tailor was
  // running — they can have several jobs in progress, just not several
  // timers ticking at once.
  await atelierPauseRunning(tailor);

  const model = atelierModelFromSku(sku);
  const standardMin = (await getStandardMinutes(model, garmentType)) * qty;
  const now = new Date().toISOString();

  const job = await sbInsertOne('atelier_jobs', {
    tailor, order_no: orderNo, sku, model, garment_type: garmentType, qty,
    master, urgent, notes, manual, status: 'active', standard_min: standardMin,
    start_at: now, run_since: now, accum_ms: 0
  });
  logLineEvent(orderNo, sku, 'tailoring', `Tailoring started by ${tailor}${manual ? ' (manual entry)' : ''}`, tailor);
  return { success: true, job: formatAtelierJob(job) };
}

// Reasons a tailor must pick from when pausing a job.
const ATELIER_PAUSE_REASONS = [
  'Needs machine embroidery (Asif)',
  'Needs machine embroidery (Abdullah)',
  'Needs hand embroidery (Akil)',
  'Missing fabric',
  'Missing heat and bond (Vaslin)',
  'Break'
];
// pause_reason is a text column on atelier_jobs. If it hasn't been added yet
// the write is retried without it, so pausing never breaks.
async function atelierUpdateJobWithReason(id, patch) {
  try {
    await sbUpdate('atelier_jobs', id, patch);
  } catch (e) {
    if (!('pause_reason' in patch)) throw e;
    const rest = Object.assign({}, patch); delete rest.pause_reason;
    await sbUpdate('atelier_jobs', id, rest);
  }
}

async function doAtelierPauseJob(params) {
  const tailor = (params.authenticatedName || '').toString();
  const jobId = parseInt(params.jobId, 10) || null;
  const reason = (params.reason || '').toString().trim();
  if (ATELIER_PAUSE_REASONS.indexOf(reason) === -1) {
    return { success: false, error: 'Please choose a reason to pause.' };
  }
  const job = jobId ? await getAtelierJobForTailor(tailor, jobId) : await getAtelierActiveJob(tailor);
  if (!job) return { success: false, error: 'No running job to pause.' };
  if (!job.run_since) return { success: true };
  const accum = Number(job.accum_ms || 0) + (Date.now() - new Date(job.run_since).getTime());
  await atelierUpdateJobWithReason(job.id, { accum_ms: accum, run_since: null, pause_reason: reason });
  logLineEvent(job.order_no, job.sku, 'tailoring', `Tailoring paused — ${reason}`, tailor);
  return { success: true };
}

async function doAtelierResumeJob(params) {
  const tailor = (params.authenticatedName || '').toString();
  const jobId = parseInt(params.jobId, 10) || null;
  const job = jobId ? await getAtelierJobForTailor(tailor, jobId) : await getAtelierActiveJob(tailor);
  if (!job) return { success: false, error: 'No job to resume.' };
  if (job.run_since) return { success: true };
  // Only one timer runs at a time — pause whatever else is currently
  // running before resuming this one.
  await atelierPauseRunning(tailor, job.id);
  await atelierUpdateJobWithReason(job.id, { run_since: new Date().toISOString(), pause_reason: null });
  logLineEvent(job.order_no, job.sku, 'tailoring', 'Tailoring resumed', tailor);
  return { success: true };
}

// 7500000 ms -> "2h 5m", 90000 -> "1m 30s"
function fmtDurationMs(ms) {
  ms = Math.max(0, Number(ms) || 0);
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), sec = totalSec % 60;
  if (h) return h + 'h ' + m + 'm';
  if (m) return m + 'm' + (sec && m < 10 ? ' ' + sec + 's' : '');
  return sec + 's';
}

async function doAtelierFinishJob(params) {
  const tailor = (params.authenticatedName || '').toString();
  const jobId = parseInt(params.jobId, 10) || null;
  const job = jobId ? await getAtelierJobForTailor(tailor, jobId) : await getAtelierActiveJob(tailor);
  if (!job) return { success: false, error: 'No job to finish.' };
  const accum = Number(job.accum_ms || 0) + (job.run_since ? (Date.now() - new Date(job.run_since).getTime()) : 0);
  const now = new Date().toISOString();
  await atelierUpdateJobWithReason(job.id, { accum_ms: accum, run_since: null, status: 'pending', end_at: now, duration_ms: accum, pause_reason: null });
  logLineEvent(job.order_no, job.sku, 'qc', `Tailoring finished by ${tailor} — waiting for QC approval — stitching time ${fmtDurationMs(accum)}`, tailor);
  return { success: true };
}

async function doAtelierReturnJob(params) {
  // Gives back an unfinished job — the order line reappears in the list.
  const tailor = (params.authenticatedName || '').toString();
  const jobId = parseInt(params.jobId, 10) || null;
  const job = jobId ? await getAtelierJobForTailor(tailor, jobId) : await getAtelierActiveJob(tailor);
  if (!job) return { success: false, error: 'No job to return.' };
  await sbFetch('DELETE', `atelier_jobs?id=eq.${job.id}`, undefined, { Prefer: 'return=minimal' });
  logLineEvent(job.order_no, job.sku, 'tailoring', `Job given back by ${tailor} — line is available again`, tailor);
  return { success: true };
}

// ---- Mechanic calls (pause the active job; resolving resumes it) ----
async function doAtelierMechanicCall(params) {
  const tailor = (params.authenticatedName || '').toString();
  const reason = (params.reason || '').toString().trim();
  if (!reason) return { success: false, error: 'Please select a reason.' };

  const job = await getAtelierActiveJob(tailor);
  if (job && job.run_since) {
    const accum = Number(job.accum_ms || 0) + (Date.now() - new Date(job.run_since).getTime());
    await sbUpdate('atelier_jobs', job.id, { accum_ms: accum, run_since: null });
  }
  await sbInsertOne('atelier_calls', { tailor, reason, job_id: job ? job.id : null, at: new Date().toISOString(), open: true });
  if (job) logLineEvent(job.order_no, job.sku, 'tailoring', `Mechanic called by ${tailor} — ${reason} (timer paused)`, tailor);
  return { success: true };
}

async function doAtelierMechanicResolve(params) {
  const id = parseInt(params.callId, 10);
  if (!id) return { success: false, error: 'Invalid call id.' };
  const rows = await sbFetch('GET', `atelier_calls?id=eq.${id}&select=*&limit=1`);
  const call = rows && rows[0];
  if (!call) return { success: false, error: 'Call not found.' };
  const now = new Date().toISOString();
  await sbUpdate('atelier_calls', id, { open: false, fixed_at: now });

  if (call.job_id) {
    const jobRows = await sbFetch('GET', `atelier_jobs?id=eq.${call.job_id}&select=*&limit=1`);
    const job = jobRows && jobRows[0];
    if (job && job.status === 'active' && !job.run_since) {
      // The tailor may have picked up a different job while waiting on the
      // mechanic — pause that one before resuming the fixed job's timer.
      await atelierPauseRunning(job.tailor, job.id);
      await sbUpdate('atelier_jobs', call.job_id, { run_since: now });
      logLineEvent(job.order_no, job.sku, 'tailoring', 'Mechanic fixed the machine — timer resumed', actorOf(params));
    }
  }
  return { success: true };
}

async function doAtelierMechanicCallsList() {
  const rows = (await sbFetch('GET', 'atelier_calls?select=*&order=at.desc&limit=200')) || [];
  return { success: true, calls: rows.map(c => ({
    id: c.id, tailor: c.tailor, reason: c.reason, at: c.at, open: c.open, fixedAt: c.fixed_at,
    downtimeMinutes: c.fixed_at ? Math.round((new Date(c.fixed_at) - new Date(c.at)) / 60000) : null
  })) };
}

// ---- Tailor-facing today / history / earnings ----
function atelierMonthStartIso() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}
function atelierTodayStartIso() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

function formatAtelierJob(j) {
  return {
    id: j.id, tailor: j.tailor, orderNo: j.order_no, sku: j.sku, model: j.model, garmentType: j.garment_type,
    qty: j.qty, status: j.status, manual: j.manual, urgent: j.urgent,
    startAt: j.start_at, endAt: j.end_at,
    durationMinutes: j.duration_ms != null ? Math.round(j.duration_ms / 60000) : null,
    durationSeconds: j.duration_ms != null ? Math.round(j.duration_ms / 1000) : null,
    accumMs: j.accum_ms, runSince: j.run_since,
    standardMinutes: j.standard_min, payAmount: j.pay_amount,
    approvedAt: j.approved_at, reworkAt: j.rework_at,
    rejectReason: j.reject_reason || null, rejectedBy: j.rejected_by || null,
    fabricIssueType: j.fabric_issue_type || null,
    pauseReason: j.pause_reason || null
  };
}

async function doAtelierMyToday(params) {
  const tailor = (params.authenticatedName || '').toString();
  const jobs = (await sbFetch('GET', `atelier_jobs?tailor=eq.${encodeURIComponent(tailor)}&created_at=gte.${atelierTodayStartIso()}&select=*`)) || [];
  // In-progress jobs are NOT limited to today: a job started on an earlier day
  // and never finished/paused must still show on the Work screen. Otherwise it
  // is invisible there yet still hides its order line from the tailor's list.
  const activeJobs = (await getAtelierActiveJobs(tailor)).slice().sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  let pieces = 0, minutesWorked = 0, earnedApproved = 0, earnedPending = 0;
  jobs.forEach(j => {
    if (j.status === 'approved' || j.status === 'pending') pieces += (j.qty || 0);
    if (j.duration_ms) minutesWorked += j.duration_ms / 60000;
    if (j.status === 'approved') earnedApproved += Number(j.pay_amount || 0);
    if (j.status === 'pending') earnedPending += Number(j.pay_amount || 0);
  });
  return {
    success: true, pieces, minutesWorked: Math.round(minutesWorked),
    earnedApproved: +earnedApproved.toFixed(3), earnedPending: +earnedPending.toFixed(3),
    activeJobs: activeJobs.map(formatAtelierJob)
  };
}

async function doAtelierMyHistory(params) {
  const tailor = (params.authenticatedName || '').toString();
  const jobs = (await sbFetch('GET', `atelier_jobs?tailor=eq.${encodeURIComponent(tailor)}&created_at=gte.${atelierMonthStartIso()}&select=*&order=created_at.desc`)) || [];
  return { success: true, jobs: jobs.map(formatAtelierJob) };
}

async function doAtelierMyEarnings(params) {
  const tailor = (params.authenticatedName || '').toString();
  const jobs = (await sbFetch('GET', `atelier_jobs?tailor=eq.${encodeURIComponent(tailor)}&created_at=gte.${atelierMonthStartIso()}&select=status,pay_amount`)) || [];
  let approved = 0, pending = 0, rework = 0;
  jobs.forEach(j => {
    if (j.status === 'approved') approved += Number(j.pay_amount || 0);
    else if (j.status === 'pending') pending += Number(j.pay_amount || 0);
    else if (j.status === 'rework') rework++;
  });
  return { success: true, approved: +approved.toFixed(3), pending: +pending.toFixed(3), reworkCount: rework };
}

// ---- Supervisor/admin: approvals ----
// Adds this-round / earlier / total seconds to each job, where "earlier" is
// every other finished attempt on the same order line (e.g. before a QC
// rejection), so the supervisor sees the whole time the tailor has spent.
async function withLineTotals(rows) {
  const out = [];
  for (const j of rows) {
    const f = formatAtelierJob(j);
    const thisSec = Math.round(Number(j.duration_ms || 0) / 1000);
    let priorSec = 0;
    if (j.order_no) {
      let q = `atelier_jobs?order_no=eq.${encodeURIComponent(j.order_no)}&id=neq.${j.id}&status=in.(pending,approved,rework)&duration_ms=not.is.null&select=duration_ms`;
      if (j.sku) q += `&sku=eq.${encodeURIComponent(j.sku)}`;
      const others = (await sbFetch('GET', q)) || [];
      priorSec = Math.round(others.reduce((a, r) => a + Number(r.duration_ms || 0), 0) / 1000);
    }
    f.thisSeconds = thisSec; f.priorSeconds = priorSec; f.totalSeconds = thisSec + priorSec;
    out.push(f);
  }
  return out;
}

// Jobs approved in the last N days — lets Admin / Fulfillment send back a
// piece that QC approved by mistake (see doAtelierRejectJob).
async function doAtelierRecentApproved(params) {
  let days = parseInt(params && params.days, 10);
  if (!days || days < 1) days = 7;
  if (days > 60) days = 60;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = (await sbFetch('GET',
    `atelier_jobs?status=eq.approved&approved_at=gte.${encodeURIComponent(since)}&select=*&order=approved_at.desc&limit=60`)) || [];
  rows.reverse(); // newest 60 fetched, shown oldest -> newest
  return {
    success: true, days,
    jobs: rows.map(j => Object.assign(formatAtelierJob(j), {
      approvedBy: j.approved_by || null,
      thisSeconds: Math.round(Number(j.duration_ms || 0) / 1000), priorSeconds: 0,
      totalSeconds: Math.round(Number(j.duration_ms || 0) / 1000)
    }))
  };
}

async function doAtelierApprovalsList() {
  const rows = (await sbFetch('GET', 'atelier_jobs?status=eq.pending&select=*&order=end_at.asc')) || [];
  return { success: true, jobs: await withLineTotals(rows) };
}

// ---- Supervisor scan-to-approve: look up the Atelier job for a scanned
// order/SKU label (the same labels already used by inventory/master/tailor
// scanning elsewhere in the app). Prefers a job awaiting approval; if none
// is pending, returns the most recent job for that line anyway so the
// supervisor sees *why* nothing is waiting (still in progress, already
// approved, not started yet) instead of a bare "not found". ----
async function doAtelierFindPendingByCode(params) {
  const orderNo = (params.orderNo || '').toString().trim();
  const sku = (params.sku || '').toString().trim();
  if (!orderNo && !sku) return { success: false, error: "Scanned code didn't contain an order number or SKU." };

  // Pin the scan to ONE exact order line first, then look up that line's job.
  let lineOrder = orderNo, lineSku = sku;
  if (orderNo) {
    const res = await resolveScannedLine(params);
    if (res.ok) { lineOrder = res.rec.order_no; lineSku = res.rec.sku || ''; }
    else if (res.ambiguous) return { success: false, error: res.error };
    // not found in orders -> fall through to the job tables with what was scanned
  }
  const base = lineOrder && lineSku
    ? `order_no=eq.${encodeURIComponent(lineOrder)}&sku=eq.${encodeURIComponent(lineSku)}`
    : lineOrder
      ? `order_no=eq.${encodeURIComponent(lineOrder)}`
      : `sku=eq.${encodeURIComponent(lineSku)}`;

  const pending = (await sbFetch('GET', `atelier_jobs?${base}&status=eq.pending&select=*&order=created_at.desc&limit=3`)) || [];
  if (pending.length) {
    return { success: true, job: (await withLineTotals([pending[0]]))[0], matchStatus: 'pending' };
  }
  const any = await sbFetch('GET', `atelier_jobs?${base}&select=*&order=created_at.desc&limit=1`);
  if (any && any[0]) return { success: true, job: formatAtelierJob(any[0]), matchStatus: any[0].status };

  return { success: false, error: 'No Atelier job found yet for this order/SKU.' };
}

async function doAtelierApproveJob(params) {
  const id = parseInt(params.jobId, 10);
  if (!id) return { success: false, error: 'Invalid job id.' };
  const approver = (params.authenticatedName || params.role || '').toString();

  const rows = await sbFetch('GET', `atelier_jobs?id=eq.${id}&select=*&limit=1`);
  const job = rows && rows[0];
  if (!job) return { success: false, error: 'Job not found.' };
  if (job.status !== 'pending') return { success: false, error: 'This job is not pending approval.' };
  if (job.tailor === approver) return { success: false, error: 'You cannot approve your own work.' }; // enforced server-side, not just in the UI

  // Piece count is fixed — approvers can't change it (any correctedQty sent is ignored).
  const qty = job.qty;

  const settings = await getAtelierSettings();
  const standardMin = (await getStandardMinutes(job.model, job.garment_type)) * qty;
  const rate = (settings.type_rates || {})[job.garment_type];
  const patch = {
    qty, standard_min: standardMin, status: 'approved',
    approved_at: new Date().toISOString(), approved_by: approver,
    // Trial mode pays per job immediately. Live mode pay is a monthly
    // function of standard hours/efficiency/rework (see the payroll
    // report below), so no per-job amount is stored for it.
    pay_amount: settings.mode === 'trial' ? +(Number(rate || 0) * qty).toFixed(3) : null
  };
  await sbUpdate('atelier_jobs', id, patch);
  logLineEvent(job.order_no, job.sku, 'qc', `QC approved by ${approver} — tailoring by ${job.tailor}, ${qty} pc(s)`, approver);
  if (job.order_no && job.sku) {
    const orderRows = await sbFetch('GET', `orders?order_no=eq.${encodeURIComponent(job.order_no)}&sku=eq.${encodeURIComponent(job.sku)}&select=id,is_done,tailor&order=id.desc`);
    // If duplicate order_no+sku rows exist, finish the one this tailor actually
    // holds (not-done first) instead of whichever row the DB returns first.
    const orderRec = (orderRows || []).find(r => !r.is_done && r.tailor === job.tailor) || (orderRows || []).find(r => !r.is_done) || (orderRows || [])[0];
    if (orderRec) {
      // Approval finishes the order: mark it Done so it moves to the
      // Completed tab. (An order already marked Done keeps its original date.)
      const orderPatch = { rework_note: null };
      if (!orderRec.is_done) { orderPatch.is_done = true; orderPatch.done_at = new Date().toISOString(); }
      await sbUpdate('orders', orderRec.id, orderPatch);
      if (!orderRec.is_done) {
        pushShopifyUpdate(job.order_no, 'Production complete — Done ✅');
        logOrderEvent({ orderId: orderRec.id, orderNo: job.order_no, sku: job.sku }, 'done', 'Production complete — order marked Done', approver);
      }
    }
  }
  if (SHOPIFY_ENABLED) pushShopifyUpdate(job.order_no, `Tailoring approved — ${job.tailor}, ${qty} pc(s)`);
  return { success: true };
}

// Rejection must always be attributed to one of three causes, so payroll
// and standard-time analysis (and the tailor themselves) can see *why* a
// job was sent back rather than just that it was.
const ATELIER_REJECT_REASONS = ["Master's issue", "Tailor's issue", "Fabric issue", "Machine embroidery issue", "Hand embroidery issue"];
// When the cause is the fabric itself, we also need to know *what* about
// it was wrong, so whoever re-checks it (Inventory/Admin) knows what to
// fix rather than just "something's wrong".
const ATELIER_FABRIC_ISSUE_TYPES = [
  'Wrong fabric used', 'Fabric damaged / torn', 'Not enough fabric',
  'Wrong color / shade', 'Fabric quality issue', 'Other'
];
async function doAtelierRejectJob(params) {
  const id = parseInt(params.jobId, 10);
  if (!id) return { success: false, error: 'Invalid job id.' };
  const reason = (params.reason || '').toString().trim();
  if (ATELIER_REJECT_REASONS.indexOf(reason) === -1) {
    return { success: false, error: "Please select a reason: Master's issue, Tailor's issue, Fabric issue, Machine embroidery issue or Hand embroidery issue." };
  }
  let fabricIssueType = null;
  if (reason === 'Fabric issue') {
    fabricIssueType = (params.fabricIssueType || '').toString().trim();
    if (ATELIER_FABRIC_ISSUE_TYPES.indexOf(fabricIssueType) === -1) {
      return { success: false, error: 'Please select what kind of fabric issue this is.' };
    }
  }
  const approver = (params.authenticatedName || params.role || '').toString();

  const rows = await sbFetch('GET', `atelier_jobs?id=eq.${id}&select=tailor,status,order_no,sku,master&limit=1`);
  const job = rows && rows[0];
  if (!job) return { success: false, error: 'Job not found.' };
  // Admin / Fulfillment may also send back a job that was already approved
  // (QC made a mistake) — that reopens the order, which approval had marked Done.
  const wasApproved = job.status === 'approved' && (params.role === 'admin' || params.role === 'fulfillment');
  if (job.status !== 'pending' && !wasApproved) return { success: false, error: 'This job is not pending approval.' };
  if (job.tailor === approver) return { success: false, error: 'You cannot review your own work.' };
  const reopen = wasApproved ? { is_done: false, done_at: null } : {};

  const jobPatch = {
    status: 'rework', rework_at: new Date().toISOString(), pay_amount: 0,
    reject_reason: reason, rejected_by: approver, fabric_issue_type: fabricIssueType
  };
  if (wasApproved) { jobPatch.approved_at = null; jobPatch.approved_by = null; }
  await sbUpdate('atelier_jobs', id, jobPatch);
  {
    const routed = reason === 'Machine embroidery issue' ? 'sent back to MACHINE EMBROIDERY' : reason === 'Hand embroidery issue' ? 'sent back to HAND EMBROIDERY (Akil)' : reason === "Master's issue" ? `sent back to Master (${job.master || 'cutting master'}) for re-cut`
      : reason === 'Fabric issue' ? 'sent back to the fabric check — WHOLE GARMENT to be redone (fabric, cutting, tailoring)' : `sent back to Tailor ${job.tailor} to redo`;
    logLineEvent(job.order_no, job.sku, 'rework',
      `QC rejected by ${approver} — ${reason}${fabricIssueType ? ' (' + fabricIssueType + ')' : ''}; ${routed}`, approver);
  }

  // Route it back to whoever's responsible. Tailor's issue needs nothing
  // extra — the order line is still assigned to that tailor, so it's
  // already sitting back in their queue to redo. Master's issue and
  // Fabric issue both need the main order record nudged so the right
  // person sees it next time they touch that order.
  if (job.order_no && job.sku) {
    const orderRows = await sbFetch('GET', `orders?order_no=eq.${encodeURIComponent(job.order_no)}&sku=eq.${encodeURIComponent(job.sku)}&select=id&limit=1`);
    const orderRec = orderRows && orderRows[0];
    if (orderRec) {
      const stamp = new Date().toLocaleString();
      if (reason === "Master's issue") {
        // Send it back to the same cutting master: clear the tailor so it
        // drops out of the tailor's queue until the master re-cuts and
        // reassigns, but leave `master` untouched so it's obvious whose
        // re-cut this is.
        await sbUpdate('orders', orderRec.id, Object.assign({
          tailor: null, tailor_assigned_at: null,
          master_work: JSON.stringify({ prev: mwTotal(parseMasterWork((await sbFetch('GET', `orders?id=eq.${orderRec.id}&select=master_work&limit=1`) || [{}])[0].master_work)) }),
          rework_note: `⚠️ Rejected — Master's issue (${job.master || 'cutting master'}) — needs re-cut. By ${approver}, ${stamp}.`
        }, reopen));
      } else if (reason === 'Machine embroidery issue' || reason === 'Hand embroidery issue') {
        // Back to that embroidery department.
        const full = await sbFetch('GET', `orders?id=eq.${orderRec.id}&select=mach_emb_person,hand_emb_person,machine_emb,hand_emb&limit=1`);
        const er = (full && full[0]) || {};
        if (reason === 'Machine embroidery issue') {
          const mp = er.mach_emb_person;
          if (!mp) return { success: false, error: 'This order has no machine embroidery person recorded — pick another reason.' };
          // Asif: back to Asif, then returns to the same tailor. Abdullah: back to Abdullah, admin receives, master re-assigns the tailor.
          const patch = { machine_emb: (mp === 'Asif' ? 'SENT|' : 'NEED|') + embStampNow(),
            rework_note: `⚠️ Rejected — Machine embroidery issue — back to ${mp}. By ${approver}, ${stamp}.` };
          if (mp !== 'Asif') { patch.tailor = null; patch.tailor_assigned_at = null; }
          await sbUpdate('orders', orderRec.id, Object.assign(patch, reopen));
        } else {
          // Akil receives it again, assigns a person; afterwards the master receives it and assigns the tailor.
          await sbUpdate('orders', orderRec.id, Object.assign({
            hand_emb: 'READY|' + embStampNow(), hand_emb_person: null, tailor: null, tailor_assigned_at: null,
            rework_note: `⚠️ Rejected — Hand embroidery issue — back to hand embroidery (Akil). By ${approver}, ${stamp}.`
          }, reopen));
        }
      } else if (reason === 'Fabric issue') {
        // Send it back to Inventory/Admin: reopen the fabric-check step so
        // it shows up wherever "awaiting fabric" is tracked, tagged with
        // exactly what's wrong with the fabric.
        // Fabric issue = the whole garment has to be remade. Back to the very
        // start: fabric check, then cutting, then tailoring (and embroidery,
        // which was done on the faulty piece) all happen again from scratch.
        await sbUpdate('orders', orderRec.id, Object.assign({
          fabric_status: null, fabric_source: null, fabric_purchase_status: null,
          master: null, master_assigned_at: null, master_work: null, tailor: null, tailor_assigned_at: null,
          machine_emb: null, hand_emb: null, mach_emb_person: null, hand_emb_person: null,
          mach_emb_fabric: null, mach_emb_meters_sent: null, mach_emb_meters_received: null,
          rework_note: `⚠️ Rejected — Fabric issue: ${fabricIssueType}. WHOLE GARMENT TO BE REDONE from fabric check. By ${approver}, ${stamp}.`
        }, reopen));
      } else {
        // Tailor's issue — just leave a visible note; no reassignment needed.
        await sbUpdate('orders', orderRec.id, Object.assign({
          rework_note: `⚠️ Rejected — Tailor's issue (${job.tailor}) — please redo. By ${approver}, ${stamp}.`
        }, reopen));
      }
    }
  }

  return { success: true };
}

// Undoes a finish that was pressed by mistake — the job never gets reviewed
// at all; it's deleted outright (no time or pay recorded, unlike a reject)
// and the order line is handed to whichever tailor the supervisor picks,
// which may or may not be the same tailor who scanned it in the first place.
async function doAtelierRevertJob(params) {
  const id = parseInt(params.jobId, 10);
  if (!id) return { success: false, error: 'Invalid job id.' };
  const newTailor = (params.newTailor || '').toString().trim();
  if (!newTailor) return { success: false, error: 'Please choose which tailor to give this to.' };

  const tailors = await getActiveStaffNames('tailor');
  if (tailors.indexOf(newTailor) === -1) {
    return { success: false, error: 'Unknown tailor: ' + newTailor };
  }

  const approver = (params.authenticatedName || params.role || '').toString();
  const rows = await sbFetch('GET', `atelier_jobs?id=eq.${id}&select=tailor,status,order_no,sku&limit=1`);
  const job = rows && rows[0];
  if (!job) return { success: false, error: 'Job not found.' };
  if (job.status !== 'pending') return { success: false, error: 'This job is not in QC — it may have already been approved, rejected, or reverted.' };

  await sbFetch('DELETE', `atelier_jobs?id=eq.${id}`, undefined, { Prefer: 'return=minimal' });

  if (job.order_no && job.sku) {
    const orderRows = await sbFetch('GET', `orders?order_no=eq.${encodeURIComponent(job.order_no)}&sku=eq.${encodeURIComponent(job.sku)}&select=id&limit=1`);
    const orderRec = orderRows && orderRows[0];
    if (orderRec) {
      const stamp = new Date().toLocaleString();
      await sbUpdate('orders', orderRec.id, {
        tailor: newTailor, tailor_assigned_at: new Date().toISOString(),
        rework_note: `↩️ Reverted from QC (was finished by ${job.tailor}) — reassigned to ${newTailor} by ${approver}, ${stamp}.`
      });
    }
    logOrderEvent({ orderId: orderRec ? orderRec.id : null, orderNo: job.order_no, sku: job.sku }, 'rework',
      `Reverted from QC (finished by ${job.tailor}) — reassigned to Tailor ${newTailor}`, approver);
    if (SHOPIFY_ENABLED) pushShopifyUpdate(job.order_no, `Reverted from QC — reassigned to Tailor: ${newTailor}`);
  }

  return { success: true };
}


// order line (any status), so a supervisor can see what's actually blocking
// a tailor from starting it again — and clear it if it's a stray one.
async function doAtelierJobsForLine(params) {
  const orderNo = (params.orderNo || '').toString().trim();
  if (!orderNo) return { success: false, error: 'Order number is required.' };
  const sku = (params.sku || '').toString().trim();
  const skuQ = sku ? `&sku=eq.${encodeURIComponent(sku)}` : '';
  const rows = await sbFetch('GET', `atelier_jobs?order_no=eq.${encodeURIComponent(orderNo)}${skuQ}&select=*&order=start_at.desc`);
  return { success: true, jobs: (rows || []).map(formatAtelierJob) };
}

// Cancels a stray job (active or pending) that's blocking a line, without
// touching payroll — only jobs that were never approved can be cancelled,
// so a completed/paid job can't accidentally be erased this way.
async function doAtelierCancelJob(params) {
  const id = parseInt(params.jobId, 10);
  if (!id) return { success: false, error: 'Invalid job id.' };
  const rows = await sbFetch('GET', `atelier_jobs?id=eq.${id}&select=status,order_no,sku,tailor&limit=1`);
  const job = rows && rows[0];
  if (!job) return { success: false, error: 'Job not found.' };
  if (job.status !== 'active' && job.status !== 'pending') {
    return { success: false, error: 'Only an active or pending job can be cancelled.' };
  }
  await sbUpdate('atelier_jobs', id, { status: 'cancelled', run_since: null, pay_amount: 0 });
  logLineEvent(job.order_no, job.sku, 'tailoring', `Tailoring job by ${job.tailor} cancelled`, actorOf(params));
  return { success: true };
}

// ---- Supervisor/admin: team status ----
async function doAtelierTeamToday() {
  const tailors = await getActiveStaffNames('tailor');
  const jobs = (await sbFetch('GET', `atelier_jobs?created_at=gte.${atelierTodayStartIso()}&select=*`)) || [];
  const openCalls = (await sbFetch('GET', 'atelier_calls?open=eq.true&select=tailor')) || [];
  const stopped = new Set(openCalls.map(c => c.tailor));

  const byTailor = {};
  tailors.forEach(t => { byTailor[t] = { tailor: t, status: 'waiting', currentOrder: null, activeCount: 0, pieces: 0, minutes: 0 }; });
  jobs.forEach(j => {
    const b = byTailor[j.tailor] || (byTailor[j.tailor] = { tailor: j.tailor, status: 'waiting', currentOrder: null, activeCount: 0, pieces: 0, minutes: 0 });
    if (j.status === 'approved' || j.status === 'pending') b.pieces += (j.qty || 0);
    b.minutes += (j.duration_ms || j.accum_ms || 0) / 60000;
    if (j.status === 'active') {
      b.activeCount++;
      // A tailor can have several jobs in progress at once now — prefer
      // showing whichever one is actually running; fall back to the first
      // paused one seen if nothing is running (yet).
      if (j.run_since || !b.currentOrder) {
        b.currentOrder = { orderNo: j.order_no, sku: j.sku, garmentType: j.garment_type, pauseReason: j.run_since ? null : (j.pause_reason || null) };
        b.status = stopped.has(j.tailor) ? 'machine_stopped' : (j.run_since ? 'working' : 'paused');
      }
    }
  });
  return { success: true, team: Object.values(byTailor).map(b => Object.assign({}, b, { minutes: Math.round(b.minutes) })) };
}

// ---- Live floor view: every job currently in progress in the tailor portal ----
// Read-only. Returns the raw timer state (accum_ms + run_since) plus the
// server clock, so the browser can tick each timer every second on its own
// and only needs to re-poll every ~15s to pick up starts / pauses / finishes.
async function doAtelierLiveJobs() {
  const [jobs, openCalls] = await Promise.all([
    sbFetch('GET', 'atelier_jobs?status=eq.active&select=*&order=start_at.asc'),
    sbFetch('GET', 'atelier_calls?open=eq.true&select=tailor')
  ]);
  const stopped = new Set((openCalls || []).map(c => c.tailor));
  return {
    success: true,
    now: Date.now(),
    jobs: (jobs || []).map(j => ({
      id: j.id, tailor: j.tailor, orderNo: j.order_no, sku: j.sku,
      garmentType: j.garment_type, startAt: j.start_at,
      accumMs: Number(j.accum_ms || 0), runSince: j.run_since || null,
      pauseReason: j.pause_reason || null, manual: !!j.manual,
      machineStopped: stopped.has(j.tailor)
    }))
  };
}

// ---- "By Time" report: finished tailoring time per SKU / tailor ----
// Returns one compact row per finished attempt (finished = waiting for QC,
// approved, or sent back for rework) that ended inside the window. The
// browser groups them into pieces and SKUs, so switching SKU <-> Model or
// re-sorting is instant and needs no extra round trip.
async function doAtelierTimeReport(params) {
  let days = parseInt(params && params.days, 10);
  if (!days || days < 1) days = 30;
  if (days > 365) days = 365;
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const pageSize = 1000, rows = [];
  for (let page = 0; page < 20; page++) {
    const chunk = (await sbFetch('GET',
      `atelier_jobs?status=in.(pending,approved,rework)&duration_ms=not.is.null&end_at=gte.${encodeURIComponent(since)}` +
      `&select=id,tailor,order_no,sku,model,garment_type,status,duration_ms,end_at&order=id.asc&limit=${pageSize}&offset=${page * pageSize}`)) || [];
    chunk.forEach(j => rows.push({
      t: j.tailor, o: j.order_no || '', s: j.sku || '', m: j.model || atelierModelFromSku(j.sku),
      g: j.garment_type || '', st: j.status, d: Number(j.duration_ms || 0), e: j.end_at
    }));
    if (chunk.length < pageSize) break;
  }
  return { success: true, days, now: Date.now(), rows };
}

// ---- Standard times (median/P25 from finished jobs) — admin-only to edit ----
function median(nums) {
  if (!nums.length) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function percentile(nums, p) {
  if (!nums.length) return null;
  const s = nums.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function doAtelierStandardsList() {
  const jobs = (await sbFetch('GET', 'atelier_jobs?status=eq.approved&duration_ms=not.is.null&select=model,qty,duration_ms,tailor')) || [];
  const byModel = {};
  // Per model, per tailor: every approved job's minutes/piece, so we can
  // tell who is fastest/slowest at sewing that particular model.
  const byModelTailor = {};
  const modelKey = m => (m || '').toString().trim().toUpperCase();
  jobs.forEach(j => {
    if (!j.model || !j.qty) return;
    j.model = modelKey(j.model); // "abc" / "ABC " / "ABC" are one model
    const minPerPiece = (j.duration_ms / 60000) / j.qty;
    (byModel[j.model] = byModel[j.model] || []).push(minPerPiece);
    if (j.tailor) {
      const tByTailor = (byModelTailor[j.model] = byModelTailor[j.model] || {});
      (tByTailor[j.tailor] = tByTailor[j.tailor] || []).push(minPerPiece);
    }
  });
  const currentRows = (await sbFetch('GET', 'atelier_standards?select=*')) || [];
  const currentByModel = {};
  currentRows.forEach(r => { currentByModel[modelKey(r.model)] = r; });

  const settings = await getAtelierSettings();
  const standards = Object.keys(byModel).map(model => {
    const vals = byModel[model];

    // Rank tailors on this model by their own average minutes/piece —
    // lower average = faster. Ties (or a single tailor) just report the
    // same name for both.
    const tailorStats = Object.keys(byModelTailor[model] || {}).map(tailor => {
      const arr = byModelTailor[model][tailor];
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      return { tailor, avgMinPerPiece: +avg.toFixed(1), jobCount: arr.length };
    });
    let fastestTailor = null, slowestTailor = null;
    if (tailorStats.length) {
      fastestTailor = tailorStats.reduce((a, b) => (b.avgMinPerPiece < a.avgMinPerPiece ? b : a));
      slowestTailor = tailorStats.reduce((a, b) => (b.avgMinPerPiece > a.avgMinPerPiece ? b : a));
    }

    return {
      model, jobCount: vals.length,
      medianMinPerPiece: +median(vals).toFixed(1),
      p25MinPerPiece: +percentile(vals, 25).toFixed(1),
      currentStandard: currentByModel[model] ? Number(currentByModel[model].min_per_piece) : null,
      fastestTailor, slowestTailor
    };
  });
  return { success: true, standards, typeDefaults: settings.type_std || {} };
}

async function doAtelierSetStandard(params) {
  const model = (params.model || '').toString().trim();
  const min = parseFloat(params.min);
  if (!model || isNaN(min) || min <= 0) return { success: false, error: 'Provide a model and a positive number of minutes.' };
  await sbFetch('POST', 'atelier_standards',
    { model, min_per_piece: min, updated_at: new Date().toISOString(), updated_by: (params.authenticatedName || 'admin').toString() },
    { Prefer: 'resolution=merge-duplicates,return=minimal' });
  return { success: true };
}

async function doAtelierUseFastStandard(params) {
  const model = (params.model || '').toString().trim();
  if (!model) return { success: false, error: 'Model is required.' };
  const wantKey = model.toUpperCase();
  const jobs = ((await sbFetch('GET', 'atelier_jobs?status=eq.approved&duration_ms=not.is.null&select=model,qty,duration_ms')) || [])
    .filter(j => (j.model || '').toString().trim().toUpperCase() === wantKey);
  const vals = jobs.filter(j => j.qty).map(j => (j.duration_ms / 60000) / j.qty);
  const p25 = percentile(vals, 25);
  if (p25 == null) return { success: false, error: 'Not enough finished jobs for this model yet.' };
  return doAtelierSetStandard({ model, min: p25, authenticatedName: params.authenticatedName });
}

async function doAtelierSetTypeDefault(params) {
  const type = (params.garmentType || '').toString();
  const min = parseFloat(params.min);
  if (ATELIER_GARMENT_TYPES.indexOf(type) === -1 || isNaN(min) || min <= 0) {
    return { success: false, error: 'Invalid garment type or minutes.' };
  }
  const settings = await getAtelierSettings();
  const typeStd = Object.assign({}, settings.type_std, { [type]: min });
  await sbFetch('PATCH', 'atelier_settings?id=eq.1', { type_std: typeStd, updated_at: new Date().toISOString() }, { Prefer: 'return=minimal' });
  invalidateAtelierSettingsCache();
  return { success: true };
}

// ---- Payroll (monthly) ----
async function doAtelierPayrollReport() {
  const jobs = (await sbFetch('GET', `atelier_jobs?created_at=gte.${atelierMonthStartIso()}&select=*`)) || [];
  const settings = await getAtelierSettings();
  const hoursPerDay = Number(settings.hours_per_day || 10);
  const daysPerMonth = Number(settings.days_per_month || 26);

  const byTailor = {};
  jobs.forEach(j => {
    const b = byTailor[j.tailor] || (byTailor[j.tailor] = {
      tailor: j.tailor, pieces: 0, standardHours: 0, hoursWorked: 0, reworkCount: 0, approvedPay: 0, pendingPay: 0
    });
    if (j.status === 'rework') { b.reworkCount++; }
    if (j.status === 'approved' || j.status === 'pending') {
      b.pieces += (j.qty || 0);
      b.standardHours += Number(j.standard_min || 0) / 60;
    }
    if (j.duration_ms) b.hoursWorked += j.duration_ms / 3600000;
    if (j.status === 'approved') b.approvedPay += Number(j.pay_amount || 0);
    if (j.status === 'pending') b.pendingPay += Number(j.pay_amount || 0);
  });

  const rows = Object.values(byTailor).map(b => {
    const efficiency = b.hoursWorked > 0 ? +(b.standardHours / b.hoursWorked * 100).toFixed(1) : 0;
    let livePay = null;
    if (settings.mode !== 'trial') {
      const rules = settings.pay_rules || {};
      let base = b.standardHours * Number(rules.ratePerStdHour || 0);
      const tier = (Array.isArray(rules.efficiencyTiers) ? rules.efficiencyTiers : [])
        .find(t => efficiency >= (t.min || 0) && efficiency <= (t.max != null ? t.max : Infinity));
      if (tier && tier.multiplier != null) base *= tier.multiplier;
      livePay = +Math.max(0, base - Number(rules.reworkPenalty || 0) * b.reworkCount).toFixed(3);
    }
    return {
      tailor: b.tailor, pieces: b.pieces, standardHours: +b.standardHours.toFixed(2), hoursWorked: +b.hoursWorked.toFixed(2),
      efficiency, reworkCount: b.reworkCount, approvedPay: +b.approvedPay.toFixed(3), pendingPay: +b.pendingPay.toFixed(3), livePay
    };
  });
  return { success: true, mode: settings.mode, monthlyCapacityHours: hoursPerDay * daysPerMonth, rows };
}

// ---- Settings (admin-only: rates and standard times are never sent to a
// tailor session) ----
function safeJsonObj(v) {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return {}; }
}

async function doAtelierGetSettings() {
  const s = await getAtelierSettings();
  return { success: true, settings: {
    mode: s.mode, typeRates: s.type_rates, typeStd: s.type_std,
    hoursPerDay: s.hours_per_day, daysPerMonth: s.days_per_month, payRules: s.pay_rules
  } };
}

async function doAtelierSetSettings(params) {
  const patch = { updated_at: new Date().toISOString() };
  if (params.mode === 'trial' || params.mode === 'live') patch.mode = params.mode;
  if (params.typeRates !== undefined) patch.type_rates = safeJsonObj(params.typeRates);
  if (params.typeStd !== undefined) patch.type_std = safeJsonObj(params.typeStd);
  if (params.hoursPerDay) patch.hours_per_day = parseFloat(params.hoursPerDay) || 10;
  if (params.daysPerMonth) patch.days_per_month = parseFloat(params.daysPerMonth) || 26;
  if (params.payRules !== undefined) patch.pay_rules = safeJsonObj(params.payRules);
  await sbFetch('PATCH', 'atelier_settings?id=eq.1', patch, { Prefer: 'return=minimal' });
  invalidateAtelierSettingsCache();
  return { success: true };
}

// Non-sensitive slice of settings any signed-in role may read (working
// hours/day for capacity display) — never includes rates or pay rules.
async function doAtelierGetWorkingTimeConfig() {
  const s = await getAtelierSettings();
  return { success: true, hoursPerDay: s.hours_per_day, daysPerMonth: s.days_per_month, mode: s.mode };
}

// ============================================================
// MCP SERVER — lets Claude (or any other MCP-compatible tool) work with
// this system directly in a conversation. Separate from the /api used by
// the browser app: these tools speak in plain order numbers and readable
// fields rather than row numbers and raw positional arrays.
// ============================================================

function embLabel(raw) {
  const m = (raw || '').match(/^(NEED|RED|RCVD|WORK|PAUSE|DONE|GREEN|SKIP)\|([^|]*)(?:\|([^|]*))?(?:\|([^|]*))?/);
  if (!m) return 'not started';
  switch (m[1]) {
    case 'SKIP': return 'not needed';
    case 'NEED': case 'RED': return 'needs embroidery';
    case 'RCVD': return 'received — not started (' + m[2] + ')';
    case 'WORK': return 'working — started ' + m[2];
    case 'PAUSE': return 'paused — ' + (m[4] || 'no reason') ;
    default: return 'done ' + m[2];
  }
}

function orderStatusLabel(rec) {
  if (rec.is_done) return 'Done';
  if (rec.tailor) return 'With tailor';
  if (rec.master) return 'In cutting';
  if (rec.fabric_status === 'Not Available') return 'No fabric';
  if (!rec.fabric_status) return 'Awaiting fabric check';
  return 'Fabric ready — not yet assigned';
}

function formatOrderForMcp(rec) {
  return {
    orderNo: rec.order_no,
    sku: rec.sku,
    garmentType: rec.garment_type,
    orderType: rec.order_type,
    status: orderStatusLabel(rec),
    fabricStatus: rec.fabric_status || 'not checked yet',
    fabricName: rec.fabric_name || null,
    fabricMadeIn: rec.fabric_made_in || null,
    machineEmbroidery: embLabel(rec.machine_emb),
    machEmbFabric: rec.mach_emb_fabric || null,
    machEmbMetersSent: rec.mach_emb_meters_sent,
    machEmbMetersReceived: rec.mach_emb_meters_received,
    handEmbroidery: embLabel(rec.hand_emb),
    master: rec.master || null,
    tailor: rec.tailor || null,
    urgent: !!rec.urgent,
    urgentDueDate: rec.urgent_due_date || null,
    createdAt: rec.created_at || null,
    doneAt: rec.done_at || null,
    notes: rec.notes || null
  };
}

async function findRowByOrderNo(orderNo) {
  const rows = await sbFetch('GET', `orders?order_no=eq.${encodeURIComponent(orderNo)}&select=id&limit=1`);
  return (rows && rows[0]) ? rows[0].id + 2 : null;
}

function mcpJson(obj, isError) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], structuredContent: obj, isError: !!isError };
}

function buildMcpServer() {
  const server = new McpServer({ name: 'production-tracker', version: '1.0.0' });

  server.registerTool('search_orders', {
    title: 'Search Orders',
    description: 'Search production orders by order number/SKU text, and optionally filter by status, master, or tailor. Returns the most recent matches (default 20, max 50) with readable fields. Use this when you don\'t know the exact order number.',
    inputSchema: {
      query: z.string().optional().describe('Text to match against order number or SKU'),
      status: z.enum(['done', 'cutting', 'with_tailor', 'awaiting_fabric', 'no_fabric', 'fabric_ready']).optional(),
      master: z.string().optional().describe('Filter to orders currently assigned to this cutting master'),
      tailor: z.string().optional().describe('Filter to orders currently assigned to this tailor'),
      limit: z.number().min(1).max(50).optional()
    }
  }, async ({ query, status, master, tailor, limit }) => {
    const max = Math.min(limit || 20, 50);
    let qs = 'select=*&order=id.desc&limit=800';
    if (master) qs += `&master=eq.${encodeURIComponent(master)}`;
    if (tailor) qs += `&tailor=eq.${encodeURIComponent(tailor)}`;
    if (status === 'done') qs += '&is_done=eq.true';

    const rows = (await sbFetch('GET', `orders?${qs}`)) || [];
    const statusMap = {
      cutting: 'In cutting', with_tailor: 'With tailor',
      awaiting_fabric: 'Awaiting fabric check', no_fabric: 'No fabric',
      fabric_ready: 'Fabric ready — not yet assigned'
    };

    const results = rows.filter(rec => {
      if (query) {
        const hay = (String(rec.order_no || '') + ' ' + String(rec.sku || '')).toLowerCase();
        if (!hay.includes(query.toLowerCase())) return false;
      }
      if (status && status !== 'done') {
        if (orderStatusLabel(rec) !== statusMap[status]) return false;
      }
      return true;
    }).slice(0, max).map(formatOrderForMcp);

    return mcpJson({ count: results.length, note: 'Searched the 800 most recent orders — narrow with query/master/tailor for older ones.', orders: results });
  });

  server.registerTool('get_order', {
    title: 'Get Order',
    description: 'Get full details for one order by its exact order number.',
    inputSchema: { orderNo: z.string() }
  }, async ({ orderNo }) => {
    const rows = await sbFetch('GET', `orders?order_no=eq.${encodeURIComponent(orderNo)}&limit=1`);
    const rec = rows && rows[0];
    if (!rec) return mcpJson({ error: 'No order found with order number "' + orderNo + '".' }, true);
    return mcpJson(formatOrderForMcp(rec));
  });

  server.registerTool('add_order', {
    title: 'Add Order',
    description: 'Create a new production order. Automatically routes it to machine/hand embroidery (or skips both, for Simple) based on orderType, same as adding one from the app.',
    inputSchema: {
      orderNo: z.string(), sku: z.string(),
      garmentType: z.enum(['Abaya', 'Vest', 'Pant', 'Skirt', 'Dress', 'Bisht', 'Blouse']),
      orderType: z.enum(['Simple', 'Hand Embroidery', 'Machine Embroidery']),
      notes: z.string().optional(),
      chest: z.string().optional(), sleeve: z.string().optional(), shoulder: z.string().optional(),
      armfit: z.string().optional(), length: z.string().optional(), size: z.string().optional(),
      urgent: z.boolean().optional(), urgentDate: z.string().optional().describe('Required if urgent is true, format DD/MM/YYYY or similar')
    }
  }, async (p) => {
    const result = await doAddOrder({
      orderNo: p.orderNo, sku: p.sku, garmentType: p.garmentType, orderType: p.orderType,
      notes: p.notes || '', chest: p.chest || '', sleeve: p.sleeve || '', shoulder: p.shoulder || '',
      armfit: p.armfit || '', length: p.length || '', size: p.size || '',
      urgent: p.urgent ? 'Yes' : '', urgentDate: p.urgentDate || ''
    });
    if (!result.success) return mcpJson(result, true);

    const ts = new Date().toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    if (p.orderType === 'Hand Embroidery') {
      await doUpdateHandEmb({ row: result.row, value: 'NEED|' + ts });
      await doUpdateMachEmb({ row: result.row, value: 'SKIP|' + ts });
    } else if (p.orderType === 'Machine Embroidery') {
      await doUpdateMachEmb({ row: result.row, value: 'NEED|' + ts });
      await doUpdateHandEmb({ row: result.row, value: 'SKIP|' + ts });
    } else {
      await doUpdateMachEmb({ row: result.row, value: 'SKIP|' + ts });
      await doUpdateHandEmb({ row: result.row, value: 'SKIP|' + ts });
    }
    return mcpJson({ success: true, orderNo: p.orderNo });
  });

  server.registerTool('update_fabric', {
    title: 'Update Fabric Status',
    description: 'Mark an order\'s fabric as Available or Not Available.',
    inputSchema: { orderNo: z.string(), value: z.enum(['Available', 'Not Available']) }
  }, async ({ orderNo, value }) => {
    const row = await findRowByOrderNo(orderNo);
    if (!row) return mcpJson({ error: 'No order found with order number "' + orderNo + '".' }, true);
    return mcpJson(await doUpdateFabric({ row, value }));
  });

  server.registerTool('assign_master', {
    title: 'Assign Cutting Master',
    description: 'Assign (or reassign) which master is cutting an order. Pass an empty master to unassign.',
    inputSchema: { orderNo: z.string(), master: z.string() }
  }, async ({ orderNo, master }) => {
    const row = await findRowByOrderNo(orderNo);
    if (!row) return mcpJson({ error: 'No order found with order number "' + orderNo + '".' }, true);
    return mcpJson(await doUpdateMaster({ row, master }));
  });

  server.registerTool('assign_tailor', {
    title: 'Assign Tailor',
    description: 'Assign (or reassign) which tailor is sewing an order. Pass an empty tailor to unassign.',
    inputSchema: { orderNo: z.string(), tailor: z.string() }
  }, async ({ orderNo, tailor }) => {
    const row = await findRowByOrderNo(orderNo);
    if (!row) return mcpJson({ error: 'No order found with order number "' + orderNo + '".' }, true);
    return mcpJson(await doUpdateTailor({ row, tailor }));
  });

  server.registerTool('mark_order_done', {
    title: 'Mark Order Done',
    description: 'Mark an order as completed. Fails if no tailor has been assigned yet.',
    inputSchema: { orderNo: z.string() }
  }, async ({ orderNo }) => {
    const row = await findRowByOrderNo(orderNo);
    if (!row) return mcpJson({ error: 'No order found with order number "' + orderNo + '".' }, true);
    return mcpJson(await doMarkDone({ row }));
  });

  server.registerTool('undo_order_done', {
    title: 'Undo Order Done',
    description: 'Reopen an order that was accidentally marked Done, putting it back to in-progress.',
    inputSchema: { orderNo: z.string() }
  }, async ({ orderNo }) => {
    const row = await findRowByOrderNo(orderNo);
    if (!row) return mcpJson({ error: 'No order found with order number "' + orderNo + '".' }, true);
    return mcpJson(await doUndoMarkDone({ row }));
  });

  server.registerTool('get_production_summary', {
    title: 'Get Production Summary',
    description: 'Aggregate production stats: totals, how many are done/in-cutting/with-tailor/awaiting-fabric, and a per-master and per-tailor breakdown. Much cheaper than listing every order when you just need the numbers.',
    inputSchema: {}
  }, async () => {
    const rows = (await sbFetch('GET', 'orders?select=order_no,master,tailor,fabric_status,is_done&order=id.desc&limit=2000')) || [];
    const summary = { totalConsidered: rows.length, done: 0, withTailor: 0, inCutting: 0, awaitingFabric: 0, noFabric: 0, byMaster: {}, byTailor: {} };
    rows.forEach(rec => {
      if (rec.is_done) summary.done++;
      else if (rec.tailor) summary.withTailor++;
      else if (rec.master) summary.inCutting++;
      else if (rec.fabric_status === 'Not Available') summary.noFabric++;
      else if (!rec.fabric_status) summary.awaitingFabric++;

      if (rec.master && !rec.is_done) summary.byMaster[rec.master] = (summary.byMaster[rec.master] || 0) + 1;
      if (rec.tailor && !rec.is_done) summary.byTailor[rec.tailor] = (summary.byTailor[rec.tailor] || 0) + 1;
    });
    return mcpJson(summary);
  });

  server.registerTool('list_staff', {
    title: 'List Staff',
    description: 'List active masters, tailors, designers, or pattern masters.',
    inputSchema: { staffRole: z.enum(['master', 'tailor', 'designer', 'patternmaster']) }
  }, async ({ staffRole }) => {
    return mcpJson({ staffRole, names: await getActiveStaffNames(staffRole) });
  });

  return server;
}

app.post('/mcp/:apiKey', async (req, res) => {
  if (!API_KEY || req.params.apiKey !== API_KEY) {
    return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
  }
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => transport.close());
    const mcpServer = buildMcpServer();
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP error:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

app.listen(PORT, () => {
  console.log(`Production Tracker backend listening on port ${PORT}`);
});
