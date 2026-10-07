import type { InventoryResult } from "../domain/inventory.js";
import type { ProductIdentity } from "../domain/product.js";

export type InspectionObservation = {
  source: "json_ld" | "html" | "http";
  field: string;
  value: string | number | boolean;
};

export type RetailerInspection = {
  level: "static";
  finalUrl: string;
  product?: ProductIdentity;
  inventory: InventoryResult;
  observations: InspectionObservation[];
  sanitizedFixture?: {
    kind: "json_ld";
    html: string;
    sha256: string;
  };
  nextRecommendedLevel: "none" | "network" | "browser";
};
