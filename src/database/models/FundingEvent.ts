import { ObjectId } from "mongodb";

export type FundingRound =
  | "pre_seed"
  | "seed"
  | "series_a"
  | "series_b"
  | "series_c"
  | "series_d_plus"
  | "acquisition"
  | "ipo"
  | "other";

export interface FundingSourceRecord {
  source: string;
  fetchedAt: Date;
}

/**
 * A structured funding event extracted from company news.
 * Maps to the `funding_events` collection in MongoDB.
 */
export interface FundingEventDocument {
  _id?: ObjectId;

  // ── Relations ─────────────────────────────────────────────────────────────
  newsId: ObjectId;
  startupCompanyId?: ObjectId;
  existingCompanyId?: ObjectId;
  companyName?: string;

  // ── Funding Data ──────────────────────────────────────────────────────────
  round: FundingRound;
  amount?: number;
  amountRaw?: string;
  currency?: string;
  investors?: string[];
  leadInvestor?: string;
  announcedAt?: Date;
  pressReleaseUrl?: string;

  // ── Source ────────────────────────────────────────────────────────────────
  sourceTracking?: FundingSourceRecord[];

  // ── Meta ──────────────────────────────────────────────────────────────────
  createdAt?: Date;
  updatedAt?: Date;
}
