export type HostResolver = (hostname: string) => Promise<string[]>;
export declare function assertPublicHttpUrl(value: string, resolver?: HostResolver): Promise<URL>;
