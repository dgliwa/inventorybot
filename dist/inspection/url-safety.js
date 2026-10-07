import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
const resolveHost = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map(({ address }) => address);
function isPrivateIpv4(address) {
    const [a, b] = address.split(".").map(Number);
    return (a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        a >= 224);
}
function isPrivateIp(address) {
    if (isIP(address) === 4)
        return isPrivateIpv4(address);
    if (isIP(address) !== 6)
        return true;
    const normalized = address.toLocaleLowerCase();
    const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    return (normalized === "::" ||
        normalized === "::1" ||
        normalized.startsWith("fc") ||
        normalized.startsWith("fd") ||
        normalized.startsWith("fe8") ||
        normalized.startsWith("fe9") ||
        normalized.startsWith("fea") ||
        normalized.startsWith("feb") ||
        (mappedIpv4 !== undefined && isPrivateIpv4(mappedIpv4)));
}
export async function assertPublicHttpUrl(value, resolver = resolveHost) {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Only HTTP(S) retailer URLs are allowed.");
    }
    if (url.username || url.password) {
        throw new Error("Retailer URLs must not contain credentials.");
    }
    if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
        throw new Error("Local retailer URLs are not allowed.");
    }
    const addresses = isIP(url.hostname) ? [url.hostname] : await resolver(url.hostname);
    if (addresses.length === 0 || addresses.some(isPrivateIp)) {
        throw new Error("Retailer URL resolves to a local or private address.");
    }
    return url;
}
