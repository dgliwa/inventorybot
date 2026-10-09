# InventoryBot

InventoryBot is an OpenClaw plugin for safe retailer discovery, deterministic inventory monitoring, adapter candidate generation, durable scheduling, and transition-based notifications.

## Architecture

```text
slow loop
  discover stale products
  -> persist retailer candidates
  -> statically inspect repeatedly uncertain targets
  -> generate and validate safe adapter candidates
  -> explicit fingerprint-bound human approval
  -> active deterministic generated adapter

fast loop
  persisted watch
  -> active deterministic adapters only
  -> persisted observation and transition
  -> transactional InventoryBot notification outbox
  -> OpenClaw durable outbound queue
  -> Discord outbound adapter
```

The fast loop never invokes search, browser inspection, generation, or repair. Unknown, blocked, and error results are never converted to `out_of_stock`.

## Install and validate

```bash
npm install
npm run build
npm test
npm run plugin:build
npm run plugin:validate
```

Phase 6 is a mixed tool/service plugin and therefore uses `definePluginEntry`. The project validation script checks runtime identity, config-schema parity, package entry existence, and exact manifest/tool registration parity. OpenClaw's `plugins validate --entry` command currently accepts authoring-metadata entries such as `defineToolPlugin`, not mixed service entries.

## Configuration

Monitoring is disabled by default so installing the plugin does not immediately poll retailers. All settings below belong under `plugins.entries.inventorybot.config`.

```yaml
adapterPromotion:
  mode: manual

persistence:
  databasePath: plugins/inventorybot/inventorybot.sqlite

monitoring:
  enabled: true
  fastIntervalSeconds: 120
  slowIntervalHours: 12
  rediscoveryAfterHours: 168
  inspectAfterUnknownCount: 3
  timeoutMs: 10000
  maxConcurrency: 4
  perDomainConcurrency: 1
  jitterSeconds: 15
  notifyWhenUnavailable: false

notifications:
  discord:
    enabled: true
    target: "channel:123456789012345678"
    # accountId: default
    # threadId: optional-thread-id
  maxAttempts: 6
  batchSize: 25
  baseRetrySeconds: 30
```

`databasePath` may be an intentional absolute path or a path relative to OpenClaw's state directory. Relative paths may not traverse outside the state directory, and an existing database destination must be a regular file rather than a symlink or device. The default is:

```text
<openclaw-state>/plugins/inventorybot/inventorybot.sqlite
```

Discord credentials remain in OpenClaw's Discord channel configuration. InventoryBot submits messages through `sendDurableMessageBatch` and does not store a bot token or call Discord directly. OpenClaw 2026.9.8 or newer is required.

## Tools

### Discovery and adapter pipeline

- `discover_retailers`
- `check_inventory`
- `inspect_retailer`
- `generate_retailer_adapter`
- `validate_retailer_adapter`
- `inventory_adapter_list`
- `inventory_adapter_approve`
- `inventory_adapter_revoke`

Generated source is never evaluated or automatically activated. Validation remains audit evidence until an operator approves the exact candidate ID and SHA-256 fingerprint. Runtime activation reconstructs the deterministic JSON-LD adapter from its validated specification rather than evaluating stored TypeScript.

Approval input:

```json
{
  "candidateId": "generated-shop-example-com-jsonld-0123456789ab",
  "sourceSha256": "<64-character SHA-256 from the candidate>",
  "confirmActivation": true,
  "reason": "Reviewed all four validation gates"
}
```

Revocation requires both the adapter ID and exact active candidate ID plus `confirmRevocation: true`. A newer candidate or repeated validation never silently replaces an active version. Active adapters are snapshotted at the start of each check or monitor run, so approval or revocation applies to the next run without mutating work already in flight.

### Watches

- `inventory_watch_add`
- `inventory_watch_remove`
- `inventory_watch_status`
- `inventory_watch_run`

Discovery searches exact identifiers first, then uses a supplied product name and optional `preferredDomains` for fallback and retailer-specific searches. Candidate confidence describes product-identity evidence; `preferred` describes operator retailer priority. Neither field verifies current stock. Codex-hosted citation results and structured search results are both supported.

Example discovery input:

```json
{
  "product": {
    "name": "Example Synth",
    "upc": "012345678905"
  },
  "preferredDomains": ["target.com", "bestbuy.com"]
}
```

Example watch input:

```json
{
  "product": {
    "name": "Example Synth",
    "manufacturer": "Acme",
    "sku": "SYNTH-42"
  },
  "retailers": [
    { "url": "https://retailer.example/products/synth-42" }
  ]
}
```

### Monitoring

- `inventory_monitor_status` — show configuration, SQLite integrity/file/table metrics, adapter coverage, recent fast/slow runs, and outbox counts
- `inventory_monitor_run_fast` — run enabled watches; optionally select `watchIds` and use `deliverNotifications: false` for a notification-suppressed smoke test
- `inventory_monitor_run_slow` — run stale discovery and inspect repeatedly uncertain targets; optionally select `watchIds` or use `dryRun: true` for a no-write/no-network preview
- `inventory_notification_test` — previews by default; sending a real Discord test requires `dryRun: false` and `confirmSend: true`

