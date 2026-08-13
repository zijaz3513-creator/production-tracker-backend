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
  machemb: process.env.MACHEMB_PASSWORD
};

// Roles managed as individual people in the "staff" table instead of a
// single shared password. Tailors are capped (MAX_TAILOR_SLOTS) because
// of the order row layout; the others aren't.
const STAFF_ROLES = ['master', 'tailor', 'designer', 'patternmaster'];

Object.keys(ROLE_PASSWORDS).forEach(role => {
  if (!ROLE_PASSWORDS[role]) {
    console.warn(`Warning: no password set for role "${role}" (set ${role.toUpperCase()}_PASSWORD in the environment) — that role cannot log in yet.`);
  }
});

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
  inventory: ['getOrders', 'updateFabric', 'updateFabricDetails', 'updateMachEmb', 'updateHandEmb'],
  master: ['getOrders', 'updateTailor'],
  tailor: ['getOrders', 'markDone', 'getSamples', 'markSampleDone'],
  designer: ['getSamples', 'addSample'],
  patternmaster: ['getSamples', 'assignSampleTailor']
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
  const [masters, tailors, designers, patternmasters] = await Promise.all([
    getActiveStaffNames('master'),
    getActiveStaffNames('tailor'),
    getActiveStaffNames('designer'),
    getActiveStaffNames('patternmaster')
  ]);
  return { success: true, masters, tailors, designers, patternmasters };
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

    // Every other action requires a valid session from a successful
    // password login. The role used for permission checks comes from the
    // session (set at login time), never from whatever the browser sends,
    // so a client can't just claim to be "admin".
    const session = getSession(params.token);
    if (!session) {
      return res.json({ success: false, error: 'Session expired. Please log in again.' });
    }

    const permissionError = checkPermission(action, session.role);
    const result = permissionError || (await routeAction(action, Object.assign({}, params, { role: session.role })));
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
    case 'addOrder': return doAddOrder(params);
    case 'updateFabric': return doUpdateFabric(params);
    case 'updateFabricDetails': return doUpdateFabricDetails(params);
    case 'updateMachEmb': return doUpdateMachEmb(params);
    case 'updateHandEmb': return doUpdateHandEmb(params);
    case 'updateMaster': return doUpdateMaster(params);
    case 'updateTailor': return doUpdateTailor(params);
    case 'markDone': return doMarkDone(params);
    case 'deleteOrder': return doDeleteOrder(params);
    case 'updateUrgent': return doUpdateUrgent(params);
    case 'getSamples': return doGetSamples();
    case 'addSample': return doAddSample(params);
    case 'assignSampleTailor': return doAssignSampleTailor(params);
    case 'markSampleDone': return doMarkSampleDone(params);
    case 'listStaff': return doListStaff(params);
    case 'addStaff': return doAddStaff(params);
    case 'removeStaff': return doRemoveStaff(params);
    case 'reorderStaff': return doReorderStaff(params);
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
function buildOrderRowArray(rec, tailorNames) {
  const row = new Array(39).fill('');
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

  if (rec.tailor) {
    const idx = tailorNames.indexOf(rec.tailor);
    if (idx !== -1) row[10 + idx] = rec.tailor_assigned_at || '';
  }

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
  return row;
}

async function doGetOrders() {
  const [records, tailorNames] = await Promise.all([
    sbSelectAll('orders', 'id'),
    getActiveStaffNames('tailor')
  ]);
  const byId = {};
  let maxId = 0;
  records.forEach(rec => {
    byId[rec.id] = rec;
    if (rec.id > maxId) maxId = rec.id;
  });

  const data = [new Array(39).fill(''), new Array(39).fill('')];
  for (let id = 1; id <= maxId; id++) {
    const rec = byId[id];
    data.push(isBlankOrder_(rec) ? null : buildOrderRowArray(rec, tailorNames));
  }
  return { success: true, data };
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

  return { success: true, row: created.id + 2, srNo };
}

async function doUpdateFabric(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const value = params.value;
  if (value !== 'Available' && value !== 'Not Available') {
    return { success: false, error: 'Fabric value must be "Available" or "Not Available".' };
  }
  await sbUpdate('orders', row - 2, { fabric_status: value });
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
    return { success: true };
  }
  const masters = await getActiveStaffNames('master');
  if (masters.indexOf(master) === -1) {
    return { success: false, error: 'Unknown master: ' + master };
  }
  await sbUpdate('orders', id, { master, master_assigned_at: new Date().toISOString() });
  return { success: true };
}

async function doUpdateTailor(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const tailor = (params.tailor || '').toString();
  const id = row - 2;

  if (tailor === '') {
    await sbUpdate('orders', id, { tailor: null, tailor_assigned_at: null });
    return { success: true };
  }
  const tailors = await getActiveStaffNames('tailor');
  if (tailors.indexOf(tailor) === -1) {
    return { success: false, error: 'Unknown tailor: ' + tailor };
  }
  await sbUpdate('orders', id, { tailor, tailor_assigned_at: new Date().toISOString() });
  return { success: true };
}

async function doMarkDone(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const id = row - 2;

  const rec = await sbFetch('GET', 'orders?id=eq.' + id + '&select=tailor');
  if (!rec || !rec.length || !rec[0].tailor) {
    return { success: false, error: 'Cannot mark Done — no tailor has been assigned yet.' };
  }
  await sbUpdate('orders', id, { is_done: true, done_at: new Date().toISOString() });
  return { success: true };
}

async function doDeleteOrder(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  await sbUpdate('orders', row - 2, {
    sr_no: null, order_no: null, sku: null, fabric_status: null,
    fabric_name: null, fabric_made_in: null, garment_type: null, order_type: null,
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
  const row = new Array(33).fill('');
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

  const data = [new Array(33).fill('')];
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
    lining_color: liningColor, piping_color: pipingColor
  });

  const slotsToInsert = fabricSlots
    .filter(f => f.fabric_name || f.fabric_color || f.meters != null)
    .map(f => Object.assign({ sample_id: created.id }, f));
  if (slotsToInsert.length) await sbInsertMany('sample_fabrics', slotsToInsert);

  return { success: true, row: created.id + 1, srNo };
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

async function doMarkSampleDone(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const id = row - 1;

  const rec = await sbFetch('GET', 'design_samples?id=eq.' + id + '&select=tailor');
  if (!rec || !rec.length || !rec[0].tailor) {
    return { success: false, error: 'Cannot mark Done — no tailor has been assigned yet.' };
  }
  await sbUpdate('design_samples', id, { tailor_ended_at: new Date().toISOString(), is_done: true });
  return { success: true };
}

app.listen(PORT, () => {
  console.log(`Production Tracker backend listening on port ${PORT}`);
});
