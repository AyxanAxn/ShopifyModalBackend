// =============================================================================
// FitDiz COD backend — bütün testlər bir faylda.
//
//   npm test            (və ya: node test/all.test.mjs)
//
// Xarici asılılıq yoxdur. Shopify Admin API və Meta Graph API mock-lanır
// (globalThis.fetch), qalan hər şey real koddur: App Proxy imzası, validasiya,
// blocklist, çatdırılma, draft order axını, fallback endirim, Meta CAPI.
//
// Bölmələr:
//   A. lib/meta.js — unit testlər (normalizeShop, hash, user_data, event id, CAPI)
//   B. api/create.js — təhlükəsizlik (imza, timestamp, shop, allowlist)
//   C. api/create.js — validasiya
//   D. api/create.js — blocklist
//   E. api/create.js — çatdırılma qaydaları
//   F. api/create.js — sifariş axını (draft → complete), bundle properties
//   G. api/create.js — fallback endirim və tavan
//   H. api/create.js — Meta Purchase CAPI
//   I. api/create.js — xəta halları
//   J. api/meta-event.js
//   K. api/health.js
// =============================================================================
import crypto from "node:crypto";
import assert from "node:assert/strict";

// ---------- sabitlər ----------
const SECRET = "test_secret";
const SHOP_A = "store-a.myshopify.com";       // Meta konfiqi VAR
const SHOP_B = "store-b.myshopify.com";       // Meta konfiqi YOX
const SHOP_BILEK = "skcwhv-hv.myshopify.com"; // kodda çatdırılma qaydası var (4 ₼)
const BILEK_PRODUCT = "10261167374476";

process.env.SHOPIFY_CLIENT_ID = "cid";
process.env.SHOPIFY_CLIENT_SECRET = SECRET;
process.env.META_GRAPH_API_VERSION = "v25.0";
process.env.META_STORES_JSON = JSON.stringify({
  [SHOP_A]: { pixel_id: "111", access_token: "tokA", test_event_code: "TEST1" }
});
process.env.BLOCKLIST_JSON = JSON.stringify({
  phones: ["050 999 99 99", "+994 55 111 22 33"],
  message: "Bloklandınız."
});
delete process.env.SHOPIFY_ALLOWED_SHOPS;
delete process.env.SHIPPING_RULES_JSON;

const meta = await import("../lib/meta.js");
const create = await import("../api/create.js");
const metaEvent = await import("../api/meta-event.js");
const health = await import("../api/health.js");

// ---------- test runner ----------
const results = [];
let section = "";
function describe(name) { section = name; }
async function t(name, fn) {
  calls = []; scenario = {};
  try { await fn(); results.push(["PASS", section, name]); }
  catch (e) { results.push(["FAIL", section, name, (e.message || String(e)).split("\n")[0]]); }
}

// ---------- köməkçilər ----------
function signedUrl(path, shop, { ts = Math.floor(Date.now() / 1000), badSig = false, extra = {} } = {}) {
  const params = { shop, timestamp: String(ts), path_prefix: "/apps/cod-order", ...extra };
  const message = Object.entries(params).map(([k, v]) => `${k}=${v}`).sort().join("");
  let sig = crypto.createHmac("sha256", SECRET).update(message).digest("hex");
  if (badSig) sig = sig.replace(/^./, c => (c === "a" ? "b" : "a"));
  const qs = new URLSearchParams({ ...params, signature: sig });
  return `https://backend.test${path}?${qs}`;
}
function req(url, body, headers = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}
const goodCustomer = { first_name: "Aynur", last_name: "Hüseynova", phone: "050 123 45 67", address: "Nizami küç. 12", region: "Nəsimi", city: "Bakı", apartment: "giriş 2" };
const goodItems = [{ variant_id: 111, product_id: 222, quantity: 1 }];
function goodBody(extra = {}) {
  return {
    customer: goodCustomer,
    items: goodItems,
    delivery: { expected_shipping_cents: 0 },
    pricing: { expected_total_cents: 4999 },
    meta: { marketing_allowed: true, fbp: "fb.1.1.1", fbc: "", user_agent: "UA", event_source_url: "https://x.test/p" },
    ...extra
  };
}
const post = async (shop, body, opts = {}, headers = {}) => {
  const res = await create.POST(req(signedUrl("/api/create", shop, opts), body, headers));
  return { status: res.status, data: await res.json() };
};
const postEvent = async (shop, body, opts = {}) => {
  const res = await metaEvent.POST(req(signedUrl("/api/meta-event", shop, opts), body));
  return { status: res.status, data: await res.json() };
};
const gql = () => calls.filter(c => c.url.includes("/admin/api/")).map(c => JSON.parse(c.body));
const gqlNames = () => gql().map(c => c.query.match(/mutation (\w+)/)[1]);
const metaCalls = () => calls.filter(c => c.url.includes("graph.facebook.com")).map(c => ({ url: c.url, auth: c.auth, body: JSON.parse(c.body) }));

