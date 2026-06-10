/**
 * StartupDeduplicator.ts — Deduplication engine for the startup_companies collection.
 *
 * Deduplication strategy (in order of precedence):
 *   1. Exact website match (handled by StartupCompanyRepository.upsertStartupCompany)
 *   2. Normalised company name match (primary sweep — handled here)
 *   3. LinkedIn URL match (secondary sweep — handled here)
 *
 * Within each duplicate group the record selected as the canonical primary
 * is the one with the highest `dataQualityScore`, with earliest `createdAt`
 * as a tiebreaker. All duplicate records are merged into the primary (missing
 * fields are filled in from duplicates) before the duplicates are deleted.
 *
 * ISOLATED — operates exclusively on the `startup_companies` collection.
 * NEVER modifies the existing companies, leads, jobs, or signals collections.
 */
import { ObjectId, Document } from "mongodb";
import { getDb } from "../../database/connection.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const STARTUP_COMPANIES = "startup_companies";

// ─── Name Normalisation ───────────────────────────────────────────────────────

/**
 * Produces a canonical, punctuation-stripped, lower-cased company name
 * with common legal suffixes removed for stable deduplication keys.
 *
 * Examples:
 *   "Acme, Inc."      → "acme"
 *   "Stripe Technologies LLC" → "stripe"
 *   "Linear Co."      → "linear"
 *
 * @param name - Raw company name string.
 * @returns Normalised key string (may be empty if input is empty).
 */
function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")    // strip punctuation
    .replace(/\s+/g, " ")            // collapse whitespace
    .trim()
    .replace(
      /\b(inc|llc|ltd|corp|co|group|technologies|technology|solutions|labs|lab|ventures|venture)\b/g,
      ""
    )
    .trim();
}

// ─── Public Types ──────────────────────────────────────────────────────────────

