import { describe, expect, it } from "vitest";
import { InventoryDatabase } from "../persistence/db.js";
import { WishlistService } from "../wishlist/service.js";
import { ResearchService } from "./service.js";

const evidence = [{
  url: "https://reviews.example/current-comparison",
  label: "Independent comparison",
  claim: "Compared current products and sellers.",
}];

function setup(now = "2026-10-14T12:00:00.000Z") {
  const database = new InventoryDatabase(":memory:");
  const clock = () => new Date(now);
  return { database, clock, service: new ResearchService(database, clock) };
}

function candidate(url: string, verdict: "recommended" | "alternative" | "rejected" = "recommended") {
  return {
    url,
    title: url.includes("loveramics") ? "Loveramics Egg cup and saucer" : "Colorful latte cup",
    brand: url.includes("loveramics") ? "Loveramics" : "Example Ceramics",
    seller: "Reputable Coffee Shop",
    sellerType: "boutique" as const,
    sellerRating: 4.8,
    reviewCount: 240,
    price: 32,
    currency: "usd",
    verdict,
    rationale: "Credible specialty seller, current stock, and strong independent reviews.",
    evidence,
  };
}

describe("ResearchService", () => {
  it("creates independent due research ideas with trusted-seller defaults", () => {
    const { database, service } = setup();
    try {
      const status = service.add({
        name: "Colorful latte cups",
        query: "colorful 10 oz latte cups and saucers",
      });
      expect(status.topic).toMatchObject({
        status: "active",
        refreshIntervalDays: 30,
        minimumSellerRating: 4,
        allowMarketplaceSellers: false,
      });
      expect(status.due).toBe(true);
      expect(service.due()).toHaveLength(1);
      expect(status.promotions).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("records evidence-backed snapshots and detects newer recommendations", () => {
    const database = new InventoryDatabase(":memory:");
    let now = "2026-10-14T12:00:00.000Z";
    const clock = () => new Date(now);
    const service = new ResearchService(database, clock);
    try {
      const topic = service.add({ name: "Espresso scale", refreshIntervalDays: 14 }).topic;
      let status = service.record(topic.id, {
        summary: "Initial current recommendation.",
        candidates: [candidate("https://boutique.example/scale-a")],
      });
      expect(status.latestRun).toMatchObject({
        recommendationChanged: false,
        nextRefreshAt: "2026-10-28T12:00:00.000Z",
      });
      now = "2026-10-29T12:00:00.000Z";
      status = service.record(topic.id, {
        summary: "A newer model is now the stronger recommendation.",
        candidates: [candidate("https://manufacturer.example/scale-b")],
      });
      expect(status.latestRun?.recommendationChanged).toBe(true);
      expect(status.runCount).toBe(2);
    } finally {
      database.close();
    }
  });

  it("rejects low-quality marketplace recommendations but permits rejected evidence", () => {
    const { database, service } = setup();
    try {
      const topic = service.add({ name: "Espresso organizer" }).topic;
      const marketplace = {
        ...candidate("https://marketplace.example/random-shop/item"),
        seller: "Random Shop 4821",
        sellerType: "marketplace" as const,
        sellerRating: 3.1,
      };
      expect(() => service.record(topic.id, {
        summary: "Only a weak marketplace result.",
        candidates: [marketplace],
      })).toThrow("manufacturer, household retailer, or reputable boutique");

      expect(() => service.record(topic.id, {
        summary: "The weak seller was excluded in favor of a reputable retailer.",
        candidates: [
          { ...marketplace, verdict: "rejected" },
          candidate("https://household.example/organizer"),
        ],
      })).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("promotes a candidate into the wishlist while optionally continuing discovery", () => {
    const { database, service } = setup();
    try {
      const topic = service.add({
        name: "Colorful latte cups",
        query: "colorful 10 oz latte cups and saucers",
      }).topic;
      const researched = service.record(topic.id, {
        summary: "Loveramics is the current favorite, with another credible alternative.",
        candidates: [
          candidate("https://boutique.example/loveramics-egg"),
          candidate("https://manufacturer.example/other-cup", "alternative"),
        ],
      });
      const selected = researched.latestRun!.candidates.find(({ verdict }) => verdict === "recommended")!;
      const promoted = service.promote(topic.id, {
        candidateId: selected.id,
        continueResearch: true,
        wishlist: {
          name: "Loveramics Egg 10 oz latte cup and saucer — mixed colors",
          category: "Coffee equipment",
          desiredQuantity: 4,
          tags: ["espresso", "latte art"],
        },
      });
      expect(promoted.research.topic.status).toBe("active");
      expect(promoted.research.promotions).toHaveLength(1);
      expect(promoted.wishlistItem).toMatchObject({
        status: "wanted",
        desiredQuantity: 4,
      });
      expect(promoted.wishlistItem.links[0]).toMatchObject({
        url: "https://boutique.example/loveramics-egg",
        kind: "retailer",
        price: 32,
        currency: "USD",
      });

      const later = service.record(topic.id, {
        summary: "A new example appeared, but the wishlist selection remains unchanged.",
        candidates: [candidate("https://manufacturer.example/new-cup")],
      });
      expect(later.latestRun?.recommendationChanged).toBe(true);
      expect(new WishlistService(database).status({ itemId: promoted.wishlistItem.id })[0].links[0].url)
        .toBe("https://boutique.example/loveramics-egg");
    } finally {
      database.close();
    }
  });

  it("can promote into an existing wishlist item and pause future research", () => {
    const { database, clock, service } = setup();
    try {
      const existing = new WishlistService(database, clock).add({ name: "Tamp station" });
      const topic = service.add({ name: "Tamp station ideas" }).topic;
      const researched = service.record(topic.id, {
        summary: "Current recommendation for the existing need.",
        candidates: [candidate("https://boutique.example/tamp-station")],
      });
      const selected = researched.latestRun!.candidates[0];
      const promoted = service.promote(topic.id, {
        candidateId: selected.id,
        existingWishlistItemId: existing.id,
        continueResearch: false,
      });
      expect(promoted.research.topic.status).toBe("paused");
      expect(promoted.wishlistItem.id).toBe(existing.id);
      expect(service.due()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