// ---------- mock fetch (Shopify + Meta) ----------
let calls = [];
let scenario = {};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body ? (typeof init.body === "string" ? init.body : String(init.body)) : "";
  calls.push({ url: u, body, auth: init.headers?.Authorization || init.headers?.authorization || "" });

  if (u.includes("/admin/oauth/access_token")) {
    if (scenario.tokenFail) return Response.json({ error: "invalid_client", error_description: "Client credentials invalid" }, { status: 401 });
    return Response.json({ access_token: "shpat_test" });
  }
  if (u.includes("/admin/api/")) {
    if (scenario.shopifyHttp) return new Response("down", { status: scenario.shopifyHttp });
    const { query, variables } = JSON.parse(body);
    if (query.includes("CreateCodDraftOrder")) {
      if (scenario.rejectPhone && "phone" in variables.input) {
        return Response.json({ data: { draftOrderCreate: { draftOrder: null, userErrors: [{ field: ["input", "phone"], message: "Phone is invalid" }] } } });
      }
      if (scenario.createError) {
        return Response.json({ data: { draftOrderCreate: { draftOrder: null, userErrors: [{ field: null, message: scenario.createError }] } } });
      }
      const total = scenario.draftTotal ?? 49.99;
      const subtotal = scenario.draftSubtotal ?? total;
      return Response.json({ data: { draftOrderCreate: { draftOrder: {
        id: "gid://shopify/DraftOrder/1", name: "#D1",
        totalPriceSet: { shopMoney: { amount: String(total), currencyCode: "AZN" } },
        subtotalPriceSet: { shopMoney: { amount: String(subtotal), currencyCode: "AZN" } },
        totalDiscountsSet: { shopMoney: { amount: "0", currencyCode: "AZN" } }
      }, userErrors: [] } } });
    }
    if (query.includes("ApplyCodFallbackDiscount")) {
      if (scenario.fallbackFail) {
        return Response.json({ data: { draftOrderUpdate: { draftOrder: null, userErrors: [{ field: null, message: "Discount too large" }] } } });
      }
      const disc = variables.input.appliedDiscount.value;
      const total = (scenario.draftTotal ?? 49.99) - disc;
      return Response.json({ data: { draftOrderUpdate: { draftOrder: {
        id: "gid://shopify/DraftOrder/1", name: "#D1",
        totalPriceSet: { shopMoney: { amount: total.toFixed(2), currencyCode: "AZN" } },
        subtotalPriceSet: { shopMoney: { amount: String(scenario.draftSubtotal ?? scenario.draftTotal), currencyCode: "AZN" } },
        totalDiscountsSet: { shopMoney: { amount: disc.toFixed(2), currencyCode: "AZN" } }
      }, userErrors: [] } } });
    }
    if (query.includes("CompleteCodDraftOrder")) {
      if (scenario.completeError) {
        return Response.json({ data: { draftOrderComplete: { draftOrder: null, userErrors: [{ field: null, message: scenario.completeError }] } } });
      }
      return Response.json({ data: { draftOrderComplete: { draftOrder: { id: "gid://shopify/DraftOrder/1" }, userErrors: [] } } });
    }
  }
  if (u.includes("graph.facebook.com")) {
    if (scenario.metaFail) return Response.json({ error: { message: "Invalid OAuth access token" } }, { status: 400 });
    return Response.json({ events_received: 1, fbtrace_id: "tr1" });
  }
  throw new Error("unmocked fetch: " + u);
};

// =============================================================================
describe("A. lib/meta.js");
// =============================================================================
await t("normalizeShop: domain, URL, böyük hərf, boş", () => {
  assert.equal(meta.normalizeShop("store-a"), "store-a.myshopify.com");
  assert.equal(meta.normalizeShop("https://Store-A.myshopify.com/"), "store-a.myshopify.com");
  assert.equal(meta.normalizeShop(""), "");
  assert.equal(meta.normalizeShop(null), "");
});
await t("getMetaStoreConfig: konfiqli mağaza → pixel/token/test code; olmayan → null", () => {
  const c = meta.getMetaStoreConfig(SHOP_A);
  assert.equal(c.pixelId, "111"); assert.equal(c.accessToken, "tokA"); assert.equal(c.testEventCode, "TEST1"); assert.equal(c.contentIdMode, "variant");
  assert.equal(meta.getMetaStoreConfig(SHOP_B), null);
  assert.equal(meta.getMetaStoreConfig(""), null);
});
await t("getMetaStoreConfig: env yoxdur / pozuqdur / token boşdur → null", () => {
  const saved = process.env.META_STORES_JSON;
  delete process.env.META_STORES_JSON; assert.equal(meta.getMetaStoreConfig(SHOP_A), null);
  process.env.META_STORES_JSON = "{bad"; assert.equal(meta.getMetaStoreConfig(SHOP_A), null);
  process.env.META_STORES_JSON = JSON.stringify({ [SHOP_A]: { pixel_id: "1" } }); assert.equal(meta.getMetaStoreConfig(SHOP_A), null);
  process.env.META_STORES_JSON = saved;
});
await t("buildContentId: variant (default) / product rejimi", () => {
  const item = { variant_id: 11, product_id: 22 };
  assert.equal(meta.buildContentId(item), "11");
  assert.equal(meta.buildContentId(item, { contentIdMode: "product" }), "22");
  assert.equal(meta.buildContentId({ id: 5 }), "5");
  assert.equal(meta.buildContentId({}), "");
});
await t("buildPurchaseUserData: hər sahə SHA-256, telefon yalnız rəqəm, country=az, fbp/fbc yalnız 'fb.' ilə", () => {
  const ud = meta.buildPurchaseUserData({ shop: SHOP_A, customer: { phone: "+994 50 123-45-67", first_name: " Aynur ", last_name: "HÜSEYNOVA", city: "Bakı", region: "Nəsimi" }, meta: { fbp: "fb.1.2.3", fbc: "bad", user_agent: "UA" } });
  const sha = v => crypto.createHash("sha256").update(v).digest("hex");
  assert.deepEqual(ud.ph, [sha("994501234567")]);
  assert.deepEqual(ud.fn, [sha("aynur")]);
  assert.deepEqual(ud.ln, [sha("hüseynova")]);
  assert.deepEqual(ud.country, [sha("az")]);
  assert.deepEqual(ud.external_id, [sha(`${SHOP_A}|994501234567`)]);
  assert.equal(ud.fbp, "fb.1.2.3"); assert.equal("fbc" in ud, false); assert.equal(ud.client_user_agent, "UA");
});
await t("buildAnonymousUserData: telefon/ad yoxdur, yalnız fbp/fbc/UA", () => {
  const ud = meta.buildAnonymousUserData({ fbp: "fb.1", fbc: "fb.2", user_agent: "UA" });
  assert.deepEqual(Object.keys(ud).sort(), ["client_user_agent", "fbc", "fbp"]);
});
await t("sanitizeEventSourceUrl: düzgün URL saxlanır, pozuq/javascript: → mağaza URL-i", () => {
  assert.equal(meta.sanitizeEventSourceUrl("https://x.test/p?a=1", SHOP_A), "https://x.test/p?a=1");
  assert.equal(meta.sanitizeEventSourceUrl("javascript:alert(1)", SHOP_A), `https://${SHOP_A}`);
  assert.equal(meta.sanitizeEventSourceUrl("not a url", SHOP_A), `https://${SHOP_A}`);
  assert.equal(meta.sanitizeEventSourceUrl("", SHOP_A), `https://${SHOP_A}`);
});
await t("makeEventId: prefix_24hex, unikal, prefix təmizlənir", () => {
  const a = meta.makeEventId("purchase", SHOP_A, "seed");
  const b = meta.makeEventId("purchase", SHOP_A, "seed");
  assert.match(a, /^purchase_[0-9a-f]{24}$/); assert.notEqual(a, b);
  assert.match(meta.makeEventId("add to cart!", SHOP_A), /^addtocart_/);
  assert.match(meta.makeEventId("", SHOP_A), /^event_/);
});
await t("sendMetaEvent: düzgün URL/versiya, Bearer token, payload, test_event_code", async () => {
  const r = await meta.sendMetaEvent({ shop: SHOP_A, eventName: "Purchase", eventId: "e1", eventSourceUrl: "https://x.test", userData: { ph: ["h"] }, customData: { value: 1, currency: "AZN" } });
  assert.equal(r.ok, true); assert.equal(r.eventsReceived, 1);
  const m = metaCalls()[0];
  assert.equal(m.url, "https://graph.facebook.com/v25.0/111/events");
  assert.equal(m.auth, "Bearer tokA");
  assert.equal(m.body.test_event_code, "TEST1");
  const ev = m.body.data[0];
  assert.equal(ev.event_name, "Purchase"); assert.equal(ev.event_id, "e1"); assert.equal(ev.action_source, "website");
  assert.ok(Math.abs(ev.event_time - Date.now() / 1000) < 5);
});
await t("sendMetaEvent: konfiq yoxdursa skipped, fetch çağırılmır", async () => {
  const r = await meta.sendMetaEvent({ shop: SHOP_B, eventName: "Purchase", eventId: "e1" });
  assert.deepEqual(r, { ok: false, skipped: true, reason: "meta_not_configured" }); assert.equal(calls.length, 0);
});
await t("sendMetaEvent: Meta xəta cavabı → throw (mesajla)", async () => {
  scenario.metaFail = true;
  await assert.rejects(() => meta.sendMetaEvent({ shop: SHOP_A, eventName: "Purchase", eventId: "e1" }), /Invalid OAuth/);
});

