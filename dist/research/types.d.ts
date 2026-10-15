export declare const RESEARCH_TOPIC_STATUSES: readonly ["active", "paused", "archived"];
export type ResearchTopicStatus = typeof RESEARCH_TOPIC_STATUSES[number];
export declare const RESEARCH_SELLER_TYPES: readonly ["manufacturer", "household_retailer", "boutique", "marketplace", "unknown"];
export type ResearchSellerType = typeof RESEARCH_SELLER_TYPES[number];
export declare const RESEARCH_VERDICTS: readonly ["recommended", "alternative", "rejected"];
export type ResearchVerdict = typeof RESEARCH_VERDICTS[number];
export type ResearchTopic = {
    id: string;
    name: string;
    query: string;
    category?: string;
    notes?: string;
    status: ResearchTopicStatus;
    refreshIntervalDays: number;
    minimumSellerRating: number;
    allowMarketplaceSellers: boolean;
    lastCompletedAt?: string;
    nextRefreshAt: string;
    createdAt: string;
    updatedAt: string;
};
export type ResearchEvidence = {
    url: string;
    label?: string;
    claim?: string;
};
export type ResearchCandidate = {
    id: string;
    runId: string;
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
};
export type ResearchRun = {
    id: string;
    topicId: string;
    summary: string;
    recommendedCandidateId: string;
    recommendationChanged: boolean;
    researchedAt: string;
    nextRefreshAt: string;
    candidates: ResearchCandidate[];
};
export type ResearchPromotion = {
    id: string;
    topicId: string;
    candidateId: string;
    wishlistItemId: string;
    continueResearch: boolean;
    promotedAt: string;
};
export type ResearchStatus = {
    topic: ResearchTopic;
    latestRun?: ResearchRun;
    promotions: ResearchPromotion[];
    runCount: number;
    due: boolean;
    researchInstructions: string[];
};
