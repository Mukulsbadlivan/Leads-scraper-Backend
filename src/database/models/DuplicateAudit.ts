import { ObjectId } from "mongodb";

/**
 * Audit log entry documenting deduplication actions.
 * Maps to the `duplicate_audit` collection in MongoDB.
 */
export interface DuplicateAuditDocument {
  _id?: ObjectId;
  /** The collection that was deduplicated */
  sourceCollection: "companies" | "leads";
  /** The surviving record (primary) */
  originalRecord: any;
  /** The merged/removed record (secondary) */
  duplicateRecord: any;
  /** Reason describing the trigger (e.g. "website_match", "email_match") */
  mergeReason: string;
  /** Timestamp when the merge took place */
  mergedAt: Date;
}