// =============================================================================
describe("B. create.js — təhlükəsizlik");
// =============================================================================
await t("imza səhv → 401, heç bir xarici çağırış yoxdur", async () => {
  const r = await post(SHOP_A, goodBody(), { badSig: true });
  assert.equal(r.status, 401); assert.equal(calls.length, 0);
});
await t("imza yoxdur → 401", async () => {
  const res = await create.POST(req(`https://b.test/api/create?shop=${SHOP_A}&timestamp=${Math.floor(Date.now() / 1000)}`, goodBody()));
  assert.equal(res.status, 401);
});
await t("imza təkrar dəyərli parametrlə (a=1&a=2) düzgün hesablanır", async () => {
  // Shopify eyni açarı vergüllə birləşdirir: a=1,2
  const ts = String(Math.floor(Date.now() / 1000));
  const message = [`a=1,2`, `path_prefix=/apps/cod-order`, `shop=${SHOP_A}`, `timestamp=${ts}`].sort().join("");
  const sig = crypto.createHmac("sha256", SECRET).update(message).digest("hex");
  const res = await create.POST(req(`https://b.test/api/create?a=1&a=2&shop=${SHOP_A}&timestamp=${ts}&path_prefix=/apps/cod-order&signature=${sig}`, goodBody()));
  assert.equal(res.status, 200);
});
await t("timestamp 10 dəq köhnə → 401; 4 dəq → keçir", async () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await post(SHOP_A, goodBody(), { ts: now - 600 })).status, 401);
  assert.equal((await post(SHOP_A, goodBody(), { ts: now - 240 })).status, 200);
});
await t("timestamp rəqəm deyil → 401", async () => {
  assert.equal((await post(SHOP_A, goodBody(), { ts: "abc" })).status, 401);
});
await t("etibarsız shop → 400", async () => {
  assert.equal((await post("bad shop!", goodBody())).status, 400);
  assert.equal((await post("evil.com", goodBody())).status, 400);
});
await t("SHOPIFY_ALLOWED_SHOPS: siyahıda olmayan → 403, olan → keçir", async () => {
  process.env.SHOPIFY_ALLOWED_SHOPS = `${SHOP_B}, store-a`;
  assert.equal((await post(SHOP_BILEK, goodBody())).status, 403);
  assert.equal((await post(SHOP_A, goodBody())).status, 200);
  delete process.env.SHOPIFY_ALLOWED_SHOPS;
});
await t("SHOPIFY_CLIENT_SECRET yoxdursa → 500", async () => {
  const s = process.env.SHOPIFY_CLIENT_SECRET; delete process.env.SHOPIFY_CLIENT_SECRET;
  const r = await post(SHOP_A, goodBody());
  process.env.SHOPIFY_CLIENT_SECRET = s;
  assert.equal(r.status, 500);
});

// =============================================================================
describe("C. create.js — validasiya");
// =============================================================================
await t("pozuq JSON → 400", async () => { assert.equal((await post(SHOP_A, "{not json")).status, 400); });
await t("məcburi sahələr boş → 400, boş sahələrin adı göstərilir", async () => {
  const r = await post(SHOP_A, goodBody({ customer: { ...goodCustomer, address: "", city: " " } }));
  assert.equal(r.status, 400); assert.match(r.data.error, /address/); assert.match(r.data.error, /city/);
});
await t("qeyd (apartment) boş ola bilər", async () => {
  const r = await post(SHOP_A, goodBody({ customer: { ...goodCustomer, apartment: "" } }));
  assert.equal(r.status, 200); assert.equal("address2" in gql()[0].variables.input.shippingAddress, false);
});
await t("telefon normalizasiyası: 050…, 50…, +994…, 994… → +994501234567", async () => {
  for (const p of ["0501234567", "501234567", "+994 50 123 45 67", "994501234567", "050-123-45-67"]) {
    calls = [];
    const r = await post(SHOP_A, goodBody({ customer: { ...goodCustomer, phone: p } }));
    assert.equal(r.status, 200, p);
    assert.equal(gql()[0].variables.input.phone, "+994501234567", p);
  }
});
await t("xarici nömrə '+' ilə olduğu kimi saxlanır", async () => {
  const r = await post(SHOP_A, goodBody({ customer: { ...goodCustomer, phone: "+90 532 111 22 33" } }));
  assert.equal(r.status, 200); assert.equal(gql()[0].variables.input.phone, "+905321112233");
});
await t("qısa / uzun telefon → 400", async () => {
  assert.equal((await post(SHOP_A, goodBody({ customer: { ...goodCustomer, phone: "12345" } }))).status, 400);
  assert.equal((await post(SHOP_A, goodBody({ customer: { ...goodCustomer, phone: "+1234567890123456" } }))).status, 400);
});
await t("boş səbət → 400", async () => { assert.equal((await post(SHOP_A, goodBody({ items: [] }))).status, 400); });
await t("items massiv deyil → 400", async () => { assert.equal((await post(SHOP_A, goodBody({ items: "x" }))).status, 400); });
await t("quantity 0 / 51 / 1.5 / 'abc' → 400; '2' (string rəqəm) qəbul olunur", async () => {
  for (const q of [0, 51, 1.5, "abc", null]) {
    assert.equal((await post(SHOP_A, goodBody({ items: [{ variant_id: 1, product_id: 2, quantity: q }] }))).status, 400, String(q));
  }
  calls = [];
  const r = await post(SHOP_A, goodBody({ items: [{ variant_id: 1, product_id: 2, quantity: "2" }] }));
  assert.equal(r.status, 200); assert.equal(gql()[0].variables.input.lineItems[0].quantity, 2);
});
await t("variant_id yoxdur → 400; 'gid://…' formatı rəqəmə çevrilir", async () => {
  assert.equal((await post(SHOP_A, goodBody({ items: [{ product_id: 2, quantity: 1 }] }))).status, 400);
  const r = await post(SHOP_A, goodBody({ items: [{ variant_id: "gid://shopify/ProductVariant/777", product_id: 2, quantity: 1 }] }));
  assert.equal(r.status, 200); assert.equal(gql()[0].variables.input.lineItems[0].variantId, "gid://shopify/ProductVariant/777");
});
await t("100-dən çox sətir → 400", async () => {
  const items = Array.from({ length: 101 }, (_, i) => ({ variant_id: i + 1, product_id: 1, quantity: 1 }));
  assert.equal((await post(SHOP_A, goodBody({ items }))).status, 400);
});
await t("uzun sahələr kəsilir (ad 80, ünvan 250)", async () => {
  const r = await post(SHOP_A, goodBody({ customer: { ...goodCustomer, first_name: "A".repeat(200), address: "B".repeat(400) } }));
  assert.equal(r.status, 200);
  const a = gql()[0].variables.input.shippingAddress;
  assert.equal(a.firstName.length, 80); assert.equal(a.address1.length, 250);
});
await t("endirim kodları: yalnız [A-Za-z0-9_-], max 5", async () => {
  const r = await post(SHOP_A, goodBody({ discounts: { codes: ["SAVE10", "bad code!", "<script>", "A", "B", "C", "D", "E"] } }));
  assert.deepEqual(gql()[0].variables.input.discountCodes, ["SAVE10", "A", "B", "C", "D"]);
});
await t("endirim kodu yoxdursa discountCodes sahəsi göndərilmir", async () => {
  await post(SHOP_A, goodBody());
  assert.equal("discountCodes" in gql()[0].variables.input, false);
});

