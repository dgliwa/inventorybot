export function normalizeDomain(url) {
    const hostname = new URL(url).hostname.toLocaleLowerCase();
    return hostname.startsWith("www.") ? hostname.slice(4) : hostname;
}
export function domainMatches(hostname, registeredDomain) {
    const normalizedHostname = hostname.toLocaleLowerCase().replace(/^www\./, "");
    const normalizedRegistered = registeredDomain
        .toLocaleLowerCase()
        .replace(/^www\./, "");
    return (normalizedHostname === normalizedRegistered ||
        normalizedHostname.endsWith(`.${normalizedRegistered}`));
}
