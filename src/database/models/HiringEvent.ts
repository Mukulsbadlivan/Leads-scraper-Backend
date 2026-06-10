import { ObjectId } from "mongodb";

export type HiringEventType =
  | "new_ceo"
  | "new_cto"
  | "new_cfo"
  | "new_coo"
  | "new_exec"
  | "leadership_change"
  | "team_expansion";

export interface HiringSourceRecord {
  source: string;
  fetchedAt: Date;
}

/**
 * A structured executive hiring event extracted from company news.
 * Maps to the `hiring_events` collection in MongoDB.
 */
export interface HiringEventDocument {
  _id?: ObjectId;

  // ── Relations ─────────────────────────────────────────────────────────────
  newsId: ObjectId;
  startupCompanyId?: ObjectId;
  existingCompanyId?: ObjectId;
  companyName?: string;

  // ── Event Data ────────────────────────────────────────────────────────────
  eventType: HiringEventType;
  personName?: string;
  personLinkedin?: string;
  previousRole?: string;
  newRole?: string;
  effectiveDate?: Date;
  announcedAt?: Date;

  // ── Source ────────────────────────────────────────────────────────────────
  sourceTracking?: HiringSourceRecord[];

  // ── Meta ──────────────────────────────────────────────────────────────────
  createdAt?: Date;
  updatedAt?: Date;
}
