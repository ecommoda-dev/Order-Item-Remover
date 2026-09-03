// ══════════════════════════════════════════════════════════════════
// §HEADER
// EcomModa — Order Item Remover Worker
// Version: 1.2.0
// Tier: 1 — Shopify order editing (removes an unfulfilled line item; irreversible
//           in the sense that Shopify keeps no "undo" — the item can only be
//           re-added manually afterward). Never restocks — mandatory S1/reason
//           metafield side effect on every removal (28-08-2026).
// Cloudflare Worker ES Module
// skills: ecommoda-worker-builder v1.0.0 · shopify-graphql-helper v1.0.0 ·
//         ecommoda-order-lifecycle v1.1.0 · ecommoda-constants v1.2.0 (28-08-2026)
//
// CHANGELOG v1.2.0:
//   - 🟠 R6 — حارس `WORKER_SECRET` الغايب قبل فحص المصادقة. من غيره
//     `Bearer ${env.WORKER_SECRET}` بيتقيّم للنص الحرفي "Bearer undefined"
//     لو السيكرت اتنسي أو النسخة اتنشرت بدون Promote — فأي طلب بالرأس ده
//     كان بيعدّي المصادقة. الرد بقى 500 برسالة صريحة + step:'env'.
//     (مراجعة 03-09-2026 · R6)
// ══════════════════════════════════════════════════════════════════


// ══════════════════════════════════════════════════════════════════
// §CONSTANTS
// ══════════════════════════════════════════════════════════════════
const WORKER_VERSION = '1.2.0';
const TOOL_NAME       = 'order_item_remover'; // ⚠️ REGISTER in ecommoda-constants §7
                                                //    BEFORE first deploy — see README/handoff notes.
const API_VERSION     = '2026-01';
const SHOP_DOMAIN_FALLBACK = '6c7e1a-53.myshopify.com'; // used only if env.SHOP_DOMAIN missing, for error text

// Only orders that are still fully unpaid (COD not yet captured) may have an
// item removed by this tool — Ahmed's explicit decision (26-08-2026): online
// pre-paid orders are blocked entirely, no auto-refund path is implemented.
const ALLOWED_FINANCIAL_STATUS = new Set(['PENDING']);

// This tool ONLY ever removes stock, never restocks it (Ahmed, 28-08-2026):
// the warehouse uses it exclusively when the item is physically unavailable.
// Enforced server-side in handleRemoveItem — any client-sent value is ignored.

// S1 side effect on every removal — verbatim strings from ecommoda-order-lifecycle
// state-machines.md §1. 'Pending Edit' is the exact state meaning "an item was
// found unavailable during picking/packing" — matches this tool's purpose.
const S1_PENDING_EDIT = 'Pending Edit';
// Allowed SOURCE states for the Pending Edit transition (state-machines.md §1.4,
// directly-confirmed rows — not the "inferred, ask Ahmed" ones). Re-writing the
// same value (already Pending Edit) is treated as a no-op, not a transition.
const S1_VALID_SOURCES_FOR_PENDING_EDIT = new Set(['Confirmed', 'Ready', S1_PENDING_EDIT]);
const CANCEL_MANUAL_REASON_VALUE = 'عطلان';

// ══════════════════════════════════════════════════════════════════
// §CORS — Option B (write / destructive tool)
// ══════════════════════════════════════════════════════════════════
const ALLOWED_ORIGINS = [
  'https://ecommoda-dev.github.io',
  // TODO: أضف الـ GitHub Pages URL النهائي للأداة هنا لو مختلف
];

function getCORS(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

// ══════════════════════════════════════════════════════════════════
// §HELPERS
// ══════════════════════════════════════════════════════════════════
function json(body, status = 200, request = null) {
  const cors = request ? getCORS(request) : { 'Access-Control-Allow-Origin': ALLOWED_ORIGINS[0] };
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });
}
function badRequest(message, request) { return json({ ok: false, error: message }, 400, request); }

