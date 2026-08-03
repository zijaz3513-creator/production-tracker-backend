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

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const PORT = process.env.PORT || 3000;

// Comma-separated list, e.g. "https://yourdomain.com,https://www.yourdomain.com"
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SECRET_KEY in environment (.env). Exiting.');
  process.exit(1);
}

const MASTERS = ['Imran', 'Rafiq', 'Sheikh', 'Baskaran', 'Usman'];
const TAILORS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11'];

const DESIGNERS = ['Sally', 'Emman', 'Nikita'];
const PATTERN_MASTERS = ['Nihal', 'Sohail'];
const SAMPLE_TAILORS = TAILORS;
const MAX_FABRIC_SLOTS = 6;

// Which actions each role may call. Admin bypasses this check entirely.
const ROLE_PERMISSIONS = {
  inventory: ['getOrders', 'updateFabric', 'updateMachEmb', 'updateHandEmb'],
  master: ['getOrders', 'updateMaster', 'updateTailor'],
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
    const permissionError = checkPermission(action, params.role);
    const result = permissionError || (await routeAction(action, params));
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
  const row = new Array(34).fill('');
  if (!rec) return row;

  row[0] = rec.sr_no || '';
  row[1] = rec.order_no || '';
  row[2] = rec.sku || '';
  row[3] = rec.fabric_status || '';
  row[4] = rec.master || '';
  row[5] = rec.master_assigned_at || '';
  row[6] = rec.machine_emb || '';
  row[8] = rec.hand_emb || '';

  if (rec.tailor) {
    const idx = TAILORS.indexOf(rec.tailor);
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

  const data = [new Array(34).fill(''), new Array(34).fill('')];
  for (let id = 1; id <= maxId; id++) {
    const rec = byId[id];
    data.push(isBlankOrder_(rec) ? null : buildOrderRowArray(rec));
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
    sr_no: srNo, order_no: orderNo, sku,
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

async function doUpdateMachEmb(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const value = params.value;
  if (!/^(RED|GREEN|SKIP)\|/.test(value || '')) {
    return { success: false, error: 'Invalid machine embroidery value format.' };
  }
  await sbUpdate('orders', row - 2, { machine_emb: value });
  return { success: true };
}

async function doUpdateHandEmb(params) {
  const row = parseRow(params);
  if (!row) return { success: false, error: 'Invalid row.' };
  const value = params.value;
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
  if (MASTERS.indexOf(master) === -1) {
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
  if (TAILORS.indexOf(tailor) === -1) {
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
    master: null, master_assigned_at: null, machine_emb: null, hand_emb: null,
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

  if (DESIGNERS.indexOf(name) === -1) return { success: false, error: 'Unknown designer: ' + name };
  if (!code || !type) return { success: false, error: 'Code and Type are required.' };

  const master = (params.master || '').toString().trim();
  if (PATTERN_MASTERS.indexOf(master) === -1) {
    return { success: false, error: 'Master must be Nihal or Sohail.' };
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
  if (SAMPLE_TAILORS.indexOf(tailor) === -1) {
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
