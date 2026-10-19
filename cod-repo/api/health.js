import { getMetaStoreConfig, normalizeShop } from "../lib/meta.js";

export function GET(request) {
  const url = new URL(request.url);
  const shop = normalizeShop(url.searchParams.get("shop"));

  return Response.json({
    ok: true,
    service: "FitDiz COD Orders",
    mode: "multi-store + Meta CAPI",
    status: "online",
    metaConfigured: Boolean(shop && getMetaStoreConfig(shop))
  });
}
