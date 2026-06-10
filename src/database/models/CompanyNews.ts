import { ObjectId } from "mongodb";

export type NewsEventType = "funding" | "hiring" | "growth" | "technology" | "acquisition" | "other";

export interface NewsSourceRecord {
  source: string;
  fetchedAt: Date;
}

/**
 * A news article or press release linked to a startup or existing company.
 * Maps to the `company_news` collection in MongoDB.
 * ISOLATED — does NOT modify the existing `signals` collection.
 */
export interface CompanyNewsDocument {
  _id?: ObjectId;

  // ── Relations ─────────────────────────────────────────────────────────────
  startupCompanyId?: ObjectId;
  existingCompanyId?: ObjectId;
  companyName?: string;

  // ── Article Data ──────────────────────────────────────────────────────────
  title: string;
  url: string;
  contentHash: string;
  publishedAt?: Date;
  source?: string;
  rawText?: string;
  summary?: string;

  // ── Classification ────────────────────────────────────────────────────────
  eventType: NewsEventType;
  eventSubtype?: string;
  classificationConfidence?: number;

  // ── Tracking ──────────────────────────────────────────────────────────────
  fetchedAt?: Date;
  sourceTracking?: NewsSourceRecord[];

  // ── Meta ──────────────────────────────────────────────────────────────────
  createdAt?: Date;
  updatedAt?: Date;
}