`inventory_watch_remove` disables a watch by default and preserves its history. Permanent deletion requires both `permanent: true` and `confirmDeletion: true`. Watch add/status results report whether each target currently has an active adapter; set `requireActiveAdapter: true` when adding a watch to reject uncovered targets instead of persisting them.

## Retailer search watches

Search watches monitor a retailer for newly indexed results matching an interest rather than checking one known product URL:

- `inventory_search_watch_add` — create a watch; cadence defaults to 60 minutes
- `inventory_search_watch_update` — edit the retailer, search phrase, cadence, or enabled state
- `inventory_search_watch_status` — show scheduling and recently seen results
- `inventory_search_watch_run` — run selected or all enabled watches now; supports a no-write `dryRun`
- `inventory_search_watch_remove` — disable by default or permanently delete with confirmation

Searches use `site:<domain> "<interest>"`, reject other domains, require the interest terms in result metadata, and permanently deduplicate normalized result URLs. The first run establishes a silent baseline by default; set `notifyOnInitialResults: true` to alert on existing matches. Changing the retailer or search phrase resets the baseline, while changing only cadence preserves result history.

```json
{
  "domain": "costco.com",
  "query": "magic the gathering",
  "cadenceMinutes": 60,
  "notifyOnInitialResults": false
}
```

Set `searchMonitoring.enabled: true` to run search watches without enabling the inventory fast/slow loops. The scheduler checks every minute for search watches whose individual cadence is due.

## Fast loop

The Gateway-owned InventoryBot service starts only during full plugin activation. When monitoring is enabled, the fast loop:

1. loads every enabled watch
2. checks enabled targets with active deterministic adapters
3. bounds global and per-domain concurrency, adds schedule jitter, and enforces per-target timeouts
4. isolates target and watch failures
5. atomically persists the observation and any qualifying outbox event
6. drains a bounded notification batch
7. retries only failures that occur before durable handoff; after admission, OpenClaw owns delivery, retries, receipts, and unknown-send reconciliation

A first or changed transition to `in_stock` recommends notification. Repeated `in_stock -> in_stock` results are suppressed. `in_stock -> out_of_stock` is optional.

## Slow loop

The slow loop runs independently at a much lower frequency. It:

- rediscovers products whose discovery snapshot is stale
- persists normalized retailer candidates without adding them to the fast loop
- inspects targets after a configurable consecutive `unknown`/`error` threshold
- generates candidates only from conclusive high-confidence JSON-LD
- performs the existing fixture/live/cross-check validation gates
- persists every candidate and validation report

It does not automatically activate candidates, use a browser, bypass CAPTCHA, or automatically add newly discovered URLs to a watch. Activation requires a separate `inventory_adapter_approve` call with `confirmActivation: true`, the immutable candidate ID, and its exact source hash.

## Durable notification delivery

A qualifying observation and its notification are committed in one InventoryBot SQLite transaction. The dispatcher then submits that record to OpenClaw with required durability and a stable delivery-intent ID derived from the immutable notification fingerprint.

InventoryBot retries only failures that happen before OpenClaw accepts custody. Once accepted, the local row becomes `handed_off` and is never independently resent; OpenClaw owns provider retries and supported unknown-send reconciliation. Immediate provider acceptance records `sent`, intentional no-send decisions record `suppressed`, and provider message IDs are retained when returned synchronously.

Expired InventoryBot processing leases remain recoverable before handoff. OpenClaw keeps completed stable intents for bounded deduplication, preventing a crash between queue admission and local handoff recording from creating a second physical send.

## SQLite schema

Schema version 4 contains:

```text
products
retailer_candidates
inventory_watches
inventory_targets
inventory_observations
retailer_adapters
adapter_versions
adapter_validation_runs
adapter_approval_events
notifications
monitor_runs
slow_inspections
```

SQLite foreign keys and WAL mode are enabled. Database directories and files use restrictive permissions where supported. Monitor status runs `PRAGMA quick_check` and reports schema version, database size, and per-table row counts. Mutating tool calls check cancellation immediately before writes; monitor shutdown aborts and joins active work before its database closes.

## Observability

Target checks emit structured JSON with:

```text
watch_id, product_id, domain, url (query-redacted),
adapter_id, adapter_version, status, confidence,
method, duration_ms, checked_at
```

Scheduler, discovery, inspection, and delivery failures emit separate structured events. Full URLs remain in persisted watch data and notifications, but query strings and fragments are removed from logs.

## Security notes

- Fast monitoring is deterministic and read-only toward retailers.
- Slow inspection uses credential-free public HTTP(S), private-address rejection, bounded redirects, GET-only requests, response-size limits, and timeouts.
- CAPTCHA and anti-bot controls are never bypassed.
- Discord delivery uses OpenClaw's required-durability outbound queue and configured channel adapter.
- Native `fetch` retains a documented DNS-rebinding race; use OpenClaw's network sandbox for untrusted domains.

## Remaining limits

- Adapter approval and revocation are deliberately manual; there is no automatic promotion policy.
- Browser and network-traffic inspection are not implemented.
- Newly discovered retailer candidates require operator review before becoming watch targets.
- Scheduling is process-local, while run history, observations, pre-handoff outbox work, and leases are durable in InventoryBot SQLite; accepted delivery work is durable in OpenClaw's outbound queue.
