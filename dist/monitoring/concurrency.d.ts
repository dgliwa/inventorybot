export declare class DomainConcurrencyLimiter {
    #private;
    private readonly limit;
    constructor(limit: number);
    run<T>(domain: string, operation: () => Promise<T>): Promise<T>;
}
