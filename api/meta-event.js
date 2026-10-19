import crypto from "node:crypto";
import {
  buildAnonymousUserData,
  buildContentId,
  getMetaStoreConfig,
  makeEventId,
  normalizeShop,
  sendMetaEvent
} from "../lib/meta.js";

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function safeCompareHex(a, b) {
  try {
    const aa = Buffer.from(String(a || ""), "hex");
    const bb = Buffer.from(String(b || ""), "hex");
    return aa.length > 0 && aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

function verifyAppProxySignature(url, secret) {
  const signature = url.searchParams.get("signature");
  if (!signature || !secret) return false;

  const grouped = new Map();

  for (const [key, value] of url.searchParams.entries()) {
    if (key === "signature") continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(value);
  }

  const message = [...grouped.entries()]
    .map(([key, values]) => `${key}=${values.join(",")}`)
    .sort()
    .join("");

  const calculated = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  return safeCompareHex(signature, calculated);
}

function validateProxyTimestamp(url) {
  const ts = Number(url.searchParams.get("timestamp"));
  if (!Number.isFinite(ts)) return false;
  return Math.abs(Date.now() / 1000 - ts) <= 300;
}

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function isValidShopDomain(shop) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
}

function getAllowedShops() {
  const raw = String(process.env.SHOPIFY_ALLOWED_SHOPS || "").trim();
  if (!raw) return null;

  return new Set(
    raw
      .split(",")
      .map(normalizeShop)
      .filter(Boolean)
  );
}

function sanitizeCurrency(value) {
  const currency = clean(value, 3).toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : "AZN";
}

function sanitizeCustomData(body, config) {
  const items = Array.isArray(body?.items) ? body.items : [];
  const contents = items
    .map(item => ({
      id: buildContentId(item, config || {}),
      quantity: Math.max(1, Math.min(50, Number(item?.quantity || 1)))
    }))
    .filter(item => item.id);

  const value = Number(body?.value || 0);
  const numItems = contents.reduce(
    (sum, item) => sum + Number(item.quantity || 0),
    0
  );

  return {
    currency: sanitizeCurrency(body?.currency),
    value: Number.isFinite(value) && value >= 0 ? value : 0,
    content_type: "product",
    content_ids: contents.map(item => item.id),
    contents,
    num_items: numItems
  };
}

export async function POST(request) {
  try {
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

    if (!clientSecret) {
      return json({ ok: false, error: "Server konfiqurasiyası tamamlanmayıb." }, 500);
    }

    const url = new URL(request.url);

    if (!verifyAppProxySignature(url, clientSecret)) {
      return json({ ok: false, error: "Etibarsız Shopify App Proxy sorğusu." }, 401);
    }

    if (!validateProxyTimestamp(url)) {
      return json({ ok: false, error: "Sorğunun vaxtı keçib." }, 401);
    }

    const shop = normalizeShop(url.searchParams.get("shop"));

    if (!shop || !isValidShopDomain(shop)) {
      return json({ ok: false, error: "Mağaza müəyyən edilə bilmədi." }, 400);
    }

    const allowed = getAllowedShops();
    if (allowed && !allowed.has(shop)) {
      return json({ ok: false, error: "Bu mağaza üçün icazə yoxdur." }, 403);
    }

    const body = await request.json().catch(() => null);
    if (!body) {
      return json({ ok: false, error: "Event məlumatı oxunmadı." }, 400);
    }

    if (body?.marketing_allowed !== true) {
      return json({ ok: true, skipped: true, reason: "marketing_consent_not_allowed" });
    }

    const eventName = clean(body?.event_name, 80);
    const allowedEvents = new Set(["AddToCart", "InitiateCheckout"]);

    if (!allowedEvents.has(eventName)) {
      return json({ ok: false, error: "Bu Meta event-ə icazə verilmir." }, 400);
    }

    const config = getMetaStoreConfig(shop);
    if (!config) {
      return json({ ok: true, skipped: true, reason: "meta_not_configured" });
    }

    const eventId = clean(body?.event_id, 200) || makeEventId(eventName.toLowerCase(), shop);

    const result = await sendMetaEvent({
      shop,
      eventName,
      eventId,
      eventSourceUrl: body?.event_source_url,
      userData: buildAnonymousUserData({
        fbp: body?.fbp,
        fbc: body?.fbc,
        user_agent: body?.user_agent
      }),
      customData: sanitizeCustomData(body, config)
    });

    return json({
      ok: true,
      eventId,
      capiSent: result?.ok === true
    });
  } catch (error) {
    console.error("Meta event error:", error);
    return json(
      {
        ok: false,
        error: error?.message || "Meta event göndərilmədi."
      },
      500
    );
  }
}

export function GET(request) {
  const url = new URL(request.url);
  const shop = normalizeShop(url.searchParams.get("shop"));

  return json({
    ok: true,
    service: "FitDiz Meta Events",
    shop: shop || null,
    metaConfigured: Boolean(shop && getMetaStoreConfig(shop))
  });
}