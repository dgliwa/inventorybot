export function normalizeDomain(url: string): string {
  const hostname = new URL(url).hostname.toLocaleLowerCase();
  return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}

export function domainMatches(hostname: string, registeredDomain: string): boolean {
  const normalizedHostname = hostname.toLocaleLowerCase().replace(/^www\./, "");
  const normalizedRegistered = registeredDomain
    .toLocaleLowerCase()
    .replace(/^www\./, "");

  return (
    normalizedHostname === normalizedRegistered ||
    normalizedHostname.endsWith(`.${normalizedRegistered}`)
  );
}