function normalizeOrderName(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const cleaned = raw.replace(/\s+/g, '');
  return cleaned.startsWith('#') ? cleaned : `#${cleaned}`;
}
function numericIdFromGid(gid) { return String(gid || '').split('/').pop() || null; }
function moneyText(set) {
  const amount = set?.shopMoney?.amount;
  const currency = set?.shopMoney?.currencyCode;
  if (amount == null || !currency) return '';
  return `${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

// ══════════════════════════════════════════════════════════════════
// §SHARED — copy verbatim — never modify (ecommoda-worker-builder references/shared-functions.md)
// ══════════════════════════════════════════════════════════════════
async function verifyEmployee(db, username, pin) {
  const row = await db.prepare(
    'SELECT display_name, is_active FROM employees WHERE username = ? AND pin = ?'
  ).bind(username, pin).first();
  if (!row) return null;
  if (!row.is_active) throw new Error('الحساب موقوف — تواصل مع المسؤول');
  db.prepare('UPDATE employees SET last_login = ? WHERE username = ?')
    .bind(new Date().toISOString(), username).run().catch(() => {});
  return row.display_name;
}

async function checkEmployee(db, username) {
  const row = await db.prepare(
    'SELECT is_active, pin FROM employees WHERE username = ?'
  ).bind(username).first();
  if (!row) return { exists: false, hasPin: false, isActive: false };
  return { exists: true, hasPin: !!row.pin, isActive: !!row.is_active };
}

async function registerPin(db, username, pin) {
  const row = await db.prepare(
    'SELECT pin, is_active FROM employees WHERE username = ?'
  ).bind(username).first();
  if (!row) throw new Error('اسم المستخدم غير موجود');
  if (!row.is_active) throw new Error('الحساب موقوف — تواصل مع المسؤول');
  if (row.pin) throw new Error('هذا المستخدم مسجّل بالفعل — تواصل مع المسؤول لإعادة الضبط');
  await db.prepare('UPDATE employees SET pin = ? WHERE username = ?').bind(pin, username).run();
  return true;
}

async function writeLog(db, entry) {
  await db.prepare(`
    INSERT INTO logs
      (timestamp, tool, type, employee, order_id, order_name,
       sku, product_title, delta, value_before, value_after, notes, extra)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    entry.timestamp ?? new Date().toISOString(),
    entry.tool, entry.type,
    entry.employee ?? null,
    entry.orderId ?? null,
    entry.orderName ?? null,
    entry.sku ?? null,
    entry.productTitle ?? null,
    entry.delta ?? null,
    entry.valueBefore ?? null,
    entry.valueAfter ?? null,
    entry.notes ?? null,
    entry.extra ? JSON.stringify(entry.extra) : null
  ).run();
}

async function getLogs(db, { tool = null, employee = null, type = null, search = null, limit = 100, offset = 0 } = {}) {
  let sql = "SELECT * FROM logs WHERE type NOT IN ('login','logout')";
  const b = [];
  if (tool)     { sql += ' AND tool = ?';     b.push(tool); }
  if (employee) { sql += ' AND employee = ?'; b.push(employee); }
  if (type)     { sql += ' AND type = ?';     b.push(type); }
  if (search)   { sql += ' AND (order_name LIKE ? OR notes LIKE ?)'; b.push(`%${search}%`, `%${search}%`); }
  sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  b.push(Math.min(limit, 100), offset);
  return (await db.prepare(sql).bind(...b).all()).results;
}
async function getLogsCount(db, { tool = null, employee = null, search = null } = {}) {
  let sql = "SELECT COUNT(*) as total FROM logs WHERE type NOT IN ('login','logout')";
  const b = [];
  if (tool)     { sql += ' AND tool = ?';     b.push(tool); }
  if (employee) { sql += ' AND employee = ?'; b.push(employee); }
  if (search)   { sql += ' AND (order_name LIKE ? OR notes LIKE ?)'; b.push(`%${search}%`, `%${search}%`); }
  const row = await db.prepare(sql).bind(...b).first();
  return row?.total ?? 0;
}
async function getLogsExport(db, { tool = null, employee = null, search = null } = {}) {
  let sql = "SELECT * FROM logs WHERE type NOT IN ('login','logout')";
  const b = [];
  if (tool)     { sql += ' AND tool = ?';     b.push(tool); }
  if (employee) { sql += ' AND employee = ?'; b.push(employee); }
  if (search)   { sql += ' AND (order_name LIKE ? OR notes LIKE ?)'; b.push(`%${search}%`, `%${search}%`); }
  sql += ' ORDER BY timestamp DESC LIMIT 2000';
  return (await db.prepare(sql).bind(...b).all()).results;
}
// ══════════════════════════════════════════════════════════════════
// END §SHARED
// ══════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════
// §SHOPIFY
// ══════════════════════════════════════════════════════════════════
async function getAccessToken(env) {
  const resp = await fetch(`https://${env.SHOP_DOMAIN}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.CLIENT_ID,
      client_secret: env.CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  });
  if (!resp.ok) throw new Error(`OAuth failed: ${resp.status}`);
  const data = await resp.json();
  if (!data.access_token) throw new Error('No access_token in OAuth response');
  return data.access_token;
}

// ⚠️ الإصدار الكامل من shopify-graphql-helper Step 1 — بترمي على HTTP status
// و data.errors و data الفاضية + إعادة محاولة على THROTTLED. أي "return resp.json()"
// المباشرة عطل، مش اختصار — راجع Step 5A① في ecommoda-worker-builder.
async function shopifyGQL(env, token, query, variables = {}, opName = 'shopify') {
  const MAX_ATTEMPTS = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let resp, text;
    try {
      resp = await fetch(`https://${env.SHOP_DOMAIN}/admin/api/${API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables }),
      });
      text = await resp.text();
    } catch (e) {
      lastErr = new Error(`${opName}: network failure — ${e.message}`);
      if (attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 400 * attempt)); continue; }
      throw lastErr;
    }
    if (!resp.ok) {
      const retriable = resp.status === 429 || resp.status >= 500;
      lastErr = new Error(`${opName}: Shopify HTTP ${resp.status} — ${text.slice(0, 180)}`);
      if (retriable && attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 700 * attempt)); continue; }
      throw lastErr;
    }
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`${opName}: non-JSON response — ${text.slice(0, 180)}`); }
    if (Array.isArray(data.errors) && data.errors.length) {
      const codes = data.errors.map(e => e?.extensions?.code).filter(Boolean);
      lastErr = new Error(`${opName}: ${data.errors.map(e => e.message).join(' | ')}` + (codes.length ? ` [${codes.join(',')}]` : ''));
      if (codes.includes('THROTTLED') && attempt < MAX_ATTEMPTS) { await new Promise(r => setTimeout(r, 1200 * attempt)); continue; }
      throw lastErr;
    }
    if (!data.data) throw new Error(`${opName}: response has no data — ${text.slice(0, 180)}`);
    return data;
  }
  throw lastErr || new Error(`${opName}: unknown failure`);
}