/** Summary returned after a deduplication sweep completes. */
export interface DeduplicationSummary {
  /** Total documents in the collection before deduplication. */
  totalScanned: number;
  /**
   * Number of duplicate groups found.
   * Each group contains 2+ documents that share the same deduplication key.
   */
  duplicatesFound: number;
  /**
   * Number of groups successfully merged.
   * One record is kept per group; the rest are deleted after field merging.
   */
  merged: number;
  /** Per-group errors that prevented merging (group is left untouched). */
  errors: string[];
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Fields that are safe to merge from a duplicate record into the primary.
 * The primary's value is always preferred; the duplicate's value only fills
 * in if the primary's field is absent, null, empty string, or empty array.
 */
const MERGEABLE_FIELDS: string[] = [
  "website",
  "linkedinUrl",
  "linkedinCompanySlug",
  "linkedinCompanyId",
  "linkedinFollowers",
  "foundingYear",
  "foundedDate",
  "isYCBacked",
  "ycBatch",
  "wellfoundUrl",
  "crunchbaseUrl",
  "industry",
  "sector",
  "companyStage",
  "companySize",
  "headcount",
  "country",
  "state",
  "city",
  "hqLocation",
  "jobLinks",
  "hiringRoles",
  "hiringVelocity",
  "hiringSignals",
  "growthSignals",
  "techStack",
  "existingCompanyId",
  "dataQualityScore",
  "sourceTracking",
  "lastEnrichedAt",
];

/**
 * Merges fields from `source` into `target` in-place.
 * A field is only copied from `source` if `target` does not already have
 * a meaningful value for that field (undefined / null / "" / []).
 *
 * `_id` and `createdAt` are never touched.
 *
 * @param target - The primary (canonical) document to merge into.
 * @param source - A duplicate document to harvest fields from.
 * @returns The mutated `target` object.
 */
function mergeInto(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  for (const field of MERGEABLE_FIELDS) {
    if (field === "_id" || field === "createdAt") continue;

    const targetVal = target[field];
    const sourceVal = source[field];

    if (sourceVal === undefined || sourceVal === null) continue;

    const targetEmpty =
      targetVal === undefined ||
      targetVal === null ||
      targetVal === "" ||
      (Array.isArray(targetVal) && targetVal.length === 0);

    if (targetEmpty) {
      target[field] = sourceVal;
    }
  }

  return target;
}

// ─── Deduplication Sweeps ─────────────────────────────────────────────────────

/**
 * Runs a single deduplication pass using the provided aggregation pipeline.
 *
 * The pipeline must group documents by a key and emit documents with:
 *   - `_id`    : the group key value
 *   - `ids`    : array of MongoDB ObjectIds in the group
 *   - `count`  : size of the group (only groups with count > 1 are processed)
 *
 * @param db      - MongoDB Db instance.
 * @param label   - Human-readable sweep label for logging.
 * @param pipeline - Aggregation pipeline to find duplicate groups.
 * @param summary  - Mutable summary object to update.
 */
async function runSweep(
  db: Awaited<ReturnType<typeof import("../../database/connection.ts").getDb>>,
  label: string,
  pipeline: Document[],
  summary: DeduplicationSummary
): Promise<void> {
  const col = db.collection(STARTUP_COMPANIES);

  let groups: Array<{ _id: any; ids: ObjectId[]; count: number }>;

  try {
    groups = (await col.aggregate(pipeline).toArray()) as Array<{
      _id: any;
      ids: ObjectId[];
      count: number;
    }>;
  } catch (err: any) {
    summary.errors.push(`[${label}] Aggregation failed: ${err.message}`);
    return;
  }

  summary.duplicatesFound += groups.length;

  console.log(
    `[StartupDeduplicator][${label}] Found ${groups.length} duplicate group(s).`
  );

  for (const group of groups) {
    try {
      // Fetch all documents in the group sorted: best quality first, oldest first
      const docs = await col
        .find({ _id: { $in: group.ids } })
        .sort({ dataQualityScore: -1, createdAt: 1 })
        .toArray();

      if (docs.length < 2) continue; // Race condition — another sweep already cleaned this

      const [primary, ...duplicates] = docs;
      const mergedPrimary: Record<string, any> = { ...primary };

      // Harvest fields from each duplicate into the primary
      for (const dup of duplicates) {
        mergeInto(mergedPrimary, dup as Record<string, any>);
      }

      // Remove internal MongoDB fields that should not be set via $set
      const { _id: _primaryId, createdAt: _created, ...fieldsToSet } = mergedPrimary;

      // Update the primary document with merged fields
      await col.updateOne(
        { _id: primary._id },
        { $set: { ...fieldsToSet, updatedAt: new Date() } }
      );

      // Delete all duplicates — primary is now the canonical record
      const duplicateIds = duplicates.map((d) => d._id as ObjectId);
      const deleteResult = await col.deleteMany({ _id: { $in: duplicateIds } });

      console.log(
        `[StartupDeduplicator][${label}] Merged group "${group._id}": ` +
          `kept _id=${primary._id}, deleted ${deleteResult.deletedCount} duplicate(s).`
      );

      summary.merged++;
    } catch (err: any) {
      const errMsg = `[${label}] Group "${group._id}": ${err.message}`;
      summary.errors.push(errMsg);
      console.warn("[StartupDeduplicator]", errMsg);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Runs a full deduplication sweep on the `startup_companies` collection.
 *
 * Two sequential passes are performed:
 *   Pass 1 — Groups by `normalizedName` (catches most duplicates introduced
 *             by the discovery pipeline running across multiple sources).
 *   Pass 2 — Groups by `linkedinUrl` (catches companies where the name
 *             normalisation differs but the LinkedIn URL is identical).
 *
 * Within each group, the most complete record (highest `dataQualityScore`,
 * oldest `createdAt` as tiebreaker) is kept as the canonical document.
 * Missing fields are merged in from the duplicates before they are deleted.
 *
 * This function is idempotent — running it multiple times is safe.
 *
 * @returns {@link DeduplicationSummary} describing the full sweep results.
 *
 * @example
 * ```ts
 * const summary = await deduplicateStartupCompanies();
 * console.log(`Merged ${summary.merged} duplicate groups.`);
 * ```
 */
export async function deduplicateStartupCompanies(): Promise<DeduplicationSummary> {
  const summary: DeduplicationSummary = {
    totalScanned: 0,
    duplicatesFound: 0,
    merged: 0,
    errors: [],
  };

  let db: Awaited<ReturnType<typeof import("../../database/connection.ts").getDb>>;

  try {
    db = await getDb();
    const col = db.collection(STARTUP_COMPANIES);
    summary.totalScanned = await col.countDocuments({});
  } catch (err: any) {
    summary.errors.push(`Failed to connect / count documents: ${err.message}`);
    return summary;
  }

  // ── Pass 1: Deduplicate by normalised company name ──────────────────────
  const byNamePipeline: Document[] = [
    {
      $match: {
        normalizedName: { $exists: true, $nin: [null, ""] },
      },
    },
    {
      $group: {
        _id: "$normalizedName",
        ids: { $push: "$_id" },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } }, // largest groups first for faster visible progress
  ];

  await runSweep(db, "normalizedName", byNamePipeline, summary);

  // ── Pass 2: Deduplicate by LinkedIn URL (catches cross-source dupes) ────
  const byLinkedInPipeline: Document[] = [
    {
      $match: {
        linkedinUrl: { $exists: true, $nin: [null, ""] },
      },
    },
    {
      $group: {
        _id: "$linkedinUrl",
        ids: { $push: "$_id" },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
  ];

  await runSweep(db, "linkedinUrl", byLinkedInPipeline, summary);

  console.log(
    `[StartupDeduplicator] Complete. ` +
      `Scanned: ${summary.totalScanned}. ` +
      `Duplicate groups: ${summary.duplicatesFound}. ` +
      `Merged: ${summary.merged}. ` +
      `Errors: ${summary.errors.length}.`
  );

  return summary;
}
