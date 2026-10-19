import crypto from "node:crypto";
import {
  buildContentId,
  buildPurchaseUserData,
  getMetaStoreConfig,
  makeEventId,
  sendMetaEvent
} from "../lib/meta.js";

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-10";

// ---------------------------------------------------------------------------
// Çatdırılma qaydası — mağaza üzrə.
// Burada adı olmayan mağaza üçün heç nə dəyişmir: "Pulsuz çatdırılma", 0 ₼.
// İstəsən SHIPPING_RULES_JSON env ilə də verə bilərsən (eyni format); env
// varsa, buradakı siyahını əvəz edir.
// ---------------------------------------------------------------------------
const DEFAULT_SHIPPING_RULES = {
  "skcwhv-hv.myshopify.com": {
    // BilekFit — bu məhsuldan cəmi 1 ədəd => 4 ₼, 2+ => pulsuz
    product_ids: ["10261167374476"],
    single_unit_fee: 4,
    fee_title: "Standart çatdırılma",
    free_title: "Pulsuz çatdırılma"
  }
};

function getShippingRules() {
  const raw = String(process.env.SHIPPING_RULES_JSON || "").trim();
  if (!raw) return DEFAULT_SHIPPING_RULES;

  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error("SHIPPING_RULES_JSON parse error, default istifadə olunur:", error);
    return DEFAULT_SHIPPING_RULES;
  }
}

// items: [{ productId, quantity }]  ->  { title, price }
function calculateShipping(shop, items) {
  const rule = getShippingRules()[shop];
  const free = { title: rule?.free_title || "Pulsuz çatdırılma", price: 0 };

  if (!rule) return free;

  const targetIds = new Set((rule.product_ids || []).map(String));
  const fee = Number(rule.single_unit_fee);

  if (!targetIds.size || !Number.isFinite(fee) || fee <= 0) return free;

  const specialUnits = items
    .filter(item => targetIds.has(String(item.productId)))
    .reduce((sum, item) => sum + item.quantity, 0);

  if (specialUnits === 1) {
    return { title: rule.fee_title || "Standart çatdırılma", price: fee };
  }

  return free;
}

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function normalizeShop(value) {
  const shop = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");

  if (!shop) return "";
  return shop.endsWith(".myshopify.com")
    ? shop
    : `${shop}.myshopify.com`;
}

function isValidShopDomain(shop) {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
}

function getAllowedShops() {
  const raw = String(process.env.SHOPIFY_ALLOWED_SHOPS || "").trim();

  if (!raw) return null;

  const shops = raw
    .split(",")
    .map(normalizeShop)
    .filter(Boolean);

  return new Set(shops);
}

