import { ObjectId } from "mongodb";

export interface StartupSourceRecord {
  source: string;
  fetchedAt: Date;
  confidence: number;
}

export interface HiringVelocityRecord {
  last30Days: number;
  trend: "accelerating" | "stable" | "decelerating";
}

/**
 * Represents a startup company discovered by the Startup Intelligence Engine.
 * Maps to the `startup_companies` collection in MongoDB.
 * ISOLATED — does NOT modify the existing `companies` collection.
 */
export interface StartupCompanyDocument {
  _id?: ObjectId;

  // ── Core Identity ─────────────────────────────────────────────────────────
  companyName: string;
  normalizedName?: string;
  website?: string;
  linkedinUrl?: string;
  linkedinCompanySlug?: string;
  linkedinCompanyId?: string;
  linkedinFollowers?: number;

  // ── Startup-Specific ──────────────────────────────────────────────────────
  foundingYear?: number;
  foundedDate?: string;
  isYCBacked?: boolean;
  ycBatch?: string;
  wellfoundUrl?: string;
  crunchbaseUrl?: string;

  // ── Classification ────────────────────────────────────────────────────────
  industry?: string;
  sector?: string;
  companyStage?: string;
  companySize?: string;
  headcount?: number;

  // ── Location ──────────────────────────────────────────────────────────────
  country?: string;
  state?: string;
  city?: string;
  hqLocation?: string;

  // ── Hiring Intelligence ───────────────────────────────────────────────────
  jobLinks?: string[];
  hiringRoles?: string[];
  hiringVelocity?: HiringVelocityRecord;
  hiringSignals?: string[];

  // ── Growth Intelligence ───────────────────────────────────────────────────
  growthSignals?: string[];
  techStack?: string[];

  // ── Cross-Reference (read-only FK to existing companies) ─────────────────
  existingCompanyId?: ObjectId;

  // ── Data Quality ──────────────────────────────────────────────────────────
  dataQualityScore?: number;
  sourceTracking?: StartupSourceRecord[];
  lastEnrichedAt?: Date;

  // ── Meta ──────────────────────────────────────────────────────────────────
  createdAt?: Date;
  updatedAt?: Date;
}
