import type { ProductIdentity } from "../domain/product.js";

export type RetailerMatchKind = "sku" | "upc" | "mpn" | "name" | "source_url";
export type SellerType = "manufacturer" | "retailer" | "marketplace" | "unknown";

export type RetailerCandidate = {
  domain: string;
  url: string;
  confidence: number;
  matchedBy: RetailerMatchKind;
  sellerType?: SellerType;
  preferred: boolean;
};

export type SearchResult = {
  url: string;
  title?: string;
  snippet?: string;
};

export interface RetailerSearchClient {
  search(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]>;
}

export type DiscoveryResult = {
  product: ProductIdentity;
  queries: string[];
  candidates: RetailerCandidate[];
  errors: Array<{ query: string; code: string; message: string; nextAction?: string }>;
  inventoryVerified: false;
};
