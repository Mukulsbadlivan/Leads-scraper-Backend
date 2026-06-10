import { ObjectId } from "mongodb";

export type GrowthEventType =
  | "team_expansion"
  | "new_office"
  | "product_launch"
  | "geo_expansion"
  | "acquisition"
  | "partnership"
  | "tech_stack_change"
  | "engineering_growth"
  | "other";

export interface GrowthMetrics {
  headcountAdded?: number;
  newMarkets?: string[];
}

export interface GrowthSourceRecord {
  source: string;
  fetchedAt: Date;
}

/**
 * A structured growth event extracted from company news.
 * Maps to the `growth_events` collection in MongoDB.
 */
export interface GrowthEventDocument {
  _id?: ObjectId;

  // ── Relations ─────────────────────────────────────────────────────────────
  newsId: ObjectId;
  startupCompanyId?: ObjectId;
  existingCompanyId?: ObjectId;
  companyName?: string;

  // ── Event Data ────────────────────────────────────────────────────────────
  eventType: GrowthEventType;
  detail?: string;
  metrics?: GrowthMetrics;
  effectiveDate?: Date;
  announcedAt?: Date;

  // ── Source ────────────────────────────────────────────────────────────────
  sourceTracking?: GrowthSourceRecord[];

  // ── Meta ──────────────────────────────────────────────────────────────────
  createdAt?: Date;
  updatedAt?: Date;
}