// =============================================================================
describe("D. create.js — blocklist (yalnız nömrə)");
// =============================================================================
await t("bloklanmış nömrə — hər formatda tutulur → 403 BLOCKED, mesaj, Shopify/Meta çağırılmır", async () => {
  for (const p of ["+994509999999", "0509999999", "050 999 99 99", "509999999", "994509999999", "050-999-99-99"]) {
    calls = [];
    const r = await post(SHOP_A, goodBody({ customer: { ...goodCustomer, phone: p } }));
    assert.equal(r.status, 403, p); assert.equal(r.data.code, "BLOCKED"); assert.equal(r.data.error, "Bloklandınız.");
    assert.equal(calls.length, 0, "heç bir xarici çağırış olmamalıdır");
  }
});
await t("siyahıdakı ikinci nömrə də bloklanır; oxşar nömrə keçir", async () => {
  assert.equal((await post(SHOP_A, goodBody({ customer: { ...goodCustomer, phone: "055 111 22 33" } }))).status, 403);
  assert.equal((await post(SHOP_A, goodBody({ customer: { ...goodCustomer, phone: "055 111 22 34" } }))).status, 200);
});
await t("bloklanmış nömrə bütün mağazalarda bloklanır (ortaq siyahı)", async () => {
  for (const shop of [SHOP_A, SHOP_B, SHOP_BILEK]) {
    assert.equal((await post(shop, goodBody({ customer: { ...goodCustomer, phone: "0509999999" } }))).status, 403, shop);
  }
});
await t("ad / qeyd / ünvan bloklamaya təsir etmir — yalnız nömrə", async () => {
  const r = await post(SHOP_A, goodBody({ customer: { ...goodCustomer, first_name: "Saxta", last_name: "Adam", apartment: "pis söz" } }));
  assert.equal(r.status, 200);
});
await t("blok yoxlaması validasiyadan SONRA, Shopify-dan ƏVVƏL gəlir", async () => {
  // validasiya xətası olan bloklanmış nömrə → 400 (403 yox): əvvəl validasiya
  const r = await post(SHOP_A, goodBody({ customer: { ...goodCustomer, phone: "0509999999", address: "" } }));
  assert.equal(r.status, 400);
});
await t("BLOCKLIST_JSON yoxdursa → heç kim bloklanmır", async () => {
  const saved = process.env.BLOCKLIST_JSON; delete process.env.BLOCKLIST_JSON;
  const r = await post(SHOP_A, goodBody({ customer: { ...goodCustomer, phone: "+994509999999" } }));
  process.env.BLOCKLIST_JSON = saved;
  assert.equal(r.status, 200);
});
await t("BLOCKLIST_JSON pozuqdursa → bloklama söndürülür, sifariş keçir (fail-open)", async () => {
  const saved = process.env.BLOCKLIST_JSON; process.env.BLOCKLIST_JSON = "{bad";
  const r = await post(SHOP_A, goodBody({ customer: { ...goodCustomer, phone: "+994509999999" } }));
  process.env.BLOCKLIST_JSON = saved;
  assert.equal(r.status, 200);
});
await t("phones massiv deyil / boş → heç kim bloklanmır", async () => {
  const saved = process.env.BLOCKLIST_JSON;
  for (const v of [{ phones: "0509999999" }, { phones: [] }, {}]) {
    process.env.BLOCKLIST_JSON = JSON.stringify(v); calls = [];
    assert.equal((await post(SHOP_A, goodBody({ customer: { ...goodCustomer, phone: "+994509999999" } }))).status, 200, JSON.stringify(v));
  }
  process.env.BLOCKLIST_JSON = saved;
});
await t("message yoxdursa default mesaj; 300 simvola kəsilir", async () => {
  const saved = process.env.BLOCKLIST_JSON;
  process.env.BLOCKLIST_JSON = JSON.stringify({ phones: ["0509999999"] });
  let r = await post(SHOP_A, goodBody({ customer: { ...goodCustomer, phone: "+994509999999" } }));
  assert.equal(r.status, 403); assert.match(r.data.error, /bloklanıb/);
  process.env.BLOCKLIST_JSON = JSON.stringify({ phones: ["0509999999"], message: "M".repeat(500) });
  r = await post(SHOP_A, goodBody({ customer: { ...goodCustomer, phone: "+994509999999" } }));
  assert.equal(r.data.error.length, 300);
  process.env.BLOCKLIST_JSON = saved;
});
await t("getBlocklist / checkBlocklist (unit)", () => {
  const bl = create.getBlocklist();
  assert.deepEqual([...bl.phones], ["+994509999999", "+994551112233"]);
  assert.equal(bl.message, "Bloklandınız.");
  assert.deepEqual(create.checkBlocklist({ phone: "050 999 99 99" }), { blocked: true, reason: "phone:+994509999999", message: "Bloklandınız." });
  assert.deepEqual(create.checkBlocklist({ phone: "0501234567" }), { blocked: false });
  assert.deepEqual(create.checkBlocklist({}), { blocked: false });
  assert.deepEqual(create.checkBlocklist({ phone: "0509999999" }, null), { blocked: false });
});