// ─── §SHOPIFY::orderQuery ───
const ORDER_FIELDS = `
  id
  name
  cancelledAt
  closed
  displayFinancialStatus
  displayFulfillmentStatus
  manualStatusMetafield: metafield(namespace: "custom", key: "manual_status") { value }
  customer { displayName phone }
  totalPriceSet { shopMoney { amount currencyCode } }
  lineItems(first: 50) {
    nodes {
      id
      title
      sku
      quantity
      currentQuantity
      unfulfilledQuantity
      merchantEditable
      requiresShipping
      originalUnitPriceSet { shopMoney { amount currencyCode } }
      image { url }
      variant { id title }
    }
  }
`;

function mapLineItem(li) {
  const fullyUnfulfilled = li.currentQuantity > 0 && li.currentQuantity === li.unfulfilledQuantity;
  let removable = true, reason = null;
  if (!(li.unfulfilledQuantity > 0)) { removable = false; reason = 'لا يوجد كمية Unfulfilled في هذا البند'; }
  else if (!li.merchantEditable)      { removable = false; reason = 'البند غير قابل للتعديل من شوبيفاي حاليًا'; }
  else if (!fullyUnfulfilled)         { removable = false; reason = 'جزء من الكمية اتشحن بالفعل — الحذف الكامل غير متاح'; }

  return {
    lineItemId: li.id,
    numericLineItemId: numericIdFromGid(li.id),
    title: li.title,
    sku: li.sku || '',
    quantity: li.quantity,
    currentQuantity: li.currentQuantity,
    unfulfilledQuantity: li.unfulfilledQuantity,
    unitPrice: moneyText(li.originalUnitPriceSet),
    variantTitle: li.variant?.title || '',
    imageUrl: li.image?.url || null,
    removable,
    reason,
  };
}

function mapOrder(order) {
  const financialOk = ALLOWED_FINANCIAL_STATUS.has(order.displayFinancialStatus);
  const orderEligible = !order.cancelledAt && !order.closed && financialOk;

  const allLineItems = (order.lineItems?.nodes || []).map(mapLineItem);
  const unfulfilledItems = allLineItems.filter(li => li.unfulfilledQuantity > 0);

  let orderBlockReason = null;
  if (order.cancelledAt)      orderBlockReason = 'الأوردر ملغي';
  else if (order.closed)      orderBlockReason = 'الأوردر مقفول (closed)';
  else if (!financialOk)      orderBlockReason = `الأداة تعمل فقط على أوردرات غير مدفوعة أونلاين (financial status الحالي: ${order.displayFinancialStatus || 'فارغ'})`;

  return {
    id: order.id,
    numericId: numericIdFromGid(order.id),
    name: order.name,
    displayFinancialStatus: order.displayFinancialStatus || '',
    displayFulfillmentStatus: order.displayFulfillmentStatus || '',
    manualStatus: order.manualStatusMetafield?.value || null,
    totalPrice: moneyText(order.totalPriceSet),
    customerName: order.customer?.displayName || '',
    customerPhone: order.customer?.phone || '',
    cancelledAt: order.cancelledAt,
    closed: !!order.closed,
    orderEligible,
    orderBlockReason,
    unfulfilledItems,
  };
}

