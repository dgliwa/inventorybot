import { ExampleJsonLdAdapter, type HttpFetch } from "../adapters/builtins/example-jsonld.js";
import type { InventoryResult } from "../domain/inventory.js";
import { normalizeInventoryResult } from "../domain/inventory.js";
import type { InventoryCheckContext, RetailerAdapter } from "../adapters/types.js";
import { domainMatches, normalizeDomain } from "../adapters/url.js";
import { assertPublicHttpUrl } from "../inspection/url-safety.js";

export type GeneratedJsonLdAdapterConfig = {
  id: string;
  version: string;
  domains: string[];
};

async function boundedResponse(response: Response, maximumBytes = 2_000_000): Promise<Response> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`Retailer response exceeds ${maximumBytes} bytes.`);
  }
  if (!response.body) return response;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error(`Retailer response exceeds ${maximumBytes} bytes.`);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function guardedDomainFetch(domains: string[], baseFetch: HttpFetch = fetch): HttpFetch {
  return async (input, init = {}) => {
    if (init.method && init.method.toLocaleUpperCase() !== "GET") {
      throw new Error("Generated adapters may only perform HTTP GET requests.");
    }

    let url = input instanceof Request ? input.url : String(input);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const parsed = await assertPublicHttpUrl(url);
      const domain = normalizeDomain(parsed.toString());
      if (!domains.some((allowed) => domainMatches(domain, allowed))) {
        throw new Error(`Outbound host is outside the adapter domain: ${domain}`);
      }

      const response = await baseFetch(parsed, { ...init, method: "GET", redirect: "manual" });
      if (response.status < 300 || response.status >= 400) return boundedResponse(response);
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new Error("Too many or invalid HTTP redirects.");
      url = new URL(location, parsed).toString();
    }
    throw new Error("Redirect handling failed.");
  };
}

class GeneratedJsonLdAdapter implements RetailerAdapter {
  readonly id: string;
  readonly version: string;
  readonly domains: string[];
  readonly #delegate: ExampleJsonLdAdapter;

  constructor(config: GeneratedJsonLdAdapterConfig, httpFetch?: HttpFetch) {
    this.id = config.id;
    this.version = config.version;
    this.domains = [...config.domains];
    this.#delegate = new ExampleJsonLdAdapter(httpFetch ?? guardedDomainFetch(this.domains));
  }

  canHandle(url: string): boolean {
    try {
      const domain = normalizeDomain(url);
      return this.domains.some((allowed) => domainMatches(domain, allowed));
    } catch {
      return false;
    }
  }

  async checkInventory(
    url: string,
    context: InventoryCheckContext = {},
  ): Promise<InventoryResult> {
    if (!this.canHandle(url)) {
      let domain = "";
      try { domain = normalizeDomain(url); } catch { /* Invalid URL. */ }
      return normalizeInventoryResult({
        status: "unknown",
        confidence: 1,
        domain,
        url,
        method: "unknown",
        evidence: { summary: "The URL is outside this generated adapter's domain." },
        error: { code: "UNSUPPORTED_RETAILER", message: "Adapter domain mismatch." },
      });
    }
    return this.#delegate.checkInventory(url, context);
  }
}

export function createGeneratedJsonLdAdapter(
  config: GeneratedJsonLdAdapterConfig,
  httpFetch?: HttpFetch,
): RetailerAdapter {
  return new GeneratedJsonLdAdapter(config, httpFetch);
}
