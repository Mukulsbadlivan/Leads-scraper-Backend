import { ObjectId } from "mongodb";

export type ExecutiveRole = "founder" | "co-founder" | "ceo" | "cto" | "cfo" | "coo" | "other";

export interface ExecutiveSourceRecord {
  source: string;
  fetchedAt: Date;
  confidence: number;
}

/**
 * Represents a founder or executive associated with a startup company.
 * Maps to the `startup_executives` collection in MongoDB.
 * ISOLATED — does NOT modify the existing `leads` collection.
 */
export interface StartupExecutiveDocument {
  _id?: ObjectId;

  // ── Relations ─────────────────────────────────────────────────────────────
  startupCompanyId: ObjectId;
  existingCompanyId?: ObjectId;

  // ── Identity ──────────────────────────────────────────────────────────────
  name?: string;
  role: ExecutiveRole;
  title?: string;
  linkedinUrl?: string;
  linkedinSlug?: string;
  email?: string;

  // ── Source ────────────────────────────────────────────────────────────────
  sourceTracking?: ExecutiveSourceRecord[];

  // ── Meta ──────────────────────────────────────────────────────────────────
  createdAt?: Date;
  updatedAt?: Date;
}