async function findOrderByName(env, token, orderName) {
  const query = `query FindOrder($q: String!) { orders(first: 1, query: $q) { edges { node { ${ORDER_FIELDS} } } } }`;
  const data = await shopifyGQL(env, token, query, { q: `name:${orderName}` }, 'FindOrder');
  const node = data?.data?.orders?.edges?.[0]?.node;
  return node ? mapOrder(node) : null;
}

async function getOrderById(env, token, orderId) {
  const query = `query GetOrder($id: ID!) { order: node(id: $id) { ... on Order { ${ORDER_FIELDS} } } }`;
  const data = await shopifyGQL(env, token, query, { id: orderId }, 'GetOrder');
  const node = data?.data?.order;
  return node ? mapOrder(node) : null;
}

// ─── §SHOPIFY::removeLineItem ───
// Order Editing API flow — orderEditBegin → orderEditSetQuantity(0) → orderEditCommit.
// There is NO direct "remove line item" mutation (confirmed against the live
// 2026-01 schema + shopify.dev docs, 26-08-2026) — quantity:0 is the documented way.
// Requires scopes write_order_edits + read_order_edits (NOT write_orders).
async function removeLineItem(env, token, { orderGid, lineItemGid, restock, notifyCustomer, staffNote }) {
  const actions = [];

  // ① Begin edit session
  const beginData = await shopifyGQL(env, token,
    `mutation BeginEdit($id: ID!) {
       orderEditBegin(id: $id) { calculatedOrder { id } userErrors { field message } }
     }`,
    { id: orderGid }, 'orderEditBegin'
  );
  const beginErrs = beginData?.data?.orderEditBegin?.userErrors || [];
  if (beginErrs.length) throw new Error('orderEditBegin: ' + beginErrs.map(e => e.message).join(' | '));
  const calculatedOrderId = beginData?.data?.orderEditBegin?.calculatedOrder?.id;
  if (!calculatedOrderId) throw new Error('orderEditBegin: شوبيفاي ما رجعتش calculatedOrder — العملية لم تبدأ');
  actions.push('بدء جلسة تعديل الأوردر');

  // ② Find the matching CalculatedLineItem — matched by NUMERIC id (Shopify mints a
  // CalculatedLineItem with the same numeric id as the original LineItem for items
  // that already existed before the edit session — verified live on #47101, 26-08-2026),
  // then sanity-checked by SKU. Never assume the match — always confirm the payload.
  const calcData = await shopifyGQL(env, token,
    `query GetCalcLineItems($id: ID!) {
       node(id: $id) { ... on CalculatedOrder { id lineItems(first: 50) { nodes { id sku title quantity editableQuantity } } } }
     }`,
    { id: calculatedOrderId }, 'GetCalculatedLineItems'
  );
  const calcItems = calcData?.data?.node?.lineItems?.nodes || [];
  const targetNumericId = numericIdFromGid(lineItemGid);
  const match = calcItems.find(ci => numericIdFromGid(ci.id) === targetNumericId);
  if (!match) throw new Error('تعذّر تحديد بند الأوردر داخل جلسة التعديل — العملية أُلغيت قبل أي تغيير');
  actions.push(`تحديد البند: ${match.title}`);

  // ③ Set quantity to 0 — this IS the "remove line item" operation
  const setQtyData = await shopifyGQL(env, token,
    `mutation RemoveLineItem($id: ID!, $lineItemId: ID!, $quantity: Int!, $restock: Boolean) {
       orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity, restock: $restock) {
         calculatedLineItem { id quantity restocking }
         userErrors { field message }
       }
     }`,
    { id: calculatedOrderId, lineItemId: match.id, quantity: 0, restock: !!restock },
    'orderEditSetQuantity'
  );
  const setQtyErrs = setQtyData?.data?.orderEditSetQuantity?.userErrors || [];
  if (setQtyErrs.length) throw new Error('orderEditSetQuantity: ' + setQtyErrs.map(e => e.message).join(' | '));
  const calcLineItem = setQtyData?.data?.orderEditSetQuantity?.calculatedLineItem;
  if (!calcLineItem || calcLineItem.quantity !== 0) {
    throw new Error('orderEditSetQuantity: شوبيفاي ما أكدتش تصفير الكمية — العملية لم تُحفظ بعد (لسه محتاجة Commit)');
  }
  actions.push(`تصفير الكمية${restock ? ' + استرجاع للمخزون' : ' (بدون استرجاع مخزون)'}`);

  // ④ Commit — nothing changes on the live order before this call
  const commitData = await shopifyGQL(env, token,
    `mutation CommitEdit($id: ID!, $notifyCustomer: Boolean, $staffNote: String) {
       orderEditCommit(id: $id, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
         order { id name displayFulfillmentStatus displayFinancialStatus }
         userErrors { field message }
       }
     }`,
    { id: calculatedOrderId, notifyCustomer: !!notifyCustomer, staffNote: (staffNote || '').slice(0, 255) },
    'orderEditCommit'
  );
  const commitErrs = commitData?.data?.orderEditCommit?.userErrors || [];
  if (commitErrs.length) throw new Error('orderEditCommit: ' + commitErrs.map(e => e.message).join(' | '));
  const committedOrder = commitData?.data?.orderEditCommit?.order;
  if (!committedOrder?.id) throw new Error('orderEditCommit: شوبيفاي ما أكدتش حفظ التعديل على الأوردر');
  actions.push('تأكيد الحذف على الأوردر (Commit)');

  return { calculatedOrderId, removedTitle: match.title, removedSku: match.sku, committedOrder, actions };
}

