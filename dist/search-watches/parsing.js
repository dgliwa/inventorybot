export class SearchAdapterDiscoveryError extends Error {
    code;
    nextAction;
    constructor(code, message, nextAction) {
        super(message);
        this.code = code;
        this.nextAction = nextAction;
        this.name = "SearchAdapterDiscoveryError";
    }
}
export function decodeHtml(value) {
    return value
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}
export function textContent(value) {
    return decodeHtml(value.replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ")
        .trim();
}
function clean(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
export function matchesQuery(result, query) {
    const tokens = clean(query).split(" ").filter((token) => token.length > 1);
    const haystack = clean(`${result.title ?? ""} ${result.snippet ?? ""} ${result.url}`);
    return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
}
export async function readBounded(response, maximumBytes = 5_000_000) {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maximumBytes) {
        throw new SearchAdapterDiscoveryError("SEARCH_RESPONSE_TOO_LARGE", `Retailer response exceeds ${maximumBytes} bytes.`, "Use a narrower static search endpoint or add bounded API support.");
    }
    if (!response.body)
        return "";
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    let body = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        total += value.byteLength;
        if (total > maximumBytes) {
            await reader.cancel();
            throw new SearchAdapterDiscoveryError("SEARCH_RESPONSE_TOO_LARGE", `Retailer response exceeds ${maximumBytes} bytes.`, "Use a narrower static search endpoint or add bounded API support.");
        }
        body += decoder.decode(value, { stream: true });
    }
    return body + decoder.decode();
}