function safeCompareHex(a, b) {
  try {
    const aa = Buffer.from(String(a || ""), "hex");
    const bb = Buffer.from(String(b || ""), "hex");

    return (
      aa.length > 0 &&
      aa.length === bb.length &&
      crypto.timingSafeEqual(aa, bb)
    );
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

    if (!grouped.has(key)) {
      grouped.set(key, []);
    }

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

  const ageSeconds = Math.abs(Date.now() / 1000 - ts);

  return ageSeconds <= 300;
}

function cleanText(value, max = 250) {
  return String(value || "").trim().slice(0, max);
}

// Azərbaycan nömrələrini E.164-ə gətirir:
//   +994501234567 | 994501234567 | 0501234567 | 501234567 | 050 123 45 67
// Xarici nömrə "+" ilə gəlirsə olduğu kimi saxlanır.
function normalizePhone(value) {
  const raw = cleanText(value, 40);
  const digits = raw.replace(/\D/g, "");

  if (!digits) return "";

  if (raw.startsWith("+")) return `+${digits}`;
  if (digits.startsWith("994") && digits.length === 12) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 10) return `+994${digits.slice(1)}`;
  if (digits.length === 9) return `+994${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return `+${digits}`;

  return digits;
}

// ---------------------------------------------------------------------------
// Bloklanmış nömrələr — saxta sifarişlər.
// BLOCKLIST_JSON env (bütün mağazalar üçün ortaqdır):
// {
//   "phones":  ["050 123 45 67", "+994551112233"],  // istənilən format, normalizePhone ilə müqayisə
//   "message": "Bu nömrədən sifariş qəbul edilmir." // modalda göstərilən mətn (istəyə görə)
// }
// Uyğun gələn sorğu 403 BLOCKED ilə qaytarılır; order yaranmır, Meta event getmir.
// Env yoxdursa və ya pozuqdursa bloklama söndürülür (fail-open) — sifarişlər dayanmır.
// ---------------------------------------------------------------------------
const DEFAULT_BLOCKED_MESSAGE =
  "Bu nömrə saxta sifarişlərə görə bloklanıb. Sifariş qəbul edilmir.";

export function getBlocklist() {
  const raw = String(process.env.BLOCKLIST_JSON || "").trim();
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error("BLOCKLIST_JSON parse error:", error);
    return null;
  }

  const phones = (Array.isArray(parsed?.phones) ? parsed.phones : [])
    .map(normalizePhone)
    .filter(Boolean);

  return {
    phones: new Set(phones),
    message: cleanText(parsed?.message, 300) || DEFAULT_BLOCKED_MESSAGE
  };
}

// Qaytarır: { blocked: false } və ya { blocked: true, reason, message }
export function checkBlocklist(customer, blocklist = getBlocklist()) {
  if (!blocklist) return { blocked: false };

  const phone = normalizePhone(customer?.phone);
  if (phone && blocklist.phones.has(phone)) {
    return { blocked: true, reason: `phone:${phone}`, message: blocklist.message };
  }

  return { blocked: false };
}

// Shopify userError-u telefonla bağlıdırmı ("Phone is invalid" və s.)
function isPhoneUserError(errors) {
  return (errors || []).some(error =>
    /phone/i.test(String(error?.message || "")) ||
    (Array.isArray(error?.field) && error.field.some(f => /phone/i.test(String(f))))
  );
}

// cart.js "properties": { "_bundlex": "{...}", "__pumper_bundles": "abc.0" } -> [{ key, value }]
// Yalnız sadə string/number/boolean dəyərlər; max 20 açar, açar ≤100, dəyər ≤1000 simvol.
function sanitizeLineProperties(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];

  const attributes = [];

  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = cleanText(rawKey, 100);
    if (!key) continue;

    let text;
    if (typeof rawValue === "string") text = rawValue;
    else if (typeof rawValue === "number" || typeof rawValue === "boolean") text = String(rawValue);
    else continue;

    text = cleanText(text, 1000);
    if (!text) continue;

    attributes.push({ key, value: text });
    if (attributes.length >= 20) break;
  }

  return attributes;
}

function validatePayload(body) {
  const customer = body?.customer || {};
  const items = Array.isArray(body?.items) ? body.items : [];

  const required = {
    first_name: cleanText(customer.first_name, 80),
    last_name: cleanText(customer.last_name, 80),
    phone: normalizePhone(customer.phone),
    address: cleanText(customer.address, 250),
    region: cleanText(customer.region, 120),
    city: cleanText(customer.city, 120)
  };

  // Kuryer üçün qeyd — istəyə görə (boş ola bilər)
  const apartment = cleanText(customer.apartment, 250);

  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length) {
    return {
      ok: false,
      error: `Məcburi sahələr boşdur: ${missing.join(", ")}`
    };
  }

  const phoneDigits = required.phone.replace(/\D/g, "");

  if (phoneDigits.length < 9 || phoneDigits.length > 15) {
    return {
      ok: false,
      error: "Əlaqə nömrəsi düzgün deyil."
    };
  }

  const normalizedItems = [];

  for (const item of items) {
    const variantId = String(item?.variant_id || "").replace(/\D/g, "");
    const productId = String(item?.product_id || "").replace(/\D/g, "");
    const quantity = Number(item?.quantity);

    if (
      !variantId ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 50
    ) {
      return {
        ok: false,
        error: "Səbətdə etibarsız məhsul məlumatı var."
      };
    }

    normalizedItems.push({
      variantId: `gid://shopify/ProductVariant/${variantId}`,
      productId,
      quantity,
      // Səbət sətrinin xüsusiyyətləri (line item properties). Bundle / quantity-break
      // app-ları (BundleX "_bundlex", Pumper "__pumper_bundles") endirimi məhz bu
      // açarlara görə tətbiq edir — draft order-ə customAttributes kimi ötürülür.
      customAttributes: sanitizeLineProperties(item?.properties)
    });
  }

  if (!normalizedItems.length) {
    return {
      ok: false,
      error: "Səbət boşdur."
    };
  }

  if (normalizedItems.length > 100) {
    return {
      ok: false,
      error: "Səbətdə həddindən artıq məhsul var."
    };
  }

  return {
    ok: true,
    customer: { ...required, apartment },
    items: normalizedItems
  };
}