// ─── §SHOPIFY::updateOrderStatusMetafields ───
// Side effect required on every removal (Ahmed, 28-08-2026):
//   custom.manual_status        → 'Pending Edit'  (only if the transition is legal)
//   custom.cancel_manual_reason → 'عطلان'          (always)
// Metafield `type` is read from the LIVE definition each call — never hardcoded
// — per shopify-graphql-helper: an exact-string type mismatch fails the whole
// metafieldsSet call, including fields bundled with it.
async function getMetafieldDefinitionTypes(env, token, keys) {
  const data = await shopifyGQL(env, token,
    `query MFDefs { metafieldDefinitions(first: 50, ownerType: ORDER, namespace: "custom") { nodes { key type { name } } } }`,
    {}, 'metafieldDefinitions'
  );
  const nodes = data?.data?.metafieldDefinitions?.nodes || [];
  const map = {};
  for (const n of nodes) map[n.key] = n.type?.name;
  const missing = keys.filter(k => !map[k]);
  if (missing.length) throw new Error(`تعريف الميتافيلد غير موجود في شوبيفاي: ${missing.join(', ')} — أنشئه من Settings → Custom data → Orders أولاً`);
  return map;
}

async function updateOrderStatusMetafields(env, token, { orderGid, previousS1 }) {
  const defTypes = await getMetafieldDefinitionTypes(env, token, ['manual_status', 'cancel_manual_reason']);
  const statusTransitionAllowed = previousS1 == null || S1_VALID_SOURCES_FOR_PENDING_EDIT.has(previousS1);

  const metafields = [
    { ownerId: orderGid, namespace: 'custom', key: 'cancel_manual_reason', type: defTypes.cancel_manual_reason, value: CANCEL_MANUAL_REASON_VALUE },
  ];
  if (statusTransitionAllowed) {
    metafields.push({ ownerId: orderGid, namespace: 'custom', key: 'manual_status', type: defTypes.manual_status, value: S1_PENDING_EDIT });
  }

  const data = await shopifyGQL(env, token,
    `mutation SetOrderStatusMetafields($metafields: [MetafieldsSetInput!]!) {
       metafieldsSet(metafields: $metafields) { metafields { key value } userErrors { field message } }
     }`,
    { metafields }, 'metafieldsSet(itemRemoved)'
  );
  const result = data?.data?.metafieldsSet;
  const errs = result?.userErrors || [];
  if (errs.length) throw new Error('metafieldsSet: ' + errs.map(e => e.message).join(' | '));

  const written = result?.metafields || [];
  const reasonOk = written.some(m => m.key === 'cancel_manual_reason' && m.value === CANCEL_MANUAL_REASON_VALUE);
  const statusOk = !statusTransitionAllowed || written.some(m => m.key === 'manual_status' && m.value === S1_PENDING_EDIT);
  if (!reasonOk || !statusOk) throw new Error('metafieldsSet: شوبيفاي ما أكدتش كتابة قيم الحالة/السبب');

  return { statusUpdated: statusTransitionAllowed, previousS1 };
}

