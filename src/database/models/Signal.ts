import { ObjectId } from "mongodb";

/** Supported signal category types. */
export type SignalCategory =
  | "hiring_velocity"
  | "recent_funding"
  | "linkedin_activity"
  | "news"
  | "competitor_churn"
  | "tech_adoption"
  | "other";

/**
 * A discrete buying or engagement signal linked to a company.
 * Maps to the `signals` collection in MongoDB.
 */
export interface SignalDocument {
  _id?: ObjectId;

  // ── Classification ───────────────────────────────────────────────────────────
  category: SignalCategory;
  signalType?: string;           // More specific label (e.g. "fundraising_series_b")

  // ── Payload ──────────────────────────────────────────────────────────────────
  headline?: string;             // Human-readable title for the signal
  detail?: string;               // Supporting detail / extracted text
  confidence?: number;           // 0–100
  country?: string;
  state?: string;
  city?: string;
  sector?: string;

  // ── Relations ────────────────────────────────────────────────────────────────
  companyId: ObjectId;           // FK → companies._id  (required)
  leadId?: ObjectId;             // FK → leads._id      (optional)
  scrapeRunId?: ObjectId;        // FK → scrape_runs._id

  // ── Temporal ────────────────────────────────────────────────────────────────
  detectedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}