async function getAccessToken(shop, clientId, clientSecret) {
  const tokenUrl = `https://${shop}/admin/oauth/access_token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.access_token) {
    throw new Error(
      result.error_description ||
      result.error ||
      `Shopify access token alına bilmədi (${shop}).`
    );
  }

  return result.access_token;
}

async function shopifyGraphQL(shop, accessToken, query, variables) {
  const response = await fetch(
    `https://${shop}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Shopify-Access-Token": accessToken
      },
      body: JSON.stringify({ query, variables })
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Shopify API HTTP ${response.status} (${shop})`);
  }

  if (Array.isArray(result.errors) && result.errors.length) {
    throw new Error(result.errors.map(error => error.message).join("; "));
  }

  return result.data;
}

const DRAFT_FIELDS = `
  id
  name
  totalPriceSet { shopMoney { amount currencyCode } }
  subtotalPriceSet { shopMoney { amount currencyCode } }
  totalDiscountsSet { shopMoney { amount currencyCode } }
`;

const CREATE_DRAFT = `
  mutation CreateCodDraftOrder($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { ${DRAFT_FIELDS} }
      userErrors {
        field
        message
      }
    }
  }
`;

// Səbətdəki endirim Shopify tərəfindən tətbiq olunmayanda fərqi endirim kimi yazmaq üçün
const UPDATE_DRAFT_DISCOUNT = `
  mutation ApplyCodFallbackDiscount($id: ID!, $input: DraftOrderInput!) {
    draftOrderUpdate(id: $id, input: $input) {
      draftOrder { ${DRAFT_FIELDS} }
      userErrors {
        field
        message
      }
    }
  }
