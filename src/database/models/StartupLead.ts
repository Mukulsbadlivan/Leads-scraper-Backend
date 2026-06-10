import { ObjectId } from "mongodb";

export type GrowthTier = "Hot" | "Warm" | "Cold";

export interface StartupLeadSourceRecord {
  source: string;
  fetchedAt: Date;
}

/**
 * A startup lead record linking a startup company to its actionable signals.
 * Maps to the `startup_leads` collection in MongoDB.
 * ISOLATED — does NOT modify the existing `leads` collection.
 */
export interface StartupLeadDocument {
  _id?: ObjectId;

  // ── Relations ─────────────────────────────────────────────────────────────
  startupCompanyId: ObjectId;

  // ── Job / Hiring Data ─────────────────────────────────────────────────────
  jobLinks?: string[];
  hiringRoles?: string[];

  // ── Intelligence Scores ───────────────────────────────────────────────────
  startupScore?: number;
  growthTier?: GrowthTier;
  hiringSignalStrength?: number;
  growthSignalStrength?: number;

  // ── Discovery Context ─────────────────────────────────────────────────────
  discoverySource?: string;
  sourceJobRunId?: ObjectId;
  sourceTracking?: StartupLeadSourceRecord[];

  // ── Meta ──────────────────────────────────────────────────────────────────
  createdAt?: Date;
  updatedAt?: Date;
}
