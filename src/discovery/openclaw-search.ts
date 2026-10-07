import type { RetailerSearchClient, SearchResult } from "./types.js";

type RuntimeSearch = (params: {
  args: Record<string, unknown>;
  signal?: AbortSignal;
}) => Promise<{ provider: string; result: Record<string, unknown> }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function resultItems(payload: Record<string, unknown>): unknown[] {
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.items)) return payload.items;
  if (isRecord(payload.data)) {
    if (Array.isArray(payload.data.results)) return payload.data.results;
    if (Array.isArray(payload.data.items)) return payload.data.items;
  }
  return [];
}

export function normalizeSearchResults(payload: Record<string, unknown>): SearchResult[] {
  return resultItems(payload).flatMap((item) => {
    if (!isRecord(item)) return [];
    const url = text(item.url) ?? text(item.link);
    if (!url) return [];
    return [{
      url,
      title: text(item.title) ?? text(item.name),
      snippet: text(item.snippet) ?? text(item.description) ?? text(item.content),
    }];
  });
}

export class OpenClawSearchClient implements RetailerSearchClient {
  constructor(private readonly runtimeSearch: RuntimeSearch) {}

  async search(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const response = await this.runtimeSearch({ args: { query, count }, signal });
    return normalizeSearchResults(response.result);
  }
}
