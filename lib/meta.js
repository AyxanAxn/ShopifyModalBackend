import crypto from "node:crypto";

const DEFAULT_GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || "v25.0";

// Meta cavab verməsə sifarişin cavabı ilişib qalmasın: order artıq yaranıb,
// müştəri gözləyib yenidən bassa ikinci sifariş yaranar. Ona görə Meta sorğusu
// bu müddətdən sonra kəsilir (META_TIMEOUT_MS ilə dəyişmək olar, 500–15000 ms).
const DEFAULT_META_TIMEOUT_MS = 4000;

export function getMetaTimeoutMs() {
  const value = Number(process.env.META_TIMEOUT_MS);
  if (!Number.isFinite(value) || value < 500 || value > 15000) return DEFAULT_META_TIMEOUT_MS;
  return Math.round(value);
}

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

export function normalizeShop(value) {
  const shop = clean(value, 200)
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

  if (!shop) return "";
  return shop.endsWith(".myshopify.com")
    ? shop
    : `${shop}.myshopify.com`;
}

function hash(value) {
  const normalized = clean(value, 500).toLowerCase();
  if (!normalized) return "";
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function normalizePhoneForHash(value) {
  return clean(value, 60).replace(/\D/g, "");
}

function normalizeTextForHash(value) {
  return clean(value, 200)
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

// "events": ["Purchase"]  ->  Set{"Purchase"}; yoxdursa/boşdursa null (= bütün eventlər).
function parseEventAllowlist(value) {
  if (!Array.isArray(value)) return null;

  // Böyük/kiçik hərf fərqi nəzərə alınmır: "purchase" = "Purchase".
  const names = value
    .map(name => clean(name, 80).toLowerCase())
    .filter(Boolean);

  return names.length ? new Set(names) : null;
}

// Mağaza konfiqində "events" siyahısı varsa, yalnız həmin eventlər serverdən göndərilir.
export function isMetaEventEnabled(config, eventName) {
  if (!config) return false;
  if (!config.events) return true;
  return config.events.has(clean(eventName, 80).toLowerCase());
}

export function getMetaStoreConfig(shop) {
  const normalizedShop = normalizeShop(shop);
  const raw = String(process.env.META_STORES_JSON || "").trim();

  if (!raw || !normalizedShop) return null;

  let map;
  try {
    map = JSON.parse(raw);
  } catch (error) {
    console.error("META_STORES_JSON parse error:", error);
    return null;
  }

  if (!map || typeof map !== "object" || Array.isArray(map)) return null;

  // Açar env-də "https://…", böyük hərflə və ya sonda "/" ilə yazılsa da tapılır.
  const direct = map[normalizedShop] ??
    Object.entries(map).find(([key]) => normalizeShop(key) === normalizedShop)?.[1];

  if (!direct || typeof direct !== "object") return null;

  const pixelId = clean(direct.pixel_id || direct.pixelId, 100);
  const accessToken = clean(direct.access_token || direct.accessToken, 5000);

  if (!pixelId || !accessToken) return null;

  return {
    pixelId,
    accessToken,
    testEventCode: clean(direct.test_event_code || direct.testEventCode, 200),
    contentIdMode: clean(direct.content_id_mode || direct.contentIdMode || "variant", 30),
    events: parseEventAllowlist(direct.events)
  };
}

export function buildContentId(item, config = {}) {
  const mode = config?.contentIdMode || "variant";

  if (mode === "product") {
    return clean(item?.product_id || item?.productId || item?.variant_id || item?.variantId, 100);
  }

  return clean(item?.variant_id || item?.variantId || item?.id, 100);
}

export function buildPurchaseUserData({ shop, customer, meta }) {
  const phone = normalizePhoneForHash(customer?.phone);
  const firstName = normalizeTextForHash(customer?.first_name);
  const lastName = normalizeTextForHash(customer?.last_name);
  const city = normalizeTextForHash(customer?.city);
  const region = normalizeTextForHash(customer?.region);

  const userData = {};

  if (phone) userData.ph = [hash(phone)];
  if (firstName) userData.fn = [hash(firstName)];
  if (lastName) userData.ln = [hash(lastName)];
  if (city) userData.ct = [hash(city)];
  if (region) userData.st = [hash(region)];
  userData.country = [hash("az")];

  if (phone) {
    userData.external_id = [hash(`${normalizeShop(shop)}|${phone}`)];
  }

  const fbp = clean(meta?.fbp, 300);
  const fbc = clean(meta?.fbc, 500);
  const userAgent = clean(meta?.user_agent, 1000);

  if (fbp.startsWith("fb.")) userData.fbp = fbp;
  if (fbc.startsWith("fb.")) userData.fbc = fbc;
  if (userAgent) userData.client_user_agent = userAgent;

  return userData;
}

export function buildAnonymousUserData(meta) {
  const userData = {};

  const fbp = clean(meta?.fbp, 300);
  const fbc = clean(meta?.fbc, 500);
  const userAgent = clean(meta?.user_agent, 1000);

  if (fbp.startsWith("fb.")) userData.fbp = fbp;
  if (fbc.startsWith("fb.")) userData.fbc = fbc;
  if (userAgent) userData.client_user_agent = userAgent;

  return userData;
}

export function sanitizeEventSourceUrl(value, shop) {
  const fallback = `https://${normalizeShop(shop)}`;
  const raw = clean(value, 2000);

  if (!raw) return fallback;

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return fallback;
    return url.toString();
  } catch {
    return fallback;
  }
}

export function makeEventId(prefix, shop, seed = "") {
  const safePrefix = clean(prefix, 40).replace(/[^a-zA-Z0-9_-]/g, "") || "event";
  const material = `${normalizeShop(shop)}|${clean(seed, 500)}|${Date.now()}|${crypto.randomUUID()}`;
  const digest = crypto.createHash("sha256").update(material).digest("hex").slice(0, 24);
  return `${safePrefix}_${digest}`;
}

export async function sendMetaEvent({
  shop,
  eventName,
  eventId,
  eventSourceUrl,
  userData,
  customData
}) {
  const config = getMetaStoreConfig(shop);

  if (!config) {
    return {
      ok: false,
      skipped: true,
      reason: "meta_not_configured"
    };
  }

  if (!isMetaEventEnabled(config, eventName)) {
    return {
      ok: false,
      skipped: true,
      reason: "meta_event_not_enabled"
    };
  }

  const version = DEFAULT_GRAPH_VERSION.startsWith("v")
    ? DEFAULT_GRAPH_VERSION
    : `v${DEFAULT_GRAPH_VERSION}`;

  const event = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: "website",
    event_source_url: sanitizeEventSourceUrl(eventSourceUrl, shop),
    user_data: userData || {},
    custom_data: customData || {}
  };

  const payload = {
    data: [event]
  };

  if (config.testEventCode) {
    payload.test_event_code = config.testEventCode;
  }

  const timeoutMs = getMetaTimeoutMs();
  let response;

  try {
    response = await fetch(
      `https://graph.facebook.com/${version}/${encodeURIComponent(config.pixelId)}/events`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Authorization": `Bearer ${config.accessToken}`
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
      }
    );
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error(`Meta CAPI timeout (${timeoutMs} ms)`);
    }
    throw error;
  }

  const result = await response.json().catch(() => ({}));

  if (!response.ok || result?.error) {
    const message =
      result?.error?.message ||
      result?.error?.error_user_msg ||
      `Meta CAPI HTTP ${response.status}`;

    throw new Error(message);
  }

  return {
    ok: true,
    eventsReceived: Number(result?.events_received || 0),
    fbtraceId: result?.fbtrace_id || null
  };
}
