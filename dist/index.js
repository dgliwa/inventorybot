import { Type } from "typebox";
import { definePluginEntry, } from "openclaw/plugin-sdk/plugin-entry";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { ExampleJsonLdAdapter } from "./adapters/builtins/example-jsonld.js";
import { AdapterRegistry } from "./adapters/registry.js";
import { domainMatches, normalizeDomain } from "./adapters/url.js";
import { discoverRetailers } from "./discovery/discover.js";
import { OpenClawSearchClient } from "./discovery/openclaw-search.js";
import { generateRetailerAdapter } from "./generation/generate-adapter.js";
import { approveRetailerAdapter, createActiveAdapterRegistry, revokeRetailerAdapter, } from "./generation/approval.js";
import { validateRetailerAdapter } from "./generation/validate-adapter.js";
import { inspectRetailerStatic } from "./inspection/static.js";
import { parseInventoryBotConfig } from "./monitoring/config.js";
import { InventoryMonitor } from "./monitoring/service.js";
import { OpenClawDiscordChannel } from "./notifications/discord.js";
import { InventoryDatabase } from "./persistence/db.js";
import { resolveInventoryDatabasePath } from "./persistence/path.js";
import { checkInventory } from "./tools/check-inventory.js";
import { WatchService } from "./watches/service.js";
export const adapterRegistry = new AdapterRegistry([new ExampleJsonLdAdapter()]);
function openInventoryDatabase(api, configuredPath) {
    const stateDir = api.runtime.state.resolveStateDir(process.env);
    return new InventoryDatabase(resolveInventoryDatabasePath(stateDir, configuredPath));
}
function activeAdapterRegistry(api, database) {
    return createActiveAdapterRegistry(database, {
        authoredAdapters: [...adapterRegistry.list()],
        onRejectedCandidate: (candidate, errors) => api.logger.error(JSON.stringify({
            event: "inventory_adapter_activation_rejected",
            candidate_id: candidate.candidateId,
            adapter_id: candidate.spec.adapterId,
            errors,
        })),
    });
}
function affectedWatchIds(database, domain) {
    return database.listWatches()
        .filter(({ retailers }) => retailers.some(({ url }) => domainMatches(normalizeDomain(url), domain)))
        .map(({ id }) => id);
}
function notificationChannels(api, options) {
    if (!options.enabled)
        return new Map();
    return new Map([
        [
            "discord",
            new OpenClawDiscordChannel(api.config, { maxRetries: options.maxRetries }),
        ],
    ]);
}
function createMonitor(api) {
    const config = parseInventoryBotConfig(api.pluginConfig);
    const searchClient = new OpenClawSearchClient(({ args, signal }) => api.runtime.webSearch.search({ config: api.config, args, signal }));
    return new InventoryMonitor({
        databaseFactory: () => openInventoryDatabase(api, config.persistence?.databasePath),
        registryFactory: (database) => activeAdapterRegistry(api, database),
        config,
        searchClient,
        notificationChannels: notificationChannels(api, {
            enabled: config.notifications.discord?.enabled === true,
            maxRetries: config.notifications.maxAttempts,
        }),
        log: (event) => api.logger.info(JSON.stringify(event)),
    });
}
const inventoryStatusSchema = Type.Union([
    Type.Literal("in_stock"),
    Type.Literal("out_of_stock"),
    Type.Literal("preorder"),
    Type.Literal("backorder"),
    Type.Literal("unknown"),
    Type.Literal("blocked"),
    Type.Literal("error"),
]);
const inventoryMethodSchema = Type.Union([
    Type.Literal("json_ld"),
    Type.Literal("embedded_json"),
    Type.Literal("public_api"),
    Type.Literal("html"),
    Type.Literal("network_api"),
    Type.Literal("browser"),
    Type.Literal("unknown"),
]);
const productIdentitySchema = Type.Object({
    name: Type.Optional(Type.String()),
    manufacturer: Type.Optional(Type.String()),
    sku: Type.Optional(Type.String()),
    upc: Type.Optional(Type.String()),
    mpn: Type.Optional(Type.String()),
    variant: Type.Optional(Type.String()),
    sourceUrl: Type.Optional(Type.String()),
}, { additionalProperties: false });
const generationObservationSchema = Type.Object({
    url: Type.String({ format: "uri" }),
    status: inventoryStatusSchema,
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    method: inventoryMethodSchema,
    productMatchConfidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    evidenceSummary: Type.String({ minLength: 1, maxLength: 2_000 }),
}, { additionalProperties: false });
const candidateSchema = Type.Object({
    candidateId: Type.String(),
    lifecycle: Type.Literal("candidate"),
    generatedAt: Type.String(),
    generationReason: Type.Union([
        Type.Literal("unsupported_retailer"),
        Type.Literal("repair"),
    ]),
    spec: Type.Object({
        adapterId: Type.String(),
        version: Type.String(),
        domain: Type.String(),
        strategy: Type.Literal("json_ld"),
    }, { additionalProperties: false }),
    source: Type.String({ maxLength: 100_000 }),
    sourceSha256: Type.String({ minLength: 64, maxLength: 64 }),
    basedOn: generationObservationSchema,
    requiresApproval: Type.Literal(true),
}, { additionalProperties: false });
const inventoryToolPlugin = defineToolPlugin({
    id: "inventorybot",
    name: "InventoryBot",
    description: "Discover retailers, validate deterministic adapters, and persist inventory watches and observations.",
    configSchema: Type.Object({
        adapterPromotion: Type.Optional(Type.Object({ mode: Type.Literal("manual", { default: "manual" }) }, { additionalProperties: false })),
        persistence: Type.Optional(Type.Object({
            databasePath: Type.Optional(Type.String({ description: "Intentional absolute path or non-traversing OpenClaw-state-relative SQLite path." })),
        }, { additionalProperties: false })),
        monitoring: Type.Optional(Type.Object({
            enabled: Type.Optional(Type.Boolean({ default: false })),
            fastIntervalSeconds: Type.Optional(Type.Number({ minimum: 30, maximum: 86_400, default: 120 })),
            slowIntervalHours: Type.Optional(Type.Number({ minimum: 1, maximum: 720, default: 12 })),
            rediscoveryAfterHours: Type.Optional(Type.Number({ minimum: 1, maximum: 8_760, default: 168 })),
            inspectAfterUnknownCount: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 3 })),
            timeoutMs: Type.Optional(Type.Number({ minimum: 1_000, maximum: 60_000, default: 10_000 })),
            maxConcurrency: Type.Optional(Type.Number({ minimum: 1, maximum: 20, default: 4 })),
            perDomainConcurrency: Type.Optional(Type.Number({ minimum: 1, maximum: 10, default: 1 })),
            jitterSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 3_600, default: 15 })),
            notifyWhenUnavailable: Type.Optional(Type.Boolean({ default: false })),
        }, { additionalProperties: false })),
        notifications: Type.Optional(Type.Object({
            discord: Type.Optional(Type.Object({
                enabled: Type.Optional(Type.Boolean({ default: false })),
                target: Type.String({ minLength: 1 }),
                accountId: Type.Optional(Type.String()),
                threadId: Type.Optional(Type.String()),
            }, { additionalProperties: false })),
            maxAttempts: Type.Optional(Type.Number({ minimum: 1, maximum: 20, default: 6 })),
            batchSize: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 25 })),
            baseRetrySeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 3_600, default: 30 })),
        }, { additionalProperties: false })),
    }, { additionalProperties: false }),
    tools: (tool) => [
        tool({
            name: "discover_retailers",
            description: "Find direct retailer product pages using exact identifiers first, then product-name and preferred-retailer searches. Discovery identifies candidates only; it never verifies stock or creates watches.",
            parameters: Type.Object({
                product: productIdentitySchema,
                resultsPerQuery: Type.Optional(Type.Number({ minimum: 1, maximum: 20, default: 8 })),
                preferredDomains: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })),
            }, { additionalProperties: false }),
            execute: async ({ product, resultsPerQuery, preferredDomains }, _config, { api, signal }) => {
                const searchClient = new OpenClawSearchClient(({ args, signal: searchSignal }) => api.runtime.webSearch.search({
                    config: api.config,
                    args,
                    signal: searchSignal,
                }));
                return discoverRetailers(product, searchClient, {
                    resultsPerQuery,
                    preferredDomains,
                    signal,
                });
            },
        }),
        tool({
            name: "check_inventory",
            description: "Check one product URL using an active deterministic adapter. Unsupported, blocked, and inconclusive responses are never treated as out of stock and include a recommended next action.",
            parameters: Type.Object({
                url: Type.String({ format: "uri", description: "Absolute retailer product URL." }),
                expectedProduct: Type.Optional(productIdentitySchema),
                timeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: 60_000, default: 10_000 })),
            }, { additionalProperties: false }),
            execute: async (input, config, { api, signal }) => {
                signal?.throwIfAborted();
                const database = openInventoryDatabase(api, config.persistence?.databasePath);
                try {
                    return await checkInventory({ ...input, signal }, activeAdapterRegistry(api, database));
                }
                finally {
                    database.close();
                }
            },
        }),
        tool({
            name: "inspect_retailer",
            description: "Safely inspect a public product page using static HTTP and structured metadata. Report identity evidence, observed availability, adapter readiness, blocking, and the next action; this does not guarantee current stock.",
            parameters: Type.Object({
                url: Type.String({ format: "uri" }),
                expectedProduct: Type.Optional(productIdentitySchema),
                timeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: 60_000, default: 15_000 })),
            }, { additionalProperties: false }),
            execute: async ({ url, expectedProduct, timeoutMs }, _config, { signal }) => inspectRetailerStatic(url, { expectedProduct, timeoutMs, signal }),
        }),
        tool({
            name: "generate_retailer_adapter",
            description: "Generate and persist an inactive deterministic adapter candidate only from conclusive, high-confidence JSON-LD evidence. The candidate remains untrusted and is never activated automatically.",
            parameters: Type.Object({
                domain: Type.String(),
                observations: Type.Array(generationObservationSchema, { minItems: 1, maxItems: 20 }),
                generationReason: Type.Optional(Type.Union([Type.Literal("unsupported_retailer"), Type.Literal("repair")])),
            }, { additionalProperties: false }),
            execute: async ({ domain, observations, generationReason }, config, { api, signal }) => {
                signal?.throwIfAborted();
                const result = generateRetailerAdapter(domain, observations, { generationReason });
                if (result.generated) {
                    signal?.throwIfAborted();
                    const database = openInventoryDatabase(api, config.persistence?.databasePath);
                    try {
                        database.saveAdapterCandidate(result.candidate);
                    }
                    finally {
                        database.close();
                    }
                }
                return result;
            },
        }),
        tool({
            name: "validate_retailer_adapter",
            description: "Validate an exact candidate against source policy, a sanitized fixture, live evidence, and the originating observation. Returns every gate result and remediation errors; validation never activates the adapter.",
            parameters: Type.Object({
                candidate: candidateSchema,
                testContext: Type.Object({
                    fixture: Type.Optional(Type.Object({
                        url: Type.String({ format: "uri" }),
                        html: Type.String({ maxLength: 2_000_000 }),
                        expectedProduct: Type.Optional(productIdentitySchema),
                        expectedStatus: Type.Optional(inventoryStatusSchema),
                        httpStatus: Type.Optional(Type.Number({ minimum: 100, maximum: 599 })),
                    }, { additionalProperties: false })),
                    live: Type.Optional(Type.Object({
                        url: Type.String({ format: "uri" }),
                        expectedProduct: Type.Optional(productIdentitySchema),
                        observedStatus: inventoryStatusSchema,
                        observationConfidence: Type.Number({ minimum: 0, maximum: 1 }),
                        timeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: 60_000, default: 10_000 })),
                    }, { additionalProperties: false })),
                }, { additionalProperties: false }),
            }, { additionalProperties: false }),
            execute: async ({ candidate, testContext }, config, { api, signal }) => {
                const report = await validateRetailerAdapter(candidate, {
                    ...testContext,
                    ...(testContext.live ? { live: { ...testContext.live, signal } } : {}),
                });
                signal?.throwIfAborted();
                const database = openInventoryDatabase(api, config.persistence?.databasePath);
                try {
                    signal?.throwIfAborted();
                    database.saveValidation(candidate, report);
                }
                finally {
                    database.close();
                }
                return report;
            },
        }),
        tool({
            name: "inventory_adapter_list",
            description: "Read adapter candidates, validation gates, exact fingerprints, active versions, activation readiness, and approval history.",
            parameters: Type.Object({
                adapterId: Type.Optional(Type.String({ minLength: 1 })),
                domain: Type.Optional(Type.String({ minLength: 1 })),
                lifecycle: Type.Optional(Type.String({ minLength: 1 })),
                activeOnly: Type.Optional(Type.Boolean({ default: false })),
            }, { additionalProperties: false }),
            execute: async ({ adapterId, domain, lifecycle, activeOnly }, config, { api, signal }) => {
                signal?.throwIfAborted();
                const database = openInventoryDatabase(api, config.persistence?.databasePath);
                try {
                    const normalizedDomain = domain
                        ? normalizeDomain(domain.includes("://") ? domain : `https://${domain}`)
                        : undefined;
                    const adapters = database.listAdapterApprovals(adapterId).filter((adapter) => (!normalizedDomain || domainMatches(adapter.domain, normalizedDomain)) &&
                        (!lifecycle || adapter.lifecycle === lifecycle) &&
                        (!activeOnly || adapter.lifecycle === "active"));
                    return { adapters };
                }
                finally {
                    database.close();
                }
            },
        }),
        tool({
            name: "inventory_adapter_approve",
            description: "Explicitly activate one exact validated candidate and fingerprint for future runs only; every validation gate must be promotable.",
            parameters: Type.Object({
                candidateId: Type.String({ minLength: 1 }),
                sourceSha256: Type.String({ minLength: 64, maxLength: 64 }),
                confirmActivation: Type.Literal(true),
                reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
            }, { additionalProperties: false }),
            execute: async (input, config, { api, signal }) => {
                signal?.throwIfAborted();
                const database = openInventoryDatabase(api, config.persistence?.databasePath);
                try {
                    signal?.throwIfAborted();
                    const result = approveRetailerAdapter(database, input);
                    return result.approved
                        ? { ...result, affectedWatchIds: affectedWatchIds(database, result.domain) }
                        : result;
                }
                finally {
                    database.close();
                }
            },
        }),
        tool({
            name: "inventory_adapter_revoke",
            description: "Explicitly revoke one exact active adapter version for future runs while preserving watches and observation history.",
            parameters: Type.Object({
                adapterId: Type.String({ minLength: 1 }),
                candidateId: Type.String({ minLength: 1 }),
                confirmRevocation: Type.Literal(true),
                reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
            }, { additionalProperties: false }),
            execute: async (input, config, { api, signal }) => {
                signal?.throwIfAborted();
                const database = openInventoryDatabase(api, config.persistence?.databasePath);
                try {
                    signal?.throwIfAborted();
                    const candidate = database.getAdapterCandidate(input.candidateId);
                    const result = revokeRetailerAdapter(database, input);
                    return result.revoked && candidate
                        ? {
                            ...result,
                            domain: candidate.spec.domain,
                            affectedWatchIds: affectedWatchIds(database, candidate.spec.domain),
                        }
                        : result;
                }
                finally {
                    database.close();
                }
            },
        }),
        tool({
            name: "inventory_watch_add",
            description: "Persist a reviewed product watch and direct retailer URLs, returning active-adapter readiness for every target. This does not enable scheduled monitoring or run discovery.",
            parameters: Type.Object({
                product: productIdentitySchema,
                retailers: Type.Array(Type.Object({
                    url: Type.String({ format: "uri" }),
                    enabled: Type.Optional(Type.Boolean({ default: true })),
                }, { additionalProperties: false }), { minItems: 1, maxItems: 100 }),
                enabled: Type.Optional(Type.Boolean({ default: true })),
                requireActiveAdapter: Type.Optional(Type.Boolean({ default: false })),
            }, { additionalProperties: false }),
            execute: async (input, config, { api, signal }) => {
                signal?.throwIfAborted();
                const database = openInventoryDatabase(api, config.persistence?.databasePath);
                try {
                    return new WatchService(database, activeAdapterRegistry(api, database)).add(input, { signal });
                }
                finally {
                    database.close();
                }
            },
        }),
        tool({
            name: "inventory_watch_remove",
            description: "Disable a watch by default. Permanent deletion of the watch and its observation history requires explicit confirmation.",
            parameters: Type.Object({
                watchId: Type.String({ minLength: 1 }),
                permanent: Type.Optional(Type.Boolean({ default: false })),
                confirmDeletion: Type.Optional(Type.Literal(true)),
            }, { additionalProperties: false }),
            execute: async ({ watchId, permanent, confirmDeletion }, config, { api, signal }) => {
                signal?.throwIfAborted();
                if (permanent && confirmDeletion !== true) {
                    return {
                        watchId,
                        disabled: false,
                        removed: false,
                        error: {
                            code: "WATCH_DELETION_CONFIRMATION_REQUIRED",
                            message: "Permanent deletion requires confirmDeletion: true.",
                        },
                    };
                }
                const database = openInventoryDatabase(api, config.persistence?.databasePath);
                try {
                    return new WatchService(database, adapterRegistry).remove(watchId, {
                        permanent,
                        signal,
                    });
                }
                finally {
                    database.close();
                }
            },
        }),
        tool({
            name: "inventory_watch_status",
            description: "Read one or all watches, including enabled state, active-adapter coverage, and each target's latest observation.",
            parameters: Type.Object({ watchId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
            execute: async ({ watchId }, config, { api }) => {
                const database = openInventoryDatabase(api, config.persistence?.databasePath);
                try {
                    const status = new WatchService(database, activeAdapterRegistry(api, database)).status(watchId);
                    return status ?? {
                        error: { code: "WATCH_NOT_FOUND", message: `No watch exists with id ${watchId}.` },
                    };
                }
                finally {
                    database.close();
                }
            },
        }),
        tool({
            name: "inventory_watch_run",
            description: "Run one persisted watch using active deterministic adapters only. Persist observations, isolate target failures, optionally suppress notifications for testing, and never invoke discovery or generation.",
            parameters: Type.Object({
                watchId: Type.String({ minLength: 1 }),
                timeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: 60_000, default: 10_000 })),
                notifyWhenUnavailable: Type.Optional(Type.Boolean({ default: false })),
                deliverNotifications: Type.Optional(Type.Boolean({ default: true })),
            }, { additionalProperties: false }),
            execute: async ({ watchId, timeoutMs, notifyWhenUnavailable, deliverNotifications }, config, { api, signal }) => {
                signal?.throwIfAborted();
                const database = openInventoryDatabase(api, config.persistence?.databasePath);
                const service = new WatchService(database, activeAdapterRegistry(api, database), (record) => api.logger.info(JSON.stringify({ event: "inventory_check", ...record })));
                try {
                    const parsed = parseInventoryBotConfig(config);
                    const discord = parsed.notifications.discord;
                    return await service.run(watchId, {
                        timeoutMs,
                        notifyWhenUnavailable,
                        signal,
                        ...(discord?.enabled && deliverNotifications !== false
                            ? {
                                notification: {
                                    channel: "discord",
                                    target: discord.target,
                                    accountId: discord.accountId,
                                    threadId: discord.threadId,
                                },
                            }
                            : {}),
                    });
                }
                finally {
                    database.close();
                }
            },
        }),
        tool({
            name: "inventory_monitor_status",
            description: "Report scheduler configuration, database health, active-adapter coverage, recent fast and slow runs, and notification queue status.",
            parameters: Type.Object({}, { additionalProperties: false }),
            execute: async (_input, config, { api }) => {
                const parsed = parseInventoryBotConfig(config);
                const database = openInventoryDatabase(api, parsed.persistence?.databasePath);
                try {
                    const watches = database.listWatches();
                    const registry = activeAdapterRegistry(api, database);
                    const targets = watches.flatMap(({ retailers }) => retailers);
                    const coveredTargets = targets.filter(({ url }) => registry.get(url)).length;
                    return {
                        schemaVersion: database.schemaVersion(),
                        database: database.healthStatus(),
                        configured: {
                            enabled: parsed.monitoring.enabled,
                            fastIntervalSeconds: parsed.monitoring.fastIntervalSeconds,
                            slowIntervalHours: parsed.monitoring.slowIntervalHours,
                            discordEnabled: parsed.notifications.discord?.enabled === true,
                        },
                        adapterCoverage: {
                            watches: watches.length,
                            targets: targets.length,
                            coveredTargets,
                            uncoveredTargets: targets.length - coveredTargets,
                        },
                        recentRuns: database.monitorStatus(),
                        notifications: database.notificationStatus(),
                    };
                }
                finally {
                    database.close();
                }
            },
        }),
        tool({
            name: "inventory_monitor_run_fast",
            description: "Run the fast inventory loop using active adapters only. Persist observations, never perform discovery or generation, and allow notification delivery to be suppressed for testing.",
            parameters: Type.Object({
                deliverNotifications: Type.Optional(Type.Boolean({ default: true })),
                watchIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100 })),
            }, { additionalProperties: false }),
            execute: async ({ deliverNotifications, watchIds }, _config, { api, signal }) => createMonitor(api).runFast({ signal, deliverNotifications, watchIds }),
        }),
        tool({
            name: "inventory_monitor_run_slow",
            description: "Run bounded stale discovery and inspection. Persist retailer and inactive adapter candidates, but never add watch targets or activate adapters automatically.",
            parameters: Type.Object({
                watchIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100 })),
                dryRun: Type.Optional(Type.Boolean({ default: false })),
            }, { additionalProperties: false }),
            execute: async ({ watchIds, dryRun }, _config, { api, signal }) => createMonitor(api).runSlow({ signal, watchIds, dryRun }),
        }),
        tool({
            name: "inventory_notification_test",
            description: "Preview or send a real test notification through OpenClaw's durable Discord queue. Actual delivery requires confirmSend: true.",
            optional: true,
            parameters: Type.Object({
                dryRun: Type.Optional(Type.Boolean({ default: true })),
                confirmSend: Type.Optional(Type.Literal(true)),
            }, { additionalProperties: false }),
            execute: async ({ dryRun, confirmSend }, config, { api, signal }) => {
                const parsed = parseInventoryBotConfig(config);
                const discord = parsed.notifications.discord;
                if (!discord?.enabled) {
                    return {
                        delivered: false,
                        error: { code: "DISCORD_NOT_CONFIGURED", message: "Enable notifications.discord." },
                    };
                }
                const preview = {
                    channel: "discord",
                    target: discord.target,
                    accountId: discord.accountId,
                    threadId: discord.threadId,
                    message: "InventoryBot test notification",
                };
                if (dryRun !== false)
                    return { dryRun: true, delivered: false, preview };
                if (confirmSend !== true) {
                    return {
                        dryRun: false,
                        delivered: false,
                        preview,
                        error: {
                            code: "NOTIFICATION_TEST_CONFIRMATION_REQUIRED",
                            message: "Sending a real test notification requires confirmSend: true.",
                        },
                    };
                }
                const channel = new OpenClawDiscordChannel(api.config, {
                    maxRetries: parsed.notifications.maxAttempts,
                });
                const result = await channel.send({
                    id: 0,
                    fingerprint: `test:${Date.now()}`,
                    channel: "discord",
                    target: discord.target,
                    accountId: discord.accountId,
                    threadId: discord.threadId,
                    attemptCount: 1,
                    payload: {
                        kind: "test",
                        productName: "InventoryBot",
                        currentStatus: "test",
                        checkedAt: new Date().toISOString(),
                    },
                }, { signal });
                return {
                    accepted: result.status === "delivered" || result.status === "handed_off",
                    delivered: result.status === "delivered",
                    delivery: result,
                    preview,
                };
            },
        }),
    ],
});
export default definePluginEntry({
    id: "inventorybot",
    name: "InventoryBot",
    description: "Discover retailers, validate adapters, schedule inventory watches, and deliver transition notifications.",
    configSchema: inventoryToolPlugin.configSchema,
    register(api) {
        inventoryToolPlugin.register?.(api);
        if (api.registrationMode !== "full")
            return;
        let monitor;
        api.registerService({
            id: "inventorybot-monitor",
            start() {
                monitor = createMonitor(api);
                monitor.start();
            },
            async stop() {
                const active = monitor;
                monitor = undefined;
                await active?.stop();
            },
        });
    },
});
