export declare const WISHLIST_STATUSES: readonly ["idea", "researching", "wanted", "acquired", "paused", "archived"];
export type WishlistStatus = typeof WISHLIST_STATUSES[number];
export declare const WISHLIST_PRIORITIES: readonly ["low", "normal", "high"];
export type WishlistPriority = typeof WISHLIST_PRIORITIES[number];
export declare const WISHLIST_LINK_KINDS: readonly ["retailer", "manufacturer", "review", "comparison", "reference", "other"];
export type WishlistLinkKind = typeof WISHLIST_LINK_KINDS[number];
export type WishlistItem = {
    id: string;
    name: string;
    category?: string;
    priority: WishlistPriority;
    status: WishlistStatus;
    desiredQuantity: number;
    notes?: string;
    tags: string[];
    createdAt: string;
    updatedAt: string;
};
export type WishlistTransition = {
    id: number;
    itemId: string;
    fromStatus?: WishlistStatus;
    toStatus: WishlistStatus;
    reason?: string;
    occurredAt: string;
};
export type WishlistLink = {
    id: string;
    itemId: string;
    url: string;
    kind: WishlistLinkKind;
    label?: string;
    price?: number;
    currency?: string;
    createdAt: string;
    updatedAt: string;
};
export type WishlistPurchase = {
    id: string;
    itemId: string;
    quantity: number;
    unitPrice?: number;
    currency?: string;
    seller?: string;
    purchasedAt: string;
    notes?: string;
    createdAt: string;
    updatedAt: string;
};
export type WishlistMonitor = {
    kind: "inventory" | "search";
    watchId: string;
    enabled: boolean;
};
export type WishlistItemDetail = WishlistItem & {
    acquiredQuantity: number;
    remainingQuantity: number;
    watching: boolean;
    displayState: string;
    links: WishlistLink[];
    purchases: WishlistPurchase[];
    transitions: WishlistTransition[];
    monitors: WishlistMonitor[];
};
