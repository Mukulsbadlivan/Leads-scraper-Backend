import { Collection, ObjectId, Filter } from "mongodb";
import { getDb } from "../connection.js";
import { CompanyDocument } from "../models/Company.js";
import { normalizeCompanyName } from "../../intelligence/companyNormalizer.js";
import {
  calculateCompanyCompleteness,
  mergeCompanies,
} from "../../intelligence/companyDeduplicator.js";
import { insertDuplicateAudit } from "./DuplicateAuditRepository.js";

const COLLECTION = "companies";

async function col(): Promise<Collection<CompanyDocument>> {
  const db = await getDb();
  return db.collection<CompanyDocument>(COLLECTION);
}

// ─── Index Setup ──────────────────────────────────────────────────────────────

/**
 * Ensures indexes exist for the companies collection.
 * Call once at startup.
 */
export async function ensureCompanyIndexes(): Promise<void> {
  const c = await col();
  await c.createIndex({ website: 1 }, { sparse: true, background: true });
  await c.createIndex({ linkedinUrl: 1 }, { sparse: true, background: true });
  await c.createIndex({ companyName: 1 }, { background: true });
  await c.createIndex({ normalizedName: 1 }, { sparse: true, background: true });
}

/**
 * Upsert a company by website or linkedinUrl (whichever is present).
 * Falls back to companyName if neither is available.
 * Returns the _id of the matched or inserted document.
 */
export async function upsertCompany(
  company: Omit<CompanyDocument, "_id">
): Promise<ObjectId> {
  const c = await col();
  const now = new Date();

  const normName = normalizeCompanyName(company.companyName);
  const incomingCompany = {
    ...company,
    normalizedName: normName,
    updatedAt: now
  };

  // Build OR query to find any potential duplicate in DB
  const queryConditions: Filter<CompanyDocument>[] = [];
  if (company.website) {
    queryConditions.push({ website: company.website });
  }
  if (company.linkedinUrl) {
    queryConditions.push({ linkedinUrl: company.linkedinUrl });
  }
  if (normName) {
    queryConditions.push({ normalizedName: normName });
  }

  let existing: CompanyDocument | null = null;
  if (queryConditions.length > 0) {
    existing = await c.findOne({ $or: queryConditions });
  }

  if (existing) {
    // 1. Calculate completeness
    const existingScore = calculateCompanyCompleteness(existing);
    const incomingScore = calculateCompanyCompleteness(incomingCompany);

    let primary: CompanyDocument;
    let secondary: CompanyDocument;

    if (existingScore >= incomingScore) {
      primary = existing;
      secondary = incomingCompany;
    } else {
      // Incoming is more complete, but keep existing's database ID & creation date
      primary = { ...incomingCompany, _id: existing._id, createdAt: existing.createdAt };
      secondary = existing;
    }

    // 2. Merge records
    const { merged, mergedFields } = mergeCompanies(primary, secondary);

    // 3. Update primary record in MongoDB
    await c.updateOne({ _id: existing._id }, { $set: merged });

    // 4. Log to duplicate_audit if fields were merged
    if (mergedFields.length > 0) {
      await insertDuplicateAudit({
        sourceCollection: "companies",
        originalRecord: merged,
        duplicateRecord: secondary,
        mergeReason: `realtime_upsert_merge: ${mergedFields.join(", ")}`,
        mergedAt: now
      }).catch((err) => {
        console.warn("⚠️ Failed to write company duplicate audit:", err.message);
      });
    }

    return existing._id as ObjectId;
  } else {
    // Insert fresh record
    const result = await c.insertOne({
      ...incomingCompany,
      createdAt: now
    } as CompanyDocument);
    return result.insertedId;
  }
}

/** Find a company by its _id. */
export async function findCompanyById(
  id: ObjectId
): Promise<CompanyDocument | null> {
  const c = await col();
  return c.findOne({ _id: id });
}

/** Find a company by website URL. */
export async function findCompanyByWebsite(
  website: string
): Promise<CompanyDocument | null> {
  const c = await col();
  return c.findOne({ website });
}

/** Retrieve all companies (optionally limited). */
export async function listCompanies(
  limit = 100,
  skip = 0
): Promise<CompanyDocument[]> {
  const c = await col();
  return c.find({}).skip(skip).limit(limit).toArray();
}

/** Count companies matching filters. */
export async function countCompanies(
  filter: Filter<CompanyDocument> = {}
): Promise<number> {
  const c = await col();
  return c.countDocuments(filter);
}

/** Retrieve companies with aggregated jobsCount, leadsCount, and hiringScore. */
export async function listCompaniesPaginated(
  page = 1,
  limit = 25,
  filter: Filter<CompanyDocument> = {}
): Promise<any[]> {
  const c = await col();
  const skip = (page - 1) * limit;

  const pipeline = [
    { $match: filter },
    {
      $lookup: {
        from: "jobs",
        localField: "_id",
        foreignField: "companyId",
        as: "companyJobs"
      }
    },
    {
      $lookup: {
        from: "leads",
        localField: "_id",
        foreignField: "companyId",
        as: "companyLeads"
      }
    },
    {
      $project: {
        companyName: 1,
        normalizedName: 1,
        website: 1,
        companyProfileUrl: 1,
        websiteConfidence: 1,
        linkedinUrl: 1,
        linkedinCompanySlug: 1,
        linkedinCompanyId: 1,
        linkedinConfidence: 1,
        linkedinFollowers: 1,
        sector: 1,
        industry: 1,
        companyType: 1,
        country: 1,
        state: 1,
        city: 1,
        fundingStage: 1,
        isB2BSaaS: 1,
        numberOfEmployees: 1,
        employeeSource: 1,
        employeeSize: 1,
        techStack: 1,
        techStackDetailed: 1,
        fundingInfo: 1,
        recentFundingSignal: 1,
        createdAt: 1,
        updatedAt: 1,
        jobsCount: { $size: "$companyJobs" },
        leadsCount: { $size: "$companyLeads" },
        hiringScore: {
          $cond: {
            if: { $gt: [{ $size: "$companyLeads" }, 0] },
            then: { $max: "$companyLeads.icpScore" },
            else: 0
          }
        }
      }
    },
    { $skip: skip },
    { $limit: limit }
  ];

  return c.aggregate(pipeline).toArray();
}

/** Retrieve companies count grouped by sector. */
export async function getCompaniesBySector(): Promise<{ name: string; value: number }[]> {
  const c = await col();
  return c.aggregate<{ name: string; value: number }>([
    { $match: { sector: { $nin: [null, ""] } } },
    { $group: { _id: "$sector", value: { $sum: 1 } } },
    { $project: { _id: 0, name: "$_id", value: 1 } },
    { $sort: { value: -1 } }
  ]).toArray();
}


