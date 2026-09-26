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
  // Aeon Workstation supervisor — approves tailoring jobs, sees team status and
  // payroll, but (like everyone except admin) cannot see or edit pay rates
  // or standard times.
  atelier_supervisor: process.env.ATELIER_SUPERVISOR_PASSWORD
};

// Roles managed as individual people in the "staff" table instead of a
// single shared password. Tailors are capped (MAX_TAILOR_SLOTS) because
// of the order row layout; the others aren't.
const STAFF_ROLES = ['master', 'tailor', 'designer', 'patternmaster', 'samplemachemb', 'samplehandemb'];

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

// Simple in-memory session store: token -> { role, name, createdAt }. Good
// enough for a single small server instance. Sessions are lost on restart
// (e.g. Render free tier spinning down after inactivity) — logging back in
// takes a few seconds, it's not an error.
const sessions = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  return s;
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
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { role, name, createdAt: Date.now() });
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

  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { role, name, createdAt: Date.now() });
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

const MAX_TAILOR_SLOTS = 11; // fixed by the order row layout (columns 10-20)
const MAX_FABRIC_SLOTS = 6;

// Which actions each role may call. Admin bypasses this check entirely.
const ROLE_PERMISSIONS = {
  inventory: ['getOrders', 'getOrder', 'getOrderByOrderNo', 'updateFabric', 'updateFabricDetails', 'updateMachEmb', 'updateHandEmb', 'markDone'],
  master: ['getOrders', 'getOrder', 'getOrderByOrderNo', 'updateTailor'],
  tailor: [
    'getOrders', 'getOrder', 'getOrderByOrderNo', 'markDone', 'getSamples', 'markSampleDone', 'sendSampleEmb',
    // Aeon Workstation — tailor floor
    'atelierMyOrders', 'atelierStartJob', 'atelierPauseJob', 'atelierResumeJob', 'atelierFinishJob', 'atelierReturnJob',
    'atelierMechanicCall', 'atelierMyToday', 'atelierMyHistory', 'atelierMyEarnings', 'atelierGetWorkingTimeConfig'
  ],
  // Aeon Workstation supervisor: approvals, team status, standard-time
  // *viewing*, payroll and mechanic calls. Cannot see/edit pay rates or
  // write standard times — those stay admin-only per spec.
  atelier_supervisor: [
    'atelierApprovalsList', 'atelierApproveJob', 'atelierRejectJob', 'atelierTeamToday',
    'atelierStandardsList', 'atelierPayrollReport', 'atelierMechanicCallsList', 'atelierMechanicResolve',
    'atelierGetWorkingTimeConfig', 'atelierFindPendingByCode'
  ],
  designer: ['getSamples', 'addSample'],
  patternmaster: ['getSamples', 'assignSampleTailor'],
  samplemachemb: ['getSamples', 'receiveSampleEmb'],
  samplehandemb: ['getSamples', 'receiveSampleEmb'],
  // Same access as Admin, except it cannot delete orders/samples or remove
  // staff — those three stay Admin-only.
  fulfillment: [
    'getOrders', 'getOrder', 'getOrderByOrderNo', 'addOrder', 'updateFabric', 'updateFabricDetails',
    'updateMachEmb', 'updateHandEmb', 'updateMaster', 'updateTailor',
    'markDone', 'undoMarkDone', 'updateUrgent',
    'getSamples', 'addSample', 'assignSampleTailor', 'assignSampleMaster',
    'markSampleDone', 'undoSampleDone', 'sendSampleEmb', 'receiveSampleEmb',
    'listStaff', 'addStaff', 'reorderStaff'
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

async function doGetRoster() {
  const [masters, tailors, designers, patternmasters, sampleMachEmb, sampleHandEmb] = await Promise.all([
    getActiveStaffNames('master'),
    getActiveStaffNames('tailor'),
    getActiveStaffNames('designer'),
    getActiveStaffNames('patternmaster'),
    getActiveStaffNames('samplemachemb'),
    getActiveStaffNames('samplehandemb')
  ]);
  return { success: true, masters, tailors, designers, patternmasters, sampleMachEmb, sampleHandEmb };
}

async function doListStaff(params) {
  const staffRole = (params.staffRole || '').toString();
  if (STAFF_ROLES.indexOf(staffRole) === -1) {
    return { success: false, error: 'Invalid staff role.' };
  }
  return { success: true, staff: await getActiveStaff(staffRole) };
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
  if (staffRole === 'tailor' && current.length >= MAX_TAILOR_SLOTS) {
    return { success: false, error: `Maximum of ${MAX_TAILOR_SLOTS} active tailors — remove one before adding another.` };
  }

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
      if (params.token) sessions.delete(params.token);
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

async function routeAction(action, params) {
  switch (action) {
    case 'getOrders': return doGetOrders();
    case 'getOrder': return doGetOrder(params);
    case 'getOrderByOrderNo': return doGetOrderByOrderNo(params);
    case 'addOrder': return doAddOrder(params);
    case 'updateFabric': return doUpdateFabric(params);
    case 'updateFabricDetails': return doUpdateFabricDetails(params);
    case 'updateMachEmb': return doUpdateMachEmb(params);
    case 'updateHandEmb': return doUpdateHandEmb(params);
    case 'updateMaster': return doUpdateMaster(params);
    case 'updateTailor': return doUpdateTailor(params);
    case 'markDone': return doMarkDone(params);
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
    case 'atelierTeamToday': return doAtelierTeamToday();
    case 'atelierStandardsList': return doAtelierStandardsList();
    case 'atelierMechanicCallsList': return doAtelierMechanicCallsList();
    case 'atelierMechanicResolve': return doAtelierMechanicResolve(params);
    case 'atelierPayrollReport': return doAtelierPayrollReport();
    case 'atelierFindPendingByCode': return doAtelierFindPendingByCode(params);
    // Aeon Workstation — admin only (not in any role's permission list above,
    // so only the admin bypass in checkPermission() can reach these)
    case 'atelierSetStandard': return doAtelierSetStandard(params);
    case 'atelierUseFastStandard': return doAtelierUseFastStandard(params);
    case 'atelierSetTypeDefault': return doAtelierSetTypeDefault(params);
    case 'atelierGetSettings': return doAtelierGetSettings();
    case 'atelierSetSettings': return doAtelierSetSettings(params);
    case 'atelierSetPin': return doAtelierSetPin(params);
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
function buildOrderRowArray(rec) {
  const row = new Array(41).fill('');
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

  const data = [new Array(41).fill(''), new Array(41).fill('')];
  for (let id = 1; id <= maxId; id++) {
    const rec = byId[id];
    data.push(isBlankOrder_(rec) ? null : buildOrderRowArray(rec));
  }
  return { success: true, data };
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
  return { success: true, row, data: buildOrderRowArray(rec) };
}

// Same idea as doGetOrder, but for when the caller only has the order
// number/SKU (e.g. a fresh QR scan or manual lookup not yet in the local
// cache) and doesn't know the internal row id yet.
async function doGetOrderByOrderNo(params) {
  const orderNo = (params.orderNo || '').toString().trim();
  const sku = (params.sku || '').toString().trim();
  if (!orderNo) return { success: false, error: 'Order number is required.' };

  let query = `orders?order_no=eq.${encodeURIComponent(orderNo)}&select=*&limit=1`;
  if (sku) query = `orders?order_no=eq.${encodeURIComponent(orderNo)}&sku=eq.${encodeURIComponent(sku)}&select=*&limit=1`;

  const recs = await sbFetch('GET', query);
  const rec = recs && recs[0];
  if (!rec) return { success: false, error: 'Order "' + orderNo + '" not found.' };
  return { success: true, row: rec.id + 2, data: buildOrderRowArray(rec) };
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

  const patch = { fabric_status: value };

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
    patch.master_assigned_at = null;
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
  const madeIn = (params.madeIn || '').toString().trim();
  await sbUpdate('orders', row - 2, {
    fabric_name: fabricName || null,
    fabric_made_in: madeIn || null
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
      machine_emb: null, mach_emb_fabric: null,
      mach_emb_meters_sent: null, mach_emb_meters_received: null
    });
    return { success: true };
  }

  if (!/^(RED|GREEN|SKIP)\|/.test(value || '')) {
    return { success: false, error: 'Invalid machine embroidery value format.' };
  }

  const patch = { machine_emb: value };
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

async function doUpdateHandEmb(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const value = params.value;

  if (value === 'CLEAR') {
    await sbUpdate('orders', row - 2, { hand_emb: null });
    return { success: true };
  }

  if (!/^(RED|GREEN|SKIP)\|/.test(value || '')) {
    return { success: false, error: 'Invalid hand embroidery value format.' };
  }
  await sbUpdate('orders', row - 2, { hand_emb: value });
  return { success: true };
}

async function doUpdateMaster(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const master = (params.master || '').toString();
  const id = row - 2;

  if (master === '') {
    await sbUpdate('orders', id, { master: null, master_assigned_at: null });
    pushShopifyUpdate(await getOrderNo(row), 'Master unassigned');
    return { success: true };
  }
  const masters = await getActiveStaffNames('master');
  if (masters.indexOf(master) === -1) {
    return { success: false, error: 'Unknown master: ' + master };
  }
  await sbUpdate('orders', id, { master, master_assigned_at: new Date().toISOString() });
  pushShopifyUpdate(await getOrderNo(row), `In cutting — assigned to Master: ${master}`);
  return { success: true };
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
  await sbUpdate('orders', id, { tailor, tailor_assigned_at: new Date().toISOString() });
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
  if (!s.tailor && !isReadyMadeStatus(s.fabric_status)) {
    return { success: false, error: 'Cannot mark Done — no tailor has been assigned yet.' };
  }
  await sbUpdate('orders', id, { is_done: true, done_at: new Date().toISOString() });
  pushShopifyUpdate(s.order_no, 'Production complete — Done ✅');
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
    master: null, master_assigned_at: null, machine_emb: null, hand_emb: null,
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

function atelierQtyFromNotes(notes) {
  const m = (notes || '').toString().match(/(\d+)\s*(pcs|pc|pieces)/i);
  return m ? (parseInt(m[1], 10) || 1) : 1;
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
    const rows = await sbFetch('GET', `atelier_standards?model=eq.${encodeURIComponent(model)}&select=min_per_piece&limit=1`);
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
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { role: 'tailor', name, createdAt: Date.now() });
  return { success: true, token, name };
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

  // Rule: a line is hidden once a non-rework job exists for (orderNo, sku).
  const blockKey = new Set();
  const jobs = (await sbFetch('GET', `atelier_jobs?tailor=eq.${encodeURIComponent(tailor)}&status=in.(active,pending,approved)&select=order_no,sku`)) || [];
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
  let qty = parseInt(params.qty, 10) || 1;
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

    const blocked = await sbFetch('GET', `atelier_jobs?order_no=eq.${encodeURIComponent(orderNo)}&sku=eq.${encodeURIComponent(sku)}&status=in.(active,pending,approved)&select=id&limit=1`);
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
  return { success: true, job: formatAtelierJob(job) };
}

async function doAtelierPauseJob(params) {
  const tailor = (params.authenticatedName || '').toString();
  const jobId = parseInt(params.jobId, 10) || null;
  const job = jobId ? await getAtelierJobForTailor(tailor, jobId) : await getAtelierActiveJob(tailor);
  if (!job) return { success: false, error: 'No running job to pause.' };
  if (!job.run_since) return { success: true };
  const accum = Number(job.accum_ms || 0) + (Date.now() - new Date(job.run_since).getTime());
  await sbUpdate('atelier_jobs', job.id, { accum_ms: accum, run_since: null });
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
  await sbUpdate('atelier_jobs', job.id, { run_since: new Date().toISOString() });
  return { success: true };
}

async function doAtelierFinishJob(params) {
  const tailor = (params.authenticatedName || '').toString();
  const jobId = parseInt(params.jobId, 10) || null;
  const job = jobId ? await getAtelierJobForTailor(tailor, jobId) : await getAtelierActiveJob(tailor);
  if (!job) return { success: false, error: 'No job to finish.' };
  const accum = Number(job.accum_ms || 0) + (job.run_since ? (Date.now() - new Date(job.run_since).getTime()) : 0);
  const now = new Date().toISOString();
  await sbUpdate('atelier_jobs', job.id, { accum_ms: accum, run_since: null, status: 'pending', end_at: now, duration_ms: accum });
  return { success: true };
}

async function doAtelierReturnJob(params) {
  // Gives back an unfinished job — the order line reappears in the list.
  const tailor = (params.authenticatedName || '').toString();
  const jobId = parseInt(params.jobId, 10) || null;
  const job = jobId ? await getAtelierJobForTailor(tailor, jobId) : await getAtelierActiveJob(tailor);
  if (!job) return { success: false, error: 'No job to return.' };
  await sbFetch('DELETE', `atelier_jobs?id=eq.${job.id}`, undefined, { Prefer: 'return=minimal' });
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
    accumMs: j.accum_ms, runSince: j.run_since,
    standardMinutes: j.standard_min, payAmount: j.pay_amount,
    approvedAt: j.approved_at, reworkAt: j.rework_at
  };
}

async function doAtelierMyToday(params) {
  const tailor = (params.authenticatedName || '').toString();
  const jobs = (await sbFetch('GET', `atelier_jobs?tailor=eq.${encodeURIComponent(tailor)}&created_at=gte.${atelierTodayStartIso()}&select=*`)) || [];
  const activeJobs = jobs.filter(j => j.status === 'active').sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
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
async function doAtelierApprovalsList() {
  const rows = (await sbFetch('GET', 'atelier_jobs?status=eq.pending&select=*&order=end_at.asc')) || [];
  return { success: true, jobs: rows.map(formatAtelierJob) };
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

  const base = orderNo && sku
    ? `order_no=eq.${encodeURIComponent(orderNo)}&sku=eq.${encodeURIComponent(sku)}`
    : orderNo
      ? `order_no=eq.${encodeURIComponent(orderNo)}`
      : `sku=eq.${encodeURIComponent(sku)}`;

  const pending = await sbFetch('GET', `atelier_jobs?${base}&status=eq.pending&select=*&order=created_at.desc&limit=1`);
  if (pending && pending[0]) return { success: true, job: formatAtelierJob(pending[0]), matchStatus: 'pending' };

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

  const qtyRaw = params.correctedQty;
  const qty = (qtyRaw !== undefined && qtyRaw !== '' && !isNaN(parseInt(qtyRaw, 10))) ? parseInt(qtyRaw, 10) : job.qty;

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
  if (SHOPIFY_ENABLED) pushShopifyUpdate(job.order_no, `Tailoring approved — ${job.tailor}, ${qty} pc(s)`);
  return { success: true };
}

async function doAtelierRejectJob(params) {
  const id = parseInt(params.jobId, 10);
  if (!id) return { success: false, error: 'Invalid job id.' };
  const approver = (params.authenticatedName || params.role || '').toString();

  const rows = await sbFetch('GET', `atelier_jobs?id=eq.${id}&select=tailor,status&limit=1`);
  const job = rows && rows[0];
  if (!job) return { success: false, error: 'Job not found.' };
  if (job.status !== 'pending') return { success: false, error: 'This job is not pending approval.' };
  if (job.tailor === approver) return { success: false, error: 'You cannot review your own work.' };

  await sbUpdate('atelier_jobs', id, { status: 'rework', rework_at: new Date().toISOString(), pay_amount: 0 });
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
        b.currentOrder = { orderNo: j.order_no, sku: j.sku, garmentType: j.garment_type };
        b.status = stopped.has(j.tailor) ? 'machine_stopped' : (j.run_since ? 'working' : 'paused');
      }
    }
  });
  return { success: true, team: Object.values(byTailor).map(b => Object.assign({}, b, { minutes: Math.round(b.minutes) })) };
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
  const jobs = (await sbFetch('GET', 'atelier_jobs?status=eq.approved&duration_ms=not.is.null&select=model,qty,duration_ms')) || [];
  const byModel = {};
  jobs.forEach(j => {
    if (!j.model || !j.qty) return;
    (byModel[j.model] = byModel[j.model] || []).push((j.duration_ms / 60000) / j.qty);
  });
  const currentRows = (await sbFetch('GET', 'atelier_standards?select=*')) || [];
  const currentByModel = {};
  currentRows.forEach(r => { currentByModel[r.model] = r; });

  const settings = await getAtelierSettings();
  const standards = Object.keys(byModel).map(model => {
    const vals = byModel[model];
    return {
      model, jobCount: vals.length,
      medianMinPerPiece: +median(vals).toFixed(1),
      p25MinPerPiece: +percentile(vals, 25).toFixed(1),
      currentStandard: currentByModel[model] ? Number(currentByModel[model].min_per_piece) : null
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
  const jobs = (await sbFetch('GET', `atelier_jobs?status=eq.approved&model=eq.${encodeURIComponent(model)}&duration_ms=not.is.null&select=qty,duration_ms`)) || [];
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
  const m = (raw || '').match(/^(RED|GREEN|SKIP)\|(.*)$/);
  if (!m) return 'not started';
  if (m[1] === 'SKIP') return 'not needed';
  if (m[1] === 'RED') return 'out — sent ' + m[2];
  return 'received ' + m[2];
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
      await doUpdateHandEmb({ row: result.row, value: 'RED|' + ts });
      await doUpdateMachEmb({ row: result.row, value: 'SKIP|' + ts });
    } else if (p.orderType === 'Machine Embroidery') {
      await doUpdateMachEmb({ row: result.row, value: 'RED|' + ts });
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
