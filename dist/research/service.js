import { randomUUID } from "node:crypto";
import { WishlistService } from "../wishlist/service.js";
import { RESEARCH_SELLER_TYPES, RESEARCH_TOPIC_STATUSES, RESEARCH_VERDICTS, } from "./types.js";
export class ResearchValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "ResearchValidationError";
    }
}
function nonBlank(value, field) {
    const normalized = value.trim();
    if (!normalized)
        throw new ResearchValidationError(`${field} must not be blank`);
    return normalized;
}
function optionalText(value, field) {
    if (value === undefined || value === null)
        return value;
    return nonBlank(value, field);
}
function absoluteHttpUrl(value, field) {
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        throw new ResearchValidationError(`${field} must be an absolute HTTP(S) URL`);
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw new ResearchValidationError(`${field} must be an absolute HTTP(S) URL without credentials`);
    }
    parsed.hash = "";
    return parsed.toString();
}
function boundedInteger(value, field, minimum, maximum) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new ResearchValidationError(`${field} must be an integer from ${minimum} to ${maximum}`);
    }
    return value;
}
function rating(value) {
    if (!Number.isFinite(value) || value < 0 || value > 5) {
        throw new ResearchValidationError("minimumSellerRating and sellerRating must be from 0 to 5");
    }
    return value;
}
function nonnegative(value, field) {
    if (!Number.isFinite(value) || value < 0) {
        throw new ResearchValidationError(`${field} must be zero or greater`);
    }
    return value;
}
function addDays(timestamp, days) {
    return new Date(Date.parse(timestamp) + days * 86_400_000).toISOString();
}
export class ResearchService {
    database;
    now;
    constructor(database, now = () => new Date()) {
        this.database = database;
        this.now = now;
    }
    add(input) {
        const timestamp = this.now().toISOString();
        const status = input.status ?? "active";
        if (!RESEARCH_TOPIC_STATUSES.includes(status))
            throw new ResearchValidationError("invalid research topic status");
        const name = nonBlank(input.name, "name");
        const topic = {
            id: randomUUID(),
            name,
            query: nonBlank(input.query ?? name, "query"),
            ...(input.category ? { category: nonBlank(input.category, "category") } : {}),
            ...(input.notes ? { notes: nonBlank(input.notes, "notes") } : {}),
            status,
            refreshIntervalDays: boundedInteger(input.refreshIntervalDays ?? 30, "refreshIntervalDays", 1, 3650),
            minimumSellerRating: rating(input.minimumSellerRating ?? 4),
            allowMarketplaceSellers: input.allowMarketplaceSellers ?? false,
            nextRefreshAt: timestamp,
            createdAt: timestamp,
            updatedAt: timestamp,
        };
        this.database.createResearchTopic(topic);
        return this.status(topic.id);
    }
    update(topicId, input) {
        const current = this.requireTopic(topicId);
        if (input.status !== undefined && !RESEARCH_TOPIC_STATUSES.includes(input.status)) {
            throw new ResearchValidationError("invalid research topic status");
        }
        const refreshIntervalDays = input.refreshIntervalDays === undefined
            ? current.refreshIntervalDays
            : boundedInteger(input.refreshIntervalDays, "refreshIntervalDays", 1, 3650);
        this.database.updateResearchTopic(topicId, {
            ...(input.name !== undefined ? { name: nonBlank(input.name, "name") } : {}),
            ...(input.query !== undefined ? { query: nonBlank(input.query, "query") } : {}),
            ...(input.category !== undefined ? { category: optionalText(input.category, "category") } : {}),
            ...(input.notes !== undefined ? { notes: optionalText(input.notes, "notes") } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.refreshIntervalDays !== undefined ? { refreshIntervalDays } : {}),
            ...(input.minimumSellerRating !== undefined
                ? { minimumSellerRating: rating(input.minimumSellerRating) }
                : {}),
            ...(input.allowMarketplaceSellers !== undefined
                ? { allowMarketplaceSellers: input.allowMarketplaceSellers }
                : {}),
            ...(current.lastCompletedAt && input.refreshIntervalDays !== undefined
                ? { nextRefreshAt: addDays(current.lastCompletedAt, refreshIntervalDays) }
                : {}),
            updatedAt: this.now().toISOString(),
        });
        return this.status(topicId);
    }
    due(limit = 20) {
        return this.database
            .listDueResearchTopics(this.now().toISOString(), boundedInteger(limit, "limit", 1, 100))
            .map((topic) => this.buildStatus(topic));
    }
    status(topicId) {
        return this.buildStatus(this.requireTopic(topicId));
    }
    list(options = {}) {
        if (options.status !== undefined && !RESEARCH_TOPIC_STATUSES.includes(options.status)) {
            throw new ResearchValidationError("invalid research topic status");
        }
        return this.database.listResearchTopics({
            status: options.status ?? (options.dueOnly ? "active" : undefined),
            dueBefore: options.dueOnly ? this.now().toISOString() : undefined,
            query: options.query ? nonBlank(options.query, "query") : undefined,
            limit: boundedInteger(options.limit ?? 50, "limit", 1, 100),
        }).map((topic) => this.buildStatus(topic));
    }
    record(topicId, input) {
        const topic = this.requireTopic(topicId);
        if (topic.status !== "active")
            throw new ResearchValidationError("research topic must be active to record a run");
        if (input.candidates.length < 1 || input.candidates.length > 50) {
            throw new ResearchValidationError("candidates must contain 1 to 50 entries");
        }
        const runId = randomUUID();
        const candidates = input.candidates.map((candidate) => this.normalizeCandidate(runId, candidate));
        if (new Set(candidates.map(({ url }) => url)).size !== candidates.length) {
            throw new ResearchValidationError("candidate URLs must be unique within a run");
        }
        const recommendations = candidates.filter(({ verdict }) => verdict === "recommended");
        if (recommendations.length !== 1) {
            throw new ResearchValidationError("each research run must contain exactly one recommended candidate");
        }
        for (const candidate of candidates.filter(({ verdict }) => verdict !== "rejected")) {
            this.validatePositiveCandidate(candidate, topic);
        }
        const researchedAt = this.now().toISOString();
        const prior = this.database.getLatestResearchRun(topicId);
        const priorRecommendedUrl = prior?.candidates.find(({ id }) => id === prior.recommendedCandidateId)?.url;
        this.database.createResearchRun({
            run: {
                id: runId,
                topicId,
                summary: nonBlank(input.summary, "summary"),
                recommendedCandidateId: recommendations[0].id,
                recommendationChanged: Boolean(priorRecommendedUrl && priorRecommendedUrl !== recommendations[0].url),
                researchedAt,
                nextRefreshAt: addDays(researchedAt, topic.refreshIntervalDays),
                candidates,
            },
            updatedAt: researchedAt,
        });
        return this.status(topicId);
    }
    promote(topicId, input) {
        const topic = this.requireTopic(topicId);
        const candidate = this.database.getResearchCandidate(topicId, input.candidateId);
        if (!candidate)
            throw new ResearchValidationError(`unknown candidate ID ${input.candidateId} for research topic ${topicId}`);
        if (candidate.verdict === "rejected")
            throw new ResearchValidationError("rejected research candidates cannot be promoted");
        if (input.existingWishlistItemId && input.wishlist) {
            throw new ResearchValidationError("provide existingWishlistItemId or wishlist fields, not both");
        }
        const wishlist = new WishlistService(this.database, this.now);
        let item = input.existingWishlistItemId
            ? wishlist.status({ itemId: input.existingWishlistItemId })[0]
            : wishlist.add({
                name: input.wishlist?.name ?? candidate.title,
                ...(input.wishlist?.category ?? topic.category
                    ? { category: input.wishlist?.category ?? topic.category }
                    : {}),
                priority: input.wishlist?.priority ?? "normal",
                status: input.wishlist?.status ?? "wanted",
                desiredQuantity: input.wishlist?.desiredQuantity ?? 1,
                notes: input.wishlist?.notes ?? `Selected from research topic: ${topic.name}`,
                tags: input.wishlist?.tags ?? [],
            });
        if (!item)
            throw new ResearchValidationError(`unknown wishlist item ID ${input.existingWishlistItemId}`);
        if (!item.links.some(({ url }) => url === candidate.url)) {
            item = wishlist.addLink(item.id, {
                url: candidate.url,
                kind: "retailer",
                label: `Selected from research: ${topic.name}`,
                ...(candidate.price !== undefined ? { price: candidate.price } : {}),
                ...(candidate.currency ? { currency: candidate.currency } : {}),
            });
        }
        const promotedAt = this.now().toISOString();
        this.database.createResearchPromotion({
            id: randomUUID(),
            topicId,
            candidateId: candidate.id,
            wishlistItemId: item.id,
            continueResearch: input.continueResearch,
            promotedAt,
        });
        this.database.updateResearchTopic(topicId, {
            status: input.continueResearch ? "active" : "paused",
            updatedAt: promotedAt,
        });
        return { research: this.status(topicId), wishlistItem: item };
    }
    normalizeCandidate(runId, input) {
        if (!RESEARCH_SELLER_TYPES.includes(input.sellerType))
            throw new ResearchValidationError("invalid sellerType");
        if (!RESEARCH_VERDICTS.includes(input.verdict))
            throw new ResearchValidationError("invalid verdict");
        if (!input.evidence.length || input.evidence.length > 20) {
            throw new ResearchValidationError("each candidate requires 1 to 20 evidence sources");
        }
        return {
            id: randomUUID(),
            runId,
            url: absoluteHttpUrl(input.url, "candidate url"),
            title: nonBlank(input.title, "title"),
            ...(input.brand ? { brand: nonBlank(input.brand, "brand") } : {}),
            ...(input.seller ? { seller: nonBlank(input.seller, "seller") } : {}),
            sellerType: input.sellerType,
            ...(input.sellerRating !== undefined ? { sellerRating: rating(input.sellerRating) } : {}),
            ...(input.reviewCount !== undefined
                ? { reviewCount: boundedInteger(input.reviewCount, "reviewCount", 0, 1_000_000_000) }
                : {}),
            ...(input.price !== undefined ? { price: nonnegative(input.price, "price") } : {}),
            ...(input.currency ? { currency: nonBlank(input.currency, "currency").toUpperCase() } : {}),
            verdict: input.verdict,
            rationale: nonBlank(input.rationale, "rationale"),
            evidence: input.evidence.map((source) => ({
                url: absoluteHttpUrl(source.url, "evidence url"),
                ...(source.label ? { label: nonBlank(source.label, "evidence label") } : {}),
                ...(source.claim ? { claim: nonBlank(source.claim, "evidence claim") } : {}),
            })),
        };
    }
    validatePositiveCandidate(candidate, topic) {
        if (["marketplace", "unknown"].includes(candidate.sellerType) && !topic.allowMarketplaceSellers) {
            throw new ResearchValidationError(`${candidate.verdict} candidates must use a manufacturer, household retailer, or reputable boutique`);
        }
        if (candidate.sellerType === "marketplace" && candidate.sellerRating === undefined) {
            throw new ResearchValidationError("marketplace candidates require a seller rating");
        }
        if (candidate.sellerRating !== undefined && candidate.sellerRating < topic.minimumSellerRating) {
            throw new ResearchValidationError(`${candidate.verdict} candidate seller rating is below the configured minimum`);
        }
    }
    requireTopic(topicId) {
        const topic = this.database.getResearchTopic(topicId);
        if (!topic)
            throw new ResearchValidationError(`unknown research topic ID ${topicId}`);
        return topic;
    }
    buildStatus(topic) {
        const latestRun = this.database.getLatestResearchRun(topic.id);
        return {
            topic,
            ...(latestRun ? { latestRun } : {}),
            promotions: this.database.listResearchPromotions(topic.id),
            runCount: this.database.countResearchRuns(topic.id),
            due: topic.status === "active" && topic.nextRefreshAt <= this.now().toISOString(),
            researchInstructions: [
                `Research broadly and currently for: ${topic.query}.`,
                "Prioritize official manufacturers, household-name retailers, and reputable boutique brands or shops.",
                `Exclude low-rated sellers and generic marketplace storefronts${topic.allowMarketplaceSellers ? " unless they meet the configured quality threshold" : ""}.`,
                "Compare current products, availability, pricing, credible reviews, and multiple independent sources.",
                "Research candidates are ideas only; never replace a promoted wishlist selection unless Derek explicitly promotes a different candidate.",
            ],
        };
    }
}
