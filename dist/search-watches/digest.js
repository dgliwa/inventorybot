function localDate(now) {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}
function digestGroups(events) {
    const groups = new Map();
    for (const event of events) {
        const key = `${event.watchId}:${event.domain}:${event.query}`;
        let group = groups.get(key);
        if (!group) {
            group = {
                watchId: event.watchId,
                retailerDomain: event.domain,
                searchQuery: event.query,
                results: [],
            };
            groups.set(key, group);
        }
        const existing = group.results.find(result => result.url === event.url);
        if (existing) {
            existing.title = event.title ?? event.url;
            if (event.snippet)
                existing.snippet = event.snippet;
            existing.discoveryKind = event.kind;
            existing.observedAt = event.observedAt;
            existing.present = event.present;
            existing.activityCount += 1;
            continue;
        }
        group.results.push({
            title: event.title ?? event.url,
            url: event.url,
            ...(event.snippet ? { snippet: event.snippet } : {}),
            discoveryKind: event.kind,
            observedAt: event.observedAt,
            firstObservedAt: event.observedAt,
            activityCount: 1,
            present: event.present,
            listingKind: "catalog_listing",
            availability: "not_checked",
        });
    }
    return [...groups.values()];
}
export class DiscoveryDigestService {
    database;
    now;
    constructor(database, now = () => new Date()) {
        this.database = database;
        this.now = now;
    }
    run(options = {}) {
        const now = this.now();
        const date = localDate(now);
        const digestHour = options.digestHourLocal ?? 9;
        if (!options.force && now.getHours() < digestHour) {
            return { localDate: date, alreadyCompleted: false, events: 0, notificationQueued: false };
        }
        if (this.database.hasDiscoveryDigestRun(date)) {
            return { localDate: date, alreadyCompleted: true, events: 0, notificationQueued: false };
        }
        const events = this.database.listPendingSearchDiscoveryEvents();
        const completedAt = now.toISOString();
        let notificationQueued = false;
        if (events.length > 0 && options.target) {
            const payload = {
                kind: "discovery_digest",
                productName: "Inventory discovery digest",
                currentStatus: "catalog_listings_discovered",
                checkedAt: completedAt,
                discoveryGroups: digestGroups(events),
            };
            notificationQueued = this.database.enqueueNotification({
                sourceKind: "discovery_digest",
                sourceId: date,
                fingerprint: `discovery-digest:${date}`,
                channel: options.target.channel,
                target: options.target.target,
                accountId: options.target.accountId,
                threadId: options.target.threadId,
                transition: "catalog_listings_discovered",
                payload,
                createdAt: completedAt,
            });
        }
        this.database.completeDiscoveryDigest({
            localDate: date,
            completedAt,
            eventIds: events.map(({ id }) => id),
        });
        return {
            localDate: date,
            alreadyCompleted: false,
            events: events.length,
            notificationQueued,
        };
    }
}
