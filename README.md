# FitDiz COD Orders — Multi-store backend

Shopify App Proxy arxasında işləyən qapıda ödəniş (COD) backend-i. Bir deploy, bütün mağazalar.

```
api/create.js       POST /apps/cod-order/create     — sifariş yaradır (draft → complete), Meta Purchase CAPI
api/meta-event.js   POST /apps/cod-order/meta-event — AddToCart / InitiateCheckout CAPI
api/health.js       GET  /apps/cod-order/health
lib/meta.js         Meta Conversions API köməkçiləri
test/all.test.mjs   bütün testlər (npm test)
```

## Test

```
npm test
```

Xarici asılılıq yoxdur. Shopify və Meta API-ləri mock-lanır, qalan hər şey real koddur.

## CI/CD

`.github/workflows/ci.yml`:
- hər push / PR → sintaksis + `npm test`
- `main`-ə push → testlər keçərsə Vercel production deploy

GitHub Secrets (Settings → Secrets and variables → Actions):

| Secret | Haradan |
|---|---|
| `VERCEL_TOKEN` | vercel.com → Account Settings → Tokens → Create |
| `VERCEL_ORG_ID` | Vercel team ID (`team_…`) |
| `VERCEL_PROJECT_ID` | Vercel project ID (`prj_…`) — Project Settings → General |

Vercel-in öz Git inteqrasiyası **qoşulmur** — deploy yalnız Actions-dan gedir ki, test keçməyən kod production-a düşməsin.

## Vercel env dəyişənləri

| Dəyişən | Məcburi | Təsvir |
|---|---|---|
| `SHOPIFY_CLIENT_ID` | bəli | COD Orders Modal app |
| `SHOPIFY_CLIENT_SECRET` | bəli | App Proxy imzası + token |
| `SHOPIFY_API_VERSION` | yox | default `2026-10` |
| `SHOPIFY_ALLOWED_SHOPS` | yox | vergüllə mağaza siyahısı; boş = imzası düzgün olan hər mağaza |
| `SHIPPING_RULES_JSON` | yox | çatdırılma qaydaları; boş = koddakı `DEFAULT_SHIPPING_RULES` |
| `META_GRAPH_API_VERSION` | yox | default `v25.0` |
| `META_STORES_JSON` | Meta üçün | mağaza → `{ pixel_id, access_token, test_event_code?, content_id_mode? }` |
| `BLOCKLIST_JSON` | yox | bloklanmış nömrələr; boş = bloklama yoxdur |

### META_STORES_JSON

```json
{
  "v06ydt-1s.myshopify.com": { "pixel_id": "2622142558250195", "access_token": "EAAB..." },
  "f20u06-ka.myshopify.com": { "pixel_id": "…", "access_token": "…" }
}
```

`test_event_code` yalnız test zamanı; production-da silin.

### BLOCKLIST_JSON

```json
{
  "phones": ["050 123 45 67", "+994551112233"],
  "message": "Bu nömrə saxta sifarişlərə görə bloklanıb. Sifariş qəbul edilmir."
}
```

Nömrə istənilən formatda yazıla bilər; bütün mağazalar üçün ortaqdır. Uyğun gələn sifariş 403 ilə rədd edilir, order yaranmır, modal mesajı göstərir. Env pozuqdursa bloklama söndürülür (sifarişlər dayanmır).

## Sifariş axını

1. App Proxy imzası + timestamp (≤5 dəq) yoxlanır
2. Payload validasiya → blocklist → çatdırılma (server hesablayır, modal ilə uyğunsuzdursa 409)
3. `draftOrderCreate` (avtomatik endirimlər + səbət kodları + bundle line-item properties)
4. Shopify endirimi tətbiq etməyibsə fallback endirim (tavan: səbətin bildirdiyi məbləğ + 1 ₼, max 85%)
5. `draftOrderComplete(paymentPending: true)`
6. Meta Purchase CAPI (mağaza konfiqi varsa və marketing icazəsi varsa)
