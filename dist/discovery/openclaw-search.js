const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : undefined;
function resultItems(payload) {
    if (Array.isArray(payload.results))
        return payload.results;
    if (Array.isArray(payload.items))
        return payload.items;
    if (isRecord(payload.data)) {
        if (Array.isArray(payload.data.results))
            return payload.data.results;
        if (Array.isArray(payload.data.items))
            return payload.data.items;
    }
    return [];
}
export function normalizeSearchResults(payload) {
    return resultItems(payload).flatMap((item) => {
        if (!isRecord(item))
            return [];
        const url = text(item.url) ?? text(item.link);
        if (!url)
            return [];
        return [{
                url,
                title: text(item.title) ?? text(item.name),
                snippet: text(item.snippet) ?? text(item.description) ?? text(item.content),
            }];
    });
}
export class OpenClawSearchClient {
    runtimeSearch;
    constructor(runtimeSearch) {
        this.runtimeSearch = runtimeSearch;
    }
    async search(query, count, signal) {
        const response = await this.runtimeSearch({ args: { query, count }, signal });
        return normalizeSearchResults(response.result);
    }
}
