import type { InventoryDatabase } from "../persistence/db.js";
import { WishlistService } from "../wishlist/service.js";
import type { WishlistPriority, WishlistStatus } from "../wishlist/types.js";
import { type ResearchEvidence, type ResearchSellerType, type ResearchStatus, type ResearchTopicStatus, type ResearchVerdict } from "./types.js";
export declare class ResearchValidationError extends Error {
    constructor(message: string);
}
export declare class ResearchService {
    private readonly database;
    private readonly now;
    constructor(database: InventoryDatabase, now?: () => Date);
    add(input: {
        name: string;
        query?: string;
        category?: string;
        notes?: string;
        status?: ResearchTopicStatus;
        refreshIntervalDays?: number;
        minimumSellerRating?: number;
        allowMarketplaceSellers?: boolean;
    }): ResearchStatus;
    update(topicId: string, input: {
        name?: string;
        query?: string;
        category?: string | null;
        notes?: string | null;
        status?: ResearchTopicStatus;
        refreshIntervalDays?: number;
        minimumSellerRating?: number;
        allowMarketplaceSellers?: boolean;
    }): ResearchStatus;
    due(limit?: number): ResearchStatus[];
    status(topicId: string): ResearchStatus;
    list(options?: {
        status?: ResearchTopicStatus;
        dueOnly?: boolean;
        query?: string;
        limit?: number;
    }): ResearchStatus[];
    record(topicId: string, input: {
        summary: string;
        candidates: Array<{
            url: string;
            title: string;
            brand?: string;
            seller?: string;
            sellerType: ResearchSellerType;
            sellerRating?: number;
            reviewCount?: number;
            price?: number;
            currency?: string;
            verdict: ResearchVerdict;
            rationale: string;
            evidence: ResearchEvidence[];
        }>;
    }): ResearchStatus;
    promote(topicId: string, input: {
        candidateId: string;
        continueResearch: boolean;
        existingWishlistItemId?: string;
        wishlist?: {
            name?: string;
            category?: string;
            priority?: WishlistPriority;
            status?: WishlistStatus;
            desiredQuantity?: number;
            notes?: string;
            tags?: string[];
        };
    }): {
        research: ResearchStatus;
        wishlistItem: ReturnType<WishlistService["status"]>[number];
    };
    private normalizeCandidate;
    private validatePositiveCandidate;
    private requireTopic;
    private buildStatus;
}
