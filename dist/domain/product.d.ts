export type ProductIdentity = {
    name?: string;
    manufacturer?: string;
    sku?: string;
    upc?: string;
    mpn?: string;
    variant?: string;
    sourceUrl?: string;
};
export type ProductMatch = {
    matches: boolean;
    confidence: number;
    matchedIdentifiers: string[];
};
export declare function matchProductIdentity(expected: ProductIdentity, actual: ProductIdentity): ProductMatch;