// =============================================================================
describe("E. create.js — çatdırılma");
// =============================================================================
await t("adi mağaza: həmişə pulsuz", async () => {
  const r = await post(SHOP_A, goodBody({ items: [{ variant_id: 1, product_id: 2, quantity: 1 }] }));
  assert.deepEqual(r.data.shipping, { title: "Pulsuz çatdırılma", price: 0 });
  assert.deepEqual(gql()[0].variables.input.shippingLine, { title: "Pulsuz çatdırılma", price: 0 });
});
await t("BilekFit: 1 ədəd, modal 0 gözləyir → 409 SHIPPING_MISMATCH, order yaranmır", async () => {
  const r = await post(SHOP_BILEK, goodBody({ items: [{ variant_id: 1, product_id: BILEK_PRODUCT, quantity: 1 }] }));
  assert.equal(r.status, 409); assert.equal(r.data.code, "SHIPPING_MISMATCH"); assert.equal(r.data.shipping.price, 4);
  assert.equal(gql().length, 0);
});
await t("BilekFit: 1 ədəd, 400 qəpik gözləyir → shippingLine 4 ₼ 'Standart çatdırılma'", async () => {
  const r = await post(SHOP_BILEK, goodBody({ items: [{ variant_id: 1, product_id: BILEK_PRODUCT, quantity: 1 }], delivery: { expected_shipping_cents: 400 } }));
  assert.equal(r.status, 200);
  assert.deepEqual(gql()[0].variables.input.shippingLine, { title: "Standart çatdırılma", price: 4 });
});
await t("BilekFit: 2 ədəd (və ya 2 sətirdə 1+1) → pulsuz", async () => {
  assert.equal((await post(SHOP_BILEK, goodBody({ items: [{ variant_id: 1, product_id: BILEK_PRODUCT, quantity: 2 }] }))).data.shipping.price, 0);
  assert.equal((await post(SHOP_BILEK, goodBody({ items: [{ variant_id: 1, product_id: BILEK_PRODUCT, quantity: 1 }, { variant_id: 2, product_id: BILEK_PRODUCT, quantity: 1 }] }))).data.shipping.price, 0);
});
await t("BilekFit: başqa məhsul 1 ədəd → pulsuz", async () => {
  assert.equal((await post(SHOP_BILEK, goodBody({ items: [{ variant_id: 1, product_id: "999", quantity: 1 }] }))).data.shipping.price, 0);
});
await t("köhnə modal (expected_shipping_cents yoxdur) → yoxlama keçilir, server dəyəri tətbiq olunur", async () => {
  const body = goodBody({ items: [{ variant_id: 1, product_id: BILEK_PRODUCT, quantity: 1 }] }); delete body.delivery;
  const r = await post(SHOP_BILEK, body);
  assert.equal(r.status, 200); assert.equal(r.data.shipping.price, 4);
});
await t("SHIPPING_RULES_JSON env kodda olan siyahını əvəz edir", async () => {
  process.env.SHIPPING_RULES_JSON = JSON.stringify({ [SHOP_A]: { product_ids: ["222"], single_unit_fee: 3, fee_title: "Kuryer", free_title: "Pulsuz" } });
  const r1 = await post(SHOP_A, goodBody({ delivery: { expected_shipping_cents: 300 } }));
  const r2 = await post(SHOP_BILEK, goodBody({ items: [{ variant_id: 1, product_id: BILEK_PRODUCT, quantity: 1 }] }));
  delete process.env.SHIPPING_RULES_JSON;
  assert.deepEqual(r1.data.shipping, { title: "Kuryer", price: 3 });
  assert.equal(r2.data.shipping.price, 0, "env varsa kodda olan BilekFit qaydası artıq işləmir");
});
await t("SHIPPING_RULES_JSON pozuqdursa → kodda olan siyahı", async () => {
  process.env.SHIPPING_RULES_JSON = "{bad";
  const r = await post(SHOP_BILEK, goodBody({ items: [{ variant_id: 1, product_id: BILEK_PRODUCT, quantity: 1 }], delivery: { expected_shipping_cents: 400 } }));
  delete process.env.SHIPPING_RULES_JSON;
  assert.equal(r.data.shipping.price, 4);
});