// ══════════════════════════════════════════════════════════════════
// §HANDLER
// ══════════════════════════════════════════════════════════════════
async function handleLookupOrder(request, env) {
  const url = new URL(request.url);
  const orderName = normalizeOrderName(url.searchParams.get('order') || '');
  if (!orderName) return badRequest('اكتب رقم الأوردر أولاً', request);

  const token = await getAccessToken(env);
  const order = await findOrderByName(env, token, orderName);
  if (!order) return json({ ok: false, error: `لم يتم العثور على الأوردر ${orderName}` }, 404, request);

  return json({ ok: true, order }, 200, request);
}

async function handleRemoveItem(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return badRequest('Body غير صالح', request);

  const { orderId, lineItemId, employee, notifyCustomer = false, staffNote = '' } = body;
  // restock مفروضة false دايمًا من السيرفر — بغض النظر عن أي قيمة جاية من العميل
  // (دفاع مزدوج مع تعطيل الشيك بوكس في الواجهة). قرار أحمد 28-08-2026.
  const restock = false;
  if (!employee)   return badRequest('بيانات الموظف ناقصة — اعمل Login مرة أخرى', request);
  if (!orderId || !String(orderId).startsWith('gid://shopify/Order/'))       return badRequest('Order ID غير صالح', request);
  if (!lineItemId || !String(lineItemId).startsWith('gid://shopify/LineItem/')) return badRequest('Line Item ID غير صالح', request);

  const token = await getAccessToken(env);

  // Re-read the order immediately before acting — avoid race conditions
  // (order could have shipped, been paid, or been cancelled since lookup).
  const orderBefore = await getOrderById(env, token, orderId);
  if (!orderBefore) return json({ ok: false, error: 'الأوردر غير موجود' }, 404, request);
  if (!orderBefore.orderEligible) return badRequest(orderBefore.orderBlockReason || 'هذا الأوردر غير مؤهل للتعديل', request);

  const target = orderBefore.unfulfilledItems.find(li => li.lineItemId === lineItemId);
  if (!target) return badRequest('هذا البند لم يعد ضمن أوردر Unfulfilled — أعد تحميل الأوردر', request);
  if (!target.removable) return badRequest(target.reason || 'هذا البند غير قابل للحذف', request);

  const note = `Removed via EcomModa Order Item Remover by ${employee}` + (staffNote ? ` — ${staffNote}` : '');

  let result;
  try {
    result = await removeLineItem(env, token, {
      orderGid: orderId, lineItemGid: lineItemId,
      restock, notifyCustomer, staffNote: note,
    });

    // ─── ميتافيلدات الحالة/السبب — side effect إلزامي على كل حذف (أحمد 28-08-2026) ───
    // فشل الخطوة دي لا يُسقط نجاح حذف البند نفسه — العملية بالفعل اتنفذت على
    // شوبيفاي ولا رجعة فيها؛ النتيجة تبقى 'warning' مش 'error' (3 حالات مش اتنين).
    let metaOutcome = { statusUpdated: false, error: null };
    try {
      metaOutcome = await updateOrderStatusMetafields(env, token, { orderGid: orderId, previousS1: orderBefore.manualStatus });
      result.actions.push(metaOutcome.statusUpdated
        ? `تحديث الحالة إلى "${S1_PENDING_EDIT}" + سبب الإلغاء اليدوي إلى "${CANCEL_MANUAL_REASON_VALUE}"`
        : `تحديث سبب الإلغاء اليدوي إلى "${CANCEL_MANUAL_REASON_VALUE}" فقط — تخطي تحديث الحالة (الانتقال من "${orderBefore.manualStatus || '—'}" إلى "${S1_PENDING_EDIT}" غير مسموح)`);
    } catch (metaErr) {
      metaOutcome.error = metaErr.message;
      result.actions.push(`⚠️ تعذّر تحديث ميتافيلدات الحالة/السبب: ${metaErr.message}`);
    }
    const status = (metaOutcome.error || !metaOutcome.statusUpdated) ? 'warning' : 'success';

    let message = `تم حذف "${target.title}" من الأوردر ${orderBefore.name}`;
    if (status === 'warning') {
      message += metaOutcome.error
        ? ` — ⚠️ تعذّر تحديث الحالة/السبب: ${metaOutcome.error}`
        : ` — ⚠️ لم يتم تحديث الحالة (الانتقال من "${orderBefore.manualStatus || '—'}" غير مسموح) — تم تحديث سبب الإلغاء فقط`;
    } else {
      message += ` — تم تحديث الحالة إلى "${S1_PENDING_EDIT}" وسبب الإلغاء إلى "${CANCEL_MANUAL_REASON_VALUE}"`;
    }

    let logged = true;
    try {
      await writeLog(env.DB, {
        tool: TOOL_NAME, type: 'remove_item', employee,
        orderId: orderBefore.numericId, orderName: orderBefore.name,
        sku: target.sku, productTitle: target.title,
        delta: -target.unfulfilledQuantity,
        notes: `تم حذف "${target.title}" من الأوردر — بدون استرجاع مخزون (معطّل دائمًا)`,
        extra: {
          orderGid: orderId, lineItemGid: lineItemId,
          restock: false, notifyCustomer: !!notifyCustomer,
          actions: result.actions, calculatedOrderId: result.calculatedOrderId,
          result: status, statusUpdated: metaOutcome.statusUpdated, statusUpdateError: metaOutcome.error,
        },
      });
    } catch (e) { logged = false; }

    if (metaOutcome.statusUpdated) {
      try {
        await writeLog(env.DB, {
          tool: 'metafields_change', type: 'update', employee,
          orderId: orderBefore.numericId, orderName: orderBefore.name,
          notes: `S1: ${orderBefore.manualStatus || '—'} → ${S1_PENDING_EDIT} (حذف منتج "${target.title}" عبر Order Item Remover)`,
          extra: {
            field: 'custom.manual_status', previousValue: orderBefore.manualStatus || null,
            newValue: S1_PENDING_EDIT, sourceTool: TOOL_NAME,
          },
        });
      } catch (e) { /* الحذف نفسه اتسجل فعلاً — فشل السجل الثانوي ده مش حرج */ }
    }

    return json({
      ok: true, status, logged,
      message,
      order: result.committedOrder, removedItem: target, actions: result.actions,
    }, 200, request);

  } catch (err) {
    await writeLog(env.DB, {
      tool: TOOL_NAME, type: 'remove_failed', employee,
      orderId: orderBefore.numericId, orderName: orderBefore.name,
      sku: target.sku, productTitle: target.title,
      notes: `فشل حذف "${target.title}" — ${err.message}`,
      extra: { orderGid: orderId, lineItemGid: lineItemId, restock: !!restock, error: err.message },
    }).catch(() => {});

    return json({ ok: false, status: 'error', error: err.message }, 500, request);
  }
}

