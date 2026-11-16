# InventoryBot

InventoryBot is an OpenClaw plugin for wishlists, retailer catalog discovery, and exact-product availability monitoring.

It deliberately separates two kinds of tracking:

1. **Discovery watches** answer “what listings are appearing in this retailer category?”
2. **Exact-product watches** answer “can I buy this product right now, and how?”

Catalog presence is never reported as proof of stock or purchase availability.

## Architecture

```text
discovery watch (hourly or slower)
  -> deterministic retailer search
  -> catalog listing snapshots
  -> new/returned listing events
  -> one daily Discord digest

retailer subscription
  -> postal code, radius, primary/preferred stores
  -> inherited by exact-product watches

exact-product watch (frequent)
  -> deterministic retailer adapter
  -> shipping, delivery, pickup, and store-stock observations
  -> actionable transition notification

wishlist
  -> ideas, wanted items, links, purchases, and watch associations
  -> no polling unless a watch is explicitly attached
```

Unknown, blocked, and error responses are never converted to `out_of_stock`. Generated adapters remain inactive until validation and explicit approval.

## Install and validate

```bash
npm install
npm test
npm run plugin:validate
```

OpenClaw 2026.9.8 or newer is required.

## Configuration

Settings belong under `plugins.entries.inventorybot.config`:

```yaml
persistence:
  databasePath: plugins/inventorybot/inventorybot.sqlite

monitoring:
  enabled: true
  fastIntervalSeconds: 600
  slowIntervalHours: 12
  rediscoveryAfterHours: 168
  inspectAfterUnknownCount: 3
  timeoutMs: 10000
  maxConcurrency: 4
  perDomainConcurrency: 1
  jitterSeconds: 15
  notifyWhenUnavailable: false

searchMonitoring:
  enabled: true
  digestHourLocal: 9

notifications:
  discord:
    enabled: true
    target: "channel:123456789012345678"
  maxAttempts: 6
  batchSize: 25
  baseRetrySeconds: 30
```

Discovery scheduling uses each watch's cadence, with a minimum and default of 60 minutes. Repeated search failures use retailer-specific durable exponential backoff from one hour up to 24 hours, and a successful check resets the failure count. Runs containing failed watches are recorded as errors rather than completed successes. The daily digest hour uses the gateway process's local time.

## Discovery watches

Discovery watches monitor a retailer's own search results. They do not run general web search and do not claim that a listing is purchasable.

- `inventory_search_watch_add`
- `inventory_search_watch_update`
- `inventory_search_watch_status`
- `inventory_search_watch_run`
- `inventory_search_watch_remove`

Hourly observations accumulate new and confirmed-returned listings. One daily notification aggregates all pending discovery events across watches. Each result says whether it remains present in the most recent search. A listing must be absent from three completed snapshots before a later appearance counts as returned.

Example:

```json
{
  "domain": "bestbuy.com",
  "query": "magic the gathering",
  "cadenceMinutes": 60,
  "notifyOnInitialResults": true
}
```

Search-result presence means only that the retailer listed the product in its catalog.

## Retailer subscriptions

A retailer subscription stores reusable location preferences for exact-product checks:

- `inventory_retailer_subscribe`
- `inventory_retailer_subscription_update`
- `inventory_retailer_subscription_status`
- `inventory_retailer_unsubscribe`

Example:

```json
{
  "domain": "bestbuy.com",
  "postalCode": "55125",
  "radiusMiles": 25,
  "stores": [
    { "storeId": "10", "name": "Oakdale", "primary": true },
    { "storeId": "20", "name": "Maplewood" }
  ]
}
```

Exact-product targets reference a subscription with `retailerSubscriptionId`. The adapter receives the postal code, radius, and stores on every check. A subscription must match the target retailer domain.

## Exact-product watches

- `inventory_watch_add`
- `inventory_watch_status`
- `inventory_watch_run`
- `inventory_watch_remove`

Example:

```json
{
  "product": {
    "name": "Example product",
    "sku": "SKU-42"
  },
  "retailers": [
    {
      "url": "https://retailer.example/products/sku-42",
      "retailerSubscriptionId": "subscription-uuid"
    }
  ]
}
```

Retailer adapters can report:

```text
shipping
  status: available | unavailable | unknown
  orderableOnline: true | false | null

delivery
  status: available | unavailable | unknown
  orderableOnline: true | false | null

stores[]
  stock: in_stock | limited | out_of_stock | unknown
  pickupOrderable: true | false | null
  walkInAvailable: true | false | null
```

The fields remain separate because “stock reported at a store” does not necessarily mean “orderable online for pickup.” An adapter must return `unknown` rather than infer unsupported fulfillment facts.

The fast loop sends immediate notifications only for meaningful availability transitions. Repeated unchanged availability is suppressed.

## Adapter workflow

- `discover_retailers`
- `inspect_retailer`
- `generate_retailer_adapter`
- `validate_retailer_adapter`
- `inventory_adapter_list`
- `inventory_adapter_approve`
- `inventory_adapter_revoke`
- `check_inventory`

The current generic generator safely handles conclusive JSON-LD product availability. Store-specific APIs frequently require a retailer-authored network or browser adapter. Location subscriptions and the fulfillment contract are available to those adapters, but InventoryBot never bypasses authentication, CAPTCHA, or anti-bot controls.

## Wishlist

Wishlist items remain independent from monitoring:

```text
idea -> researching -> wanted -> acquired
                   \-> paused
any state -> archived
```

Tools:

- `inventory_wishlist_add`
- `inventory_wishlist_update`
- `inventory_wishlist_transition`
- `inventory_wishlist_status`
- `inventory_wishlist_link_add` / `inventory_wishlist_link_remove`
- `inventory_wishlist_purchase_add` / `inventory_wishlist_purchase_update` / `inventory_wishlist_purchase_delete`
- `inventory_wishlist_monitor_attach` / `inventory_wishlist_monitor_detach`
- `inventory_wishlist_summary`

Adding a wishlist item or link never starts polling automatically.

## Monitoring and delivery

- `inventory_monitor_status`
- `inventory_monitor_run_fast`
- `inventory_monitor_run_slow`
- `inventory_notification_test`

Discord messages use OpenClaw's durable outbound queue. InventoryBot owns retries only before durable handoff. Operational monitor history is pruned after seven days; observations, watch state, discovery events, and adapter approval history remain durable.

## Security

- Deterministic checks are read-only toward retailers.
- Public HTTP inspection is credential-free, GET-only, timeout-bounded, redirect-bounded, and private-address rejected.
- Full product URLs are persisted, but logs remove query strings and fragments.
- Database files use restrictive permissions where supported.
- CAPTCHA and anti-bot controls are never bypassed.