// =============================================================================
describe("F. create.js — sifariş axını");
// =============================================================================
await t("uğurlu sifariş: token → create → complete; cavab düzgün", async () => {
  const r = await post(SHOP_A, goodBody());
  assert.equal(r.status, 200); assert.equal(r.data.ok, true); assert.equal(r.data.orderName, "#D1"); assert.equal(r.data.shop, SHOP_A);
  assert.ok(calls[0].url.includes(`https://${SHOP_A}/admin/oauth/access_token`));
  assert.deepEqual(gqlNames(), ["CreateCodDraftOrder", "CompleteCodDraftOrder"]);
  assert.equal(r.data.totals.totalCents, 4999); assert.equal(r.data.totals.fallbackDiscountCents, 0);
});
await t("draft input: telefon, ünvan, qeyd, tags, note, customAttributes, acceptAutomaticDiscounts", async () => {
  await post(SHOP_A, goodBody());
  const input = gql()[0].variables.input;
  assert.equal(input.phone, "+994501234567");
  assert.equal(input.acceptAutomaticDiscounts, true);
  assert.deepEqual(input.shippingAddress, { firstName: "Aynur", lastName: "Hüseynova", phone: "+994501234567", address1: "Nizami küç. 12", address2: "giriş 2", city: "Bakı", countryCode: "AZ" });
  assert.deepEqual(input.tags, ["Qapıda Ödəniş", "COD", "Storefront Modal"]);
  assert.equal(input.note, "Qapıda ödəniş. Tel: +994501234567. Bölgə: Nəsimi");
  const attrs = Object.fromEntries(input.customAttributes.map(a => [a.key, a.value]));
  assert.equal(attrs["Telefon"], "+994501234567"); assert.equal(attrs["Bölgə"], "Nəsimi");
  assert.equal(attrs["Kuryer üçün məlumat"], "giriş 2"); assert.equal(attrs["Mənbə mağaza"], SHOP_A);
});
await t("complete: paymentPending:true, draft id ötürülür", async () => {
  await post(SHOP_A, goodBody());
  const c = gql()[1];
  assert.match(c.query, /paymentPending:\s*true/); assert.equal(c.variables.id, "gid://shopify/DraftOrder/1");
});
await t("Shopify API URL: mağaza domaini + API versiyası, access token header", async () => {
  await post(SHOP_A, goodBody());
  const c = calls.find(c => c.url.includes("/admin/api/"));
  assert.equal(c.url, `https://${SHOP_A}/admin/api/2026-10/graphql.json`);
});
await t("bundle properties → lineItems[].customAttributes (yalnız string/number/boolean)", async () => {
  const r = await post(SHOP_A, goodBody({ items: [{ variant_id: 1, product_id: 2, quantity: 2, properties: { _bundlex: "{\"a\":1}", __pumper_bundles: "abc.0", n: 5, b: true, nested: { x: 1 }, arr: [1], empty: "" } }] }));
  assert.equal(r.status, 200);
  assert.deepEqual(gql()[0].variables.input.lineItems[0].customAttributes, [
    { key: "_bundlex", value: "{\"a\":1}" }, { key: "__pumper_bundles", value: "abc.0" }, { key: "n", value: "5" }, { key: "b", value: "true" }
  ]);
});
await t("properties yoxdursa / massivdirsə → customAttributes sahəsi göndərilmir", async () => {
  await post(SHOP_A, goodBody({ items: [{ variant_id: 1, product_id: 2, quantity: 1, properties: [1, 2] }] }));
  assert.equal("customAttributes" in gql()[0].variables.input.lineItems[0], false);
});
await t("properties: max 20 açar, dəyər 1000 simvola kəsilir", async () => {
  const props = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, "v".repeat(2000)]));
  await post(SHOP_A, goodBody({ items: [{ variant_id: 1, product_id: 2, quantity: 1, properties: props }] }));
  const attrs = gql()[0].variables.input.lineItems[0].customAttributes;
  assert.equal(attrs.length, 20); assert.equal(attrs[0].value.length, 1000);
});
await t("Shopify 'Phone is invalid' → phone-suz təkrar; nömrə atributda qalır", async () => {
  scenario.rejectPhone = true;
  const r = await post(SHOP_A, goodBody());
  assert.equal(r.status, 200);
  const creates = gql().filter(c => c.query.includes("CreateCodDraftOrder"));
  assert.equal(creates.length, 2);
  assert.equal("phone" in creates[1].variables.input, false);
  assert.equal("phone" in creates[1].variables.input.shippingAddress, false);
  assert.ok(creates[1].variables.input.customAttributes.some(a => a.key === "Telefon" && a.value === "+994501234567"));
  assert.deepEqual(gqlNames(), ["CreateCodDraftOrder", "CreateCodDraftOrder", "CompleteCodDraftOrder"]);
});

// =============================================================================
describe("G. create.js — fallback endirim");
// =============================================================================
await t("draft 100, gözlənilən 49.99, səbət 50.01 bildirir → 50.01 endirim yazılır, başlıq səbətdən", async () => {
  scenario.draftTotal = 100; scenario.draftSubtotal = 100;
  const r = await post(SHOP_A, goodBody({ pricing: { expected_total_cents: 4999 }, discounts: { codes: [], applications: [{ title: "Kampaniya", amount_cents: 5001 }] } }));
  assert.equal(r.status, 200);
  assert.deepEqual(gqlNames(), ["CreateCodDraftOrder", "ApplyCodFallbackDiscount", "CompleteCodDraftOrder"]);
  const upd = gql()[1].variables;
  assert.equal(upd.id, "gid://shopify/DraftOrder/1");
  assert.deepEqual(upd.input.appliedDiscount, { valueType: "FIXED_AMOUNT", value: 50.01, title: "Kampaniya", description: "Səbətdəki endirim (modal)" });
  assert.ok(upd.input.tags.includes("Endirim: səbətdən"));
  assert.equal(r.data.totals.fallbackDiscountCents, 5001); assert.equal(r.data.totals.totalCents, 4999);
});
await t("Pumper '4 ƏDƏD': draft 320, gözlənilən 108.99, bildirilən 211.01 → tam endirim (köhnə 60% tavan kəsirdi)", async () => {
  scenario.draftTotal = 320; scenario.draftSubtotal = 320;
  const r = await post(SHOP_A, goodBody({ pricing: { expected_total_cents: 10899 }, discounts: { applications: [{ title: "4 ƏDƏD", amount_cents: 21101 }] } }));
  assert.equal(r.data.totals.fallbackDiscountCents, 21101); assert.equal(r.data.totals.totalCents, 10899);
});
await t("tavan 1: saxta 'gözlənilən 1 ₼', səbət 10 ₼ bildirir → max 11 ₼ (bildirilən + 1 ₼)", async () => {
  scenario.draftTotal = 100; scenario.draftSubtotal = 100;
  const r = await post(SHOP_A, goodBody({ pricing: { expected_total_cents: 100 }, discounts: { applications: [{ title: "X", amount_cents: 1000 }] } }));
  assert.equal(r.data.totals.fallbackDiscountCents, 1100);
});
await t("tavan 2: heç nə bildirilmir, gözlənilən 1 ₼ → max 85% subtotal", async () => {
  scenario.draftTotal = 100; scenario.draftSubtotal = 100;
  const r = await post(SHOP_A, goodBody({ pricing: { expected_total_cents: 100 } }));
  assert.equal(r.data.totals.fallbackDiscountCents, 8500);
});
await t("tavan 3: bildirilən 95 ₼ (85%-dən çox) → yenə 85%", async () => {
  scenario.draftTotal = 100; scenario.draftSubtotal = 100;
  const r = await post(SHOP_A, goodBody({ pricing: { expected_total_cents: 100 }, discounts: { applications: [{ title: "X", amount_cents: 9500 }] } }));
  assert.equal(r.data.totals.fallbackDiscountCents, 8500);
});
await t("fərq ≤ 5 qəpik → endirim yazılmır", async () => {
  scenario.draftTotal = 50.03; scenario.draftSubtotal = 50.03;
  const r = await post(SHOP_A, goodBody({ pricing: { expected_total_cents: 4999 } }));
  assert.equal(r.data.totals.fallbackDiscountCents, 0); assert.deepEqual(gqlNames(), ["CreateCodDraftOrder", "CompleteCodDraftOrder"]);
});
await t("draft gözləniləndən ucuzdursa → heç nə edilmir", async () => {
  scenario.draftTotal = 40; scenario.draftSubtotal = 40;
  const r = await post(SHOP_A, goodBody({ pricing: { expected_total_cents: 4999 } }));
  assert.equal(r.data.totals.fallbackDiscountCents, 0);
});
await t("expected_total_cents yoxdur / 0 / mənfi → fallback işə düşmür", async () => {
  scenario.draftTotal = 100; scenario.draftSubtotal = 100;
  for (const pricing of [undefined, { expected_total_cents: 0 }, { expected_total_cents: -5 }, { expected_total_cents: "abc" }]) {
    calls = [];
    const b = goodBody(); if (pricing === undefined) delete b.pricing; else b.pricing = pricing;
    const r = await post(SHOP_A, b);
    assert.equal(r.data.totals.fallbackDiscountCents, 0, JSON.stringify(pricing));
  }
});
await t("çatdırılma ödənişli olanda gözlənilən yekun = məhsul + çatdırılma", async () => {
  scenario.draftTotal = 104; scenario.draftSubtotal = 100; // Shopify: 100 məhsul + 4 çatdırılma
  const r = await post(SHOP_BILEK, goodBody({ items: [{ variant_id: 1, product_id: BILEK_PRODUCT, quantity: 1 }], delivery: { expected_shipping_cents: 400 }, pricing: { expected_total_cents: 5400 }, discounts: { applications: [{ title: "Y", amount_cents: 5000 }] } }));
  assert.equal(r.data.totals.fallbackDiscountCents, 5000);
});
await t("fallback yazıla bilmədi → order yenə tamamlanır, fallbackDiscountCents 0", async () => {
  scenario.draftTotal = 100; scenario.draftSubtotal = 100; scenario.fallbackFail = true;
  const r = await post(SHOP_A, goodBody({ pricing: { expected_total_cents: 4999 } }));
  assert.equal(r.status, 200); assert.equal(r.data.totals.fallbackDiscountCents, 0);
  assert.deepEqual(gqlNames(), ["CreateCodDraftOrder", "ApplyCodFallbackDiscount", "CompleteCodDraftOrder"]);
});
await t("başlıq yoxdursa 'Endirim'; 60 simvola kəsilir", async () => {
  scenario.draftTotal = 100; scenario.draftSubtotal = 100;
  await post(SHOP_A, goodBody({ pricing: { expected_total_cents: 4999 } }));
  assert.equal(gql()[1].variables.input.appliedDiscount.title, "Endirim");
  calls = [];
  await post(SHOP_A, goodBody({ pricing: { expected_total_cents: 4999 }, discounts: { applications: [{ title: "T".repeat(100), amount_cents: 5001 }] } }));
  assert.equal(gql()[1].variables.input.appliedDiscount.title.length, 60);
});