async function handleDiag(request, env) {
  const checks = {};
  checks.envKeys = Object.fromEntries(
    ['SHOP_DOMAIN', 'CLIENT_ID', 'CLIENT_SECRET', 'WORKER_SECRET'].map(k => [k, env[k] ? `set (${String(env[k]).length} chars)` : 'MISSING'])
  );
  try {
    const token = await getAccessToken(env);
    checks.oauth = 'ok';
    try {
      const data = await shopifyGQL(env, token, `{ currentAppInstallation { accessScopes { handle } } }`, {}, 'diag-scopes');
      const scopes = (data?.data?.currentAppInstallation?.accessScopes || []).map(s => s.handle);
      checks.accessScopes = scopes;
      checks.hasWriteOrderEdits = scopes.includes('write_order_edits');
      checks.hasReadOrderEdits  = scopes.includes('read_order_edits');
      if (!checks.hasWriteOrderEdits || !checks.hasReadOrderEdits) {
        checks.scopeWarning = 'ناقص write_order_edits و/أو read_order_edits — الأداة هتفشل في remove_item حتى لو كل حاجة تانية تمام. أضف الصلاحية من Shopify Partner Dashboard وأعد تثبيت التطبيق.';
      }
    } catch (e) { checks.accessScopesError = e.message; }

    try {
      const defTypes = await getMetafieldDefinitionTypes(env, token, ['manual_status', 'cancel_manual_reason']);
      checks.metafieldDefs = defTypes;
    } catch (e) { checks.metafieldDefsError = e.message; }
  } catch (e) { checks.oauth = `FAILED: ${e.message}`; }

  try { await env.DB.prepare('SELECT 1').first(); checks.d1 = 'ok'; }
  catch (e) { checks.d1 = `FAILED: ${e.message}`; }

  checks.origin = request.headers.get('Origin') || '(none)';
  checks.originAllowed = ALLOWED_ORIGINS.includes(checks.origin);

  return json({ ok: true, version: WORKER_VERSION, checks }, 200, request);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: getCORS(request) });

    // ── R6: حارس WORKER_SECRET الغايب — **قبل** أي مقارنة ─────────
    // من غير السطور دي: لو السيكرت اتنسي أو النسخة اتنشرت بدون Promote،
    // يبقى env.WORKER_SECRET === undefined، والقالب بيتقيّم للنص الحرفي
    // "Bearer undefined" — فأي طلب بالرأس ده **بيعدّي المصادقة**.
    // (مراجعة 03-09-2026 · R6 · نفس حارس logistics-control-center-worker)
    if (!env.WORKER_SECRET) {
      return json({
        error: 'WORKER_SECRET غير مضبوط على الـ Worker — أضفه من Settings → Variables ثم اعمل Promote',
        step:  'env',
      }, 500, request);
    }

    const auth = request.headers.get('Authorization');
    if (!auth || auth !== `Bearer ${env.WORKER_SECRET}`) return json({ ok: false, error: 'Unauthorized' }, 401, request);

    const url = new URL(request.url);
    const action = url.searchParams.get('action') || '';

    try {
      // ─── §AUTH ────────────────────────────────────────────
      if (action === 'check_employee') {
        const username = url.searchParams.get('username');
        if (!username) return badRequest('username مطلوب', request);
        return json({ ok: true, ...(await checkEmployee(env.DB, username)) }, 200, request);
      }
      if (action === 'register_pin') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { username, pin } = await request.json().catch(() => ({}));
        if (!username || !pin) return badRequest('username و pin مطلوبان', request);
        await registerPin(env.DB, username, pin);
        return json({ ok: true }, 200, request);
      }
      if (action === 'verify_employee') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        const { username, pin } = await request.json().catch(() => ({}));
        if (!username || !pin) return badRequest('username و pin مطلوبان', request);
        const displayName = await verifyEmployee(env.DB, username, pin);
        if (!displayName) return json({ ok: false, error: 'PIN خطأ أو المستخدم غير موجود' }, 401, request);
        let logged = true;
        try { await writeLog(env.DB, { tool: TOOL_NAME, type: 'login', employee: username, notes: `دخول: ${displayName}` }); }
        catch (e) { logged = false; }
        return json({ ok: true, displayName, logged }, 200, request);
      }
      if (action === 'log_logout') {
        const username = url.searchParams.get('username');
        let logged = true;
        if (username) {
          try { await writeLog(env.DB, { tool: TOOL_NAME, type: 'logout', employee: username, notes: `خروج: ${username.replace(/_/g, ' ')}` }); }
          catch (e) { logged = false; }
        }
        return json({ ok: true, logged }, 200, request);
      }
      if (action === 'get_employees') {
        const { results } = await env.DB.prepare(
          'SELECT username, display_name FROM employees WHERE is_active = 1 ORDER BY display_name'
        ).all();
        return json({ ok: true, employees: results }, 200, request);
      }
      // ──────────────────────────────────────────────────────

      // ─── §TOOL ────────────────────────────────────────────
      if (action === 'lookup_order') return await handleLookupOrder(request, env);
      if (action === 'remove_item') {
        if (request.method !== 'POST') return json({ error: 'POST required' }, 405, request);
        return await handleRemoveItem(request, env);
      }
      // ──────────────────────────────────────────────────────

      // ─── §LOG-ENDPOINTS ───────────────────────────────────
      if (action === 'get_logs') {
        const entries = await getLogs(env.DB, {
          tool: TOOL_NAME,
          employee: url.searchParams.get('employee') || null,
          search:   url.searchParams.get('search')   || null,
          limit:    parseInt(url.searchParams.get('limit')  || '100'),
          offset:   parseInt(url.searchParams.get('offset') || '0'),
        });
        return json({ ok: true, entries }, 200, request);
      }
      if (action === 'get_logs_count') {
        const total = await getLogsCount(env.DB, {
          tool: TOOL_NAME,
          employee: url.searchParams.get('employee') || null,
          search:   url.searchParams.get('search')   || null,
        });
        return json({ ok: true, total }, 200, request);
      }
      if (action === 'get_logs_export') {
        const entries = await getLogsExport(env.DB, {
          tool: TOOL_NAME,
          employee: url.searchParams.get('employee') || null,
          search:   url.searchParams.get('search')   || null,
        });
        return json({ ok: true, entries }, 200, request);
      }
      // ──────────────────────────────────────────────────────

      // ─── §DIAG (mandatory) ────────────────────────────────
      if (action === 'diag')       return await handleDiag(request, env);
      if (action === 'get_config') return json({ ok: true, version: WORKER_VERSION }, 200, request);
      // ──────────────────────────────────────────────────────

      return json({ ok: false, error: 'Not found' }, 404, request);
    } catch (err) {
      return json({ ok: false, error: err.message }, 500, request);
    }
  },
};