`;

// Endirim fallback-ının tavanı (client məlumatına tam etibar etməmək üçün):
//   1) subtotal-ın bu faizindən çox endirim yazılmır (mütləq sərhəd);
//   2) modal səbətdəki tətbiq olunmuş endirimlərin məbləğini də göndərir
//      (discounts.applications[].amount_cents — bunu Shopify özü hesablayıb);
//      fallback həmin məbləğdən (+1 ₼ yuvarlaqlaşdırma payı) çox ola bilməz.
// Köhnə 60% tavan Pumper "4 ƏDƏD" (−66%) tier-ini kəsirdi: 320 ₼ → 108.99 əvəzinə 128 ₼.
const FALLBACK_DISCOUNT_MAX_PERCENT = 85;
const FALLBACK_ROUNDING_TOLERANCE_CENTS = 100;

// Modal-ın göndərdiyi səbət endirimlərinin cəmi (qəpik). Etibarsız → 0.
function reportedDiscountCents(body) {
  const apps = Array.isArray(body?.discounts?.applications) ? body.discounts.applications : [];
  const total = apps.reduce((sum, app) => {
    const cents = Math.round(Number(app?.amount_cents));
    return Number.isFinite(cents) && cents > 0 ? sum + cents : sum;
  }, 0);
  return Math.min(total, 10_000_000);
}

function sanitizeDiscountCodes(value) {
  return (Array.isArray(value) ? value : [])
    .map(code => String(code || "").trim())
    .filter(code => /^[A-Za-z0-9_\-]{1,64}$/.test(code))
    .slice(0, 5);
}

function toCents(amount) {
  return Math.round(Number(amount || 0) * 100);
}

const COMPLETE_DRAFT = `
  mutation CompleteCodDraftOrder($id: ID!) {
    draftOrderComplete(
      id: $id
      paymentPending: true
    ) {
      draftOrder {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function POST(request) {
  try {
    const clientId = process.env.SHOPIFY_CLIENT_ID;
    const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return json(
        {
          ok: false,
          error: "Server konfiqurasiyası tamamlanmayıb."
        },
        500
      );
    }

    const url = new URL(request.url);

    // Shopify App Proxy hər mağaza üçün shop + signature göndərir.
    // Əvvəlcə imzanı yoxlayırıq.
    if (!verifyAppProxySignature(url, clientSecret)) {
      return json(
        {
          ok: false,
          error: "Etibarsız Shopify App Proxy sorğusu."
        },
        401
      );
    }

    if (!validateProxyTimestamp(url)) {
      return json(
        {
          ok: false,
          error: "Sorğunun vaxtı keçib. Səhifəni yeniləyib yenidən cəhd edin."
        },
        401
      );
    }

    // Mağazanı ENV-dən yox, imzalanmış App Proxy sorğusundan götürürük.
    const shop = normalizeShop(url.searchParams.get("shop"));

    if (!shop || !isValidShopDomain(shop)) {
      return json(
        {
          ok: false,
          error: "Mağaza müəyyən edilə bilmədi."
        },
        400
      );
    }

    // İstəyə görə mağaza allowlist-i.
    // SHOPIFY_ALLOWED_SHOPS boşdursa, imzası düzgün olan mağazalar qəbul edilir.
    const allowedShops = getAllowedShops();

    if (allowedShops && !allowedShops.has(shop)) {
      return json(
        {
          ok: false,
          error: "Bu mağaza üçün icazə yoxdur."
        },
        403
      );
    }

    const body = await request.json().catch(() => null);

    if (!body) {
      return json(
        {
          ok: false,
          error: "Sifariş məlumatları oxunmadı."
        },
        400
      );
    }

    const validated = validatePayload(body);

    if (!validated.ok) {
      return json(
        {
          ok: false,
          error: validated.error
        },
        400
      );
    }

    // Bloklanmış müştəri — order yaradılmır, modal mesajı göstərir.
    const block = checkBlocklist(validated.customer);

    if (block.blocked) {
      console.warn("Blocked order attempt:", shop, block.reason, validated.customer.phone);
      return json(
        {
          ok: false,
          code: "BLOCKED",
          error: block.message
        },
        403
      );
    }

    // Eyni Client ID / Secret, amma token HƏR GƏLƏN SHOP üçün alınır.
    // Buna görə order hansı mağazadan gəlibsə həmin mağazada yaranır.
    const accessToken = await getAccessToken(
      shop,
      clientId,
      clientSecret
    );

    const c = validated.customer;

    // Çatdırılma server tərəfdə hesablanır; client-in göndərdiyi qiymətə etibar edilmir.
    const shipping = calculateShipping(shop, validated.items);
    const discountCodes = sanitizeDiscountCodes(body?.discounts?.codes);

    // Modal öz göstərdiyi çatdırılmanı da göndərir. Fərqlidirsə (theme ilə backend
    // uyğunsuzdur) order YARADILMIR — müştəri 0 görüb orderdə 4 görməsin.
    // Köhnə modal bu sahəni göndərmir -> yoxlama keçilir, server dəyəri tətbiq olunur.
    const expectedCents = body?.delivery?.expected_shipping_cents;

    if (
      expectedCents !== undefined &&
      expectedCents !== null &&
      Math.round(Number(expectedCents)) !== Math.round(shipping.price * 100)
    ) {
      return json(
        {
          ok: false,
          code: "SHIPPING_MISMATCH",
          error: "Çatdırılma qiyməti yeniləndi. Səbətə yenidən baxıb təsdiqləyin.",
          shipping
        },
        409
      );
    }

    const draftInput = {
      phone: c.phone,

      // Shopify draft orders automatic discounts-i default olaraq qəbul etmir.
      // true olduqda mağazada uyğun olan automatic discounts hesablanır.
      acceptAutomaticDiscounts: true,

      // Səbətdə tətbiq olunmuş endirim kodları — Shopify özü yoxlayır, uyğun olmayanı keçir.
      ...(discountCodes.length ? { discountCodes } : {}),

      lineItems: validated.items.map(item => ({
        variantId: item.variantId,
        quantity: item.quantity,
        ...(item.customAttributes.length ? { customAttributes: item.customAttributes } : {})
      })),
      shippingAddress: {
        firstName: c.first_name,
        lastName: c.last_name,
        phone: c.phone,
        address1: c.address,
        ...(c.apartment ? { address2: c.apartment } : {}),
        city: c.city,
        countryCode: "AZ"
      },
      shippingLine: {
        title: shipping.title,
        price: shipping.price
      },
      tags: [
        "Qapıda Ödəniş",
        "COD",
        "Storefront Modal"
      ],
      note: `Qapıda ödəniş. Tel: ${c.phone}. Bölgə: ${c.region}`,
      customAttributes: [
        {
          key: "Ödəniş üsulu",
          value: "Qapıda ödəniş"
        },
        // Nömrə həmişə burada da görünür — Shopify phone sahəsini rədd etsə belə itmir.
        {
          key: "Telefon",
          value: c.phone
        },
        {
          key: "Bölgə",
          value: c.region
        },
        ...(c.apartment ? [{
          key: "Kuryer üçün məlumat",
          value: c.apartment
        }] : []),
        {
          key: "Mənbə mağaza",
          value: shop
        }
      ]
    };

    const created = await shopifyGraphQL(
      shop,
      accessToken,
      CREATE_DRAFT,
      { input: draftInput }
    );

    let createResult = created?.draftOrderCreate;
    let createErrors = createResult?.userErrors || [];

    // Shopify nömrəni qəbul etmədi ("Phone is invalid") — userError olanda heç nə
    // yaranmır, ona görə təkrar təhlükəsizdir. phone sahələrini çıxarıb yenidən
    // yaradırıq; nömrə "Telefon" atributunda və qeyddə qalır. Müştəri itmir.
    if (createErrors.length && isPhoneUserError(createErrors)) {
      console.warn("Shopify rejected phone, retrying without phone fields:", shop, c.phone);

      const { phone: _phone, ...inputWithoutPhone } = draftInput;
      const { phone: _addrPhone, ...addressWithoutPhone } = draftInput.shippingAddress;

      const retried = await shopifyGraphQL(
        shop,
        accessToken,
        CREATE_DRAFT,
        { input: { ...inputWithoutPhone, shippingAddress: addressWithoutPhone } }
      );

      createResult = retried?.draftOrderCreate;
      createErrors = createResult?.userErrors || [];
    }

    if (createErrors.length || !createResult?.draftOrder?.id) {
      throw new Error(
        createErrors.map(error => error.message).join("; ") ||
        "Draft sifariş yaradılmadı."
      );
    }

    const draftId = createResult.draftOrder.id;
    let draft = createResult.draftOrder;

    // --- Endirim yoxlaması ---
    // Modal səbətdə gördüyü yekunu göndərir (endirimli məhsul + çatdırılma). Shopify
    // səbətdəki endirimi draft-a tətbiq etməyibsə (kanal məhdudiyyəti, app endirimi və s.),
    // fərqi order-ə endirim kimi yazırıq ki, müştəri gördüyü qiyməti ödəsin.
    const expectedTotalCents = Number(body?.pricing?.expected_total_cents);
    let fallbackDiscountCents = 0;

    if (Number.isFinite(expectedTotalCents) && expectedTotalCents > 0) {
      const draftTotalCents = toCents(draft.totalPriceSet?.shopMoney?.amount);
      const subtotalCents = toCents(draft.subtotalPriceSet?.shopMoney?.amount);
      const diffCents = draftTotalCents - expectedTotalCents;

      if (diffCents > 5) {
        const percentCapCents = Math.floor(subtotalCents * FALLBACK_DISCOUNT_MAX_PERCENT / 100);
        const reportedCents = reportedDiscountCents(body);
        const reportedCapCents = reportedCents > 0
          ? reportedCents + FALLBACK_ROUNDING_TOLERANCE_CENTS
          : percentCapCents;
        const capCents = Math.min(percentCapCents, reportedCapCents);
        fallbackDiscountCents = Math.min(diffCents, capCents);

        const reportedTitle = (Array.isArray(body?.discounts?.applications) ? body.discounts.applications : [])
          .map(a => cleanText(a?.title, 60))
          .find(Boolean) || "Endirim";

        console.warn("Discount not applied by Shopify, applying fallback:", shop, {
          draftTotalCents, expectedTotalCents, fallbackDiscountCents, capCents, reportedCents, reportedTitle, discountCodes
        });

        if (fallbackDiscountCents > 0) {
          const updated = await shopifyGraphQL(shop, accessToken, UPDATE_DRAFT_DISCOUNT, {
            id: draftId,
            input: {
              appliedDiscount: {
                valueType: "FIXED_AMOUNT",
                value: fallbackDiscountCents / 100,
                title: reportedTitle,
                description: "Səbətdəki endirim (modal)"
              },
              tags: [...draftInput.tags, "Endirim: səbətdən"]
            }
          });

          const updateResult = updated?.draftOrderUpdate;
          const updateErrors = updateResult?.userErrors || [];

          if (updateErrors.length || !updateResult?.draftOrder) {
            // Endirim yazıla bilmədi — order-i yenə də tamamlayırıq, amma log-a düşür.
            console.error("Fallback discount failed:", shop, draftId, updateErrors.map(e => e.message).join("; "));
            fallbackDiscountCents = 0;
          } else {
            draft = updateResult.draftOrder;
          }
        }
      }
    }

    const completed = await shopifyGraphQL(
      shop,
      accessToken,
      COMPLETE_DRAFT,
      { id: draftId }
    );

    const completeResult = completed?.draftOrderComplete;
    const completeErrors = completeResult?.userErrors || [];

    if (completeErrors.length || !completeResult?.draftOrder?.id) {
      throw new Error(
        completeErrors.map(error => error.message).join("; ") ||
        "Sifariş tamamlanmadı."
      );
    }

    const orderName = draft.name || "";
    const money = draft.totalPriceSet?.shopMoney;
    const purchaseValue = Number(money?.amount || 0);
    const purchaseCurrency = String(money?.currencyCode || "AZN");

    const metaConfig = getMetaStoreConfig(shop);
    const metaEventId = makeEventId(
      "purchase",
      shop,
      `${draftId}|${orderName}`
    );

    const metaContents = body.items.map(item => ({
      id: buildContentId(item, metaConfig || {}),
      quantity: Number(item.quantity || 1)
    })).filter(item => item.id);

    let metaCapi = {
      ok: false,
      skipped: true,
      reason: "marketing_consent_not_allowed"
    };

    if (body?.meta?.marketing_allowed === true) {
      try {
        metaCapi = await sendMetaEvent({
          shop,
          eventName: "Purchase",
          eventId: metaEventId,
          eventSourceUrl: body?.meta?.event_source_url,
          userData: buildPurchaseUserData({
            shop,
            customer: c,
            meta: body?.meta
          }),
          customData: {
            currency: purchaseCurrency,
            value: purchaseValue,
            order_id: orderName,
            content_type: "product",
            content_ids: metaContents.map(item => item.id),
            contents: metaContents,
            num_items: metaContents.reduce(
              (sum, item) => sum + Number(item.quantity || 0),
              0
            )
          }
        });
      } catch (metaError) {
        console.error("Meta CAPI Purchase error:", metaError);
        metaCapi = {
          ok: false,
          skipped: false,
          reason: metaError?.message || "meta_capi_failed"
        };
      }
    }

    return json({
      ok: true,
      shop,
      orderName,
      shipping,
      totals: {
        subtotalCents: toCents(draft.subtotalPriceSet?.shopMoney?.amount),
        discountCents: toCents(draft.totalDiscountsSet?.shopMoney?.amount),
        totalCents: toCents(draft.totalPriceSet?.shopMoney?.amount),
        expectedTotalCents: Number.isFinite(expectedTotalCents) ? expectedTotalCents : null,
        fallbackDiscountCents,
        discountCodes
      },
      metaPurchase: {
        eventId: metaEventId,
        value: purchaseValue,
        currency: purchaseCurrency,
        contentIds: metaContents.map(item => item.id),
        contents: metaContents,
        numItems: metaContents.reduce(
          (sum, item) => sum + Number(item.quantity || 0),
          0
        ),
        capiSent: metaCapi?.ok === true
      }
    });
  } catch (error) {
    console.error("COD order error:", error);

    return json(
      {
        ok: false,
        error:
          error?.message ||
          "Sifariş yaradılmadı. Yenidən cəhd edin."
      },
      500
    );
  }
}

export function GET(request) {
  const url = new URL(request.url);

  return json({
    ok: true,
    service: "FitDiz COD Orders — Multi-store",
    endpoint: "/api/create",
    shop: normalizeShop(url.searchParams.get("shop")) || null,
    message: "POST requests are accepted through Shopify App Proxy."
  });
}