// =============================================================================
describe("H. create.js — Meta Purchase CAPI");
// =============================================================================
await t("Purchase göndərilir: event_id, dəyər, contents, hash-lənmiş telefon, test_event_code", async () => {
  const r = await post(SHOP_A, goodBody({ items: [{ variant_id: 111, product_id: 222, quantity: 2 }] }));
  const m = metaCalls();
  assert.equal(m.length, 1);
  const ev = m[0].body.data[0];
  assert.equal(ev.event_name, "Purchase");
  assert.equal(ev.event_id, r.data.metaPurchase.eventId); assert.match(ev.event_id, /^purchase_[0-9a-f]{24}$/);
  assert.equal(ev.event_source_url, "https://x.test/p");
  assert.deepEqual(ev.custom_data, { currency: "AZN", value: 49.99, order_id: "#D1", content_type: "product", content_ids: ["111"], contents: [{ id: "111", quantity: 2 }], num_items: 2 });
  assert.equal(ev.user_data.ph[0].length, 64); assert.equal(ev.user_data.fbp, "fb.1.1.1");
  assert.equal(m[0].body.test_event_code, "TEST1");
  assert.equal(r.data.metaPurchase.capiSent, true);
});
await t("Purchase dəyəri fallback endirimdən SONRAKI məbləğdir", async () => {
  scenario.draftTotal = 100; scenario.draftSubtotal = 100;
  await post(SHOP_A, goodBody({ pricing: { expected_total_cents: 4999 }, discounts: { applications: [{ title: "K", amount_cents: 5001 }] } }));
  assert.equal(metaCalls()[0].body.data[0].custom_data.value, 49.99);
});
await t("Meta konfiqi olmayan mağaza: sifariş keçir, CAPI çağırılmır, capiSent=false", async () => {
  const r = await post(SHOP_B, goodBody());
  assert.equal(r.status, 200); assert.equal(metaCalls().length, 0); assert.equal(r.data.metaPurchase.capiSent, false);
});
await t("marketing_allowed false / yoxdur → CAPI göndərilmir", async () => {
  assert.equal((await post(SHOP_A, goodBody({ meta: { marketing_allowed: false } }))).data.metaPurchase.capiSent, false);
  const b = goodBody(); delete b.meta;
  assert.equal((await post(SHOP_A, b)).data.metaPurchase.capiSent, false);
  assert.equal(metaCalls().length, 0);
});
await t("Meta CAPI xəta verir → sifariş yenə 200, capiSent=false", async () => {
  scenario.metaFail = true;
  const r = await post(SHOP_A, goodBody());
  assert.equal(r.status, 200); assert.equal(r.data.ok, true); assert.equal(r.data.metaPurchase.capiSent, false);
});
await t("content_id_mode=product → content_ids product id-dir", async () => {
  const saved = process.env.META_STORES_JSON;
  process.env.META_STORES_JSON = JSON.stringify({ [SHOP_A]: { pixel_id: "111", access_token: "tokA", content_id_mode: "product" } });
  const r = await post(SHOP_A, goodBody());
  process.env.META_STORES_JSON = saved;
  assert.deepEqual(r.data.metaPurchase.contentIds, ["222"]);
  assert.equal("test_event_code" in metaCalls()[0].body, false);
});

// =============================================================================
describe("I. create.js — xəta halları");
// =============================================================================
await t("access token alına bilmir → 500, draft yaradılmır", async () => {
  scenario.tokenFail = true;
  const r = await post(SHOP_A, goodBody());
  assert.equal(r.status, 500); assert.match(r.data.error, /Client credentials/); assert.equal(gql().length, 0);
});
await t("Shopify HTTP 502 → 500 (mesajda status)", async () => {
  scenario.shopifyHttp = 502;
  const r = await post(SHOP_A, goodBody());
  assert.equal(r.status, 500); assert.match(r.data.error, /HTTP 502/);
});
await t("draft create userError → 500, complete çağırılmır, Meta getmir", async () => {
  scenario.createError = "Variant does not exist";
  const r = await post(SHOP_A, goodBody());
  assert.equal(r.status, 500); assert.match(r.data.error, /Variant/);
  assert.deepEqual(gqlNames(), ["CreateCodDraftOrder"]); assert.equal(metaCalls().length, 0);
});
await t("complete userError → 500, Meta getmir", async () => {
  scenario.completeError = "Draft order already completed";
  const r = await post(SHOP_A, goodBody());
  assert.equal(r.status, 500); assert.match(r.data.error, /already completed/); assert.equal(metaCalls().length, 0);
});
await t("GET /api/create → xidmət məlumatı", async () => {
  const d = await (await create.GET(new Request(`https://b.test/api/create?shop=store-a`))).json();
  assert.equal(d.ok, true); assert.equal(d.shop, SHOP_A);
});

// =============================================================================
describe("J. api/meta-event.js");
// =============================================================================
await t("imza səhv → 401; timestamp köhnə → 401", async () => {
  assert.equal((await postEvent(SHOP_A, {}, { badSig: true })).status, 401);
  assert.equal((await postEvent(SHOP_A, {}, { ts: Math.floor(Date.now() / 1000) - 600 })).status, 401);
});
await t("etibarsız shop → 400; allowlist → 403", async () => {
  assert.equal((await postEvent("bad!", {})).status, 400);
  process.env.SHOPIFY_ALLOWED_SHOPS = SHOP_B;
  assert.equal((await postEvent(SHOP_A, {})).status, 403);
  delete process.env.SHOPIFY_ALLOWED_SHOPS;
});
await t("pozuq JSON → 400", async () => { assert.equal((await postEvent(SHOP_A, "{x")).status, 400); });
await t("marketing_allowed yoxdur → skipped, CAPI yoxdur", async () => {
  const r = await postEvent(SHOP_A, { event_name: "AddToCart" });
  assert.equal(r.status, 200); assert.equal(r.data.skipped, true); assert.equal(calls.length, 0);
});
await t("yalnız AddToCart / InitiateCheckout; Purchase və başqaları → 400", async () => {
  for (const name of ["Purchase", "Lead", "", "addtocart"]) {
    assert.equal((await postEvent(SHOP_A, { marketing_allowed: true, event_name: name })).status, 400, name);
  }
});
await t("konfiq olmayan mağaza → skipped meta_not_configured", async () => {
  const r = await postEvent(SHOP_B, { marketing_allowed: true, event_name: "AddToCart" });
  assert.equal(r.data.reason, "meta_not_configured"); assert.equal(metaCalls().length, 0);
});
await t("AddToCart → CAPI; modalın event_id-si saxlanır (brauzer pixel ilə dedup)", async () => {
  const r = await postEvent(SHOP_A, { marketing_allowed: true, event_name: "AddToCart", event_id: "add_to_cart_abc", fbp: "fb.1.2.3", fbc: "fb.1.9.x", user_agent: "UA", event_source_url: "https://x.test/p", currency: "azn", value: 49.99, items: [{ variant_id: 111, quantity: 2 }] });
  assert.equal(r.status, 200); assert.equal(r.data.eventId, "add_to_cart_abc"); assert.equal(r.data.capiSent, true);
  const ev = metaCalls()[0].body.data[0];
  assert.equal(ev.event_name, "AddToCart"); assert.equal(ev.event_id, "add_to_cart_abc"); assert.equal(ev.event_source_url, "https://x.test/p");
  assert.deepEqual(ev.custom_data, { currency: "AZN", value: 49.99, content_type: "product", content_ids: ["111"], contents: [{ id: "111", quantity: 2 }], num_items: 2 });
  assert.deepEqual(ev.user_data, { fbp: "fb.1.2.3", fbc: "fb.1.9.x", client_user_agent: "UA" });
});
await t("event_id yoxdursa server özü yaradır (prefix event adından)", async () => {
  const r = await postEvent(SHOP_A, { marketing_allowed: true, event_name: "InitiateCheckout" });
  assert.match(r.data.eventId, /^initiatecheckout_[0-9a-f]{24}$/);
});
await t("custom_data sanitizasiya: pozuq valyuta → AZN, mənfi/NaN dəyər → 0, quantity 1..50", async () => {
  await postEvent(SHOP_A, { marketing_allowed: true, event_name: "AddToCart", currency: "xx", value: -3, items: [{ variant_id: 1, quantity: 0 }, { variant_id: 2, quantity: 999 }, { quantity: 1 }] });
  const cd = metaCalls()[0].body.data[0].custom_data;
  assert.equal(cd.currency, "AZN"); assert.equal(cd.value, 0);
  assert.deepEqual(cd.contents, [{ id: "1", quantity: 1 }, { id: "2", quantity: 50 }]); assert.equal(cd.num_items, 51);
});
await t("Meta xətası → 500 (ayrı endpoint, sifarişə təsir etmir)", async () => {
  scenario.metaFail = true;
  assert.equal((await postEvent(SHOP_A, { marketing_allowed: true, event_name: "InitiateCheckout" })).status, 500);
});
await t("GET /api/meta-event → metaConfigured", async () => {
  const d = await (await metaEvent.GET(new Request(`https://b.test/api/meta-event?shop=${SHOP_A}`))).json();
  assert.equal(d.metaConfigured, true);
});

// =============================================================================
describe("K. api/health.js");
// =============================================================================
await t("health: online; Meta konfiqli → true, konfiqsiz/shop-suz → false", async () => {
  const a = await (await health.GET(new Request(`https://b.test/api/health?shop=${SHOP_A}`))).json();
  const b = await (await health.GET(new Request(`https://b.test/api/health?shop=${SHOP_B}`))).json();
  const c = await (await health.GET(new Request(`https://b.test/api/health`))).json();
  assert.equal(a.ok, true); assert.equal(a.status, "online");
  assert.equal(a.metaConfigured, true); assert.equal(b.metaConfigured, false); assert.equal(c.metaConfigured, false);
});

// =============================================================================
// nəticə
// =============================================================================
globalThis.fetch = realFetch;
let last = "";
for (const [status, sec, name, err] of results) {
  if (sec !== last) { console.log(`\n${sec}`); last = sec; }
  console.log(`  ${status === "PASS" ? "✓" : "✗"} ${name}${err ? `\n      → ${err}` : ""}`);
}
const failed = results.filter(r => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} keçdi${failed ? `, ${failed} FAIL` : ""}\n`);
process.exit(failed ? 1 : 0);
