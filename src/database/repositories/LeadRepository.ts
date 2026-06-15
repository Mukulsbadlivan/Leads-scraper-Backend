import { Collection, ObjectId, Filter, Sort } from "mongodb";
import { getDb } from "../connection.js";
import { LeadDocument } from "../models/Lead.js";
import { upsertCompany } from "./CompanyRepository.js";
import { upsertJob } from "./JobRepository.js";
import { insertSignal } from "./SignalRepository.js";
import {
  calculateLeadCompleteness,
  mergeLeads,
} from "../../intelligence/leadDeduplicator.js";
import { insertDuplicateAudit } from "./DuplicateAuditRepository.js";

const COLLECTION = "leads";

async function col(): Promise<Collection<LeadDocument>> {
  const db = await getDb();
  return db.collection<LeadDocument>(COLLECTION);
}

/**
 * Ensures indexes exist for the leads collection.
 * Call once at startup.
 */
export async function ensureLeadIndexes(): Promise<void> {
  const c = await col();
  await c.createIndex({ linkedinUrl: 1 }, { sparse: true, background: true });
  await c.createIndex({ email: 1 }, { sparse: true, background: true });
  await c.createIndex({ companyId: 1 }, { background: true });
  await c.createIndex({ scrapeRunId: 1 }, { background: true });
  await c.createIndex({ icpScore: -1 }, { background: true });
}

/**
 * Upsert a lead by linkedinUrl, then email, then companyName.
 * Returns the _id of the matched or inserted document.
 */
export async function upsertLead(
  lead: Omit<LeadDocument, "_id">
): Promise<ObjectId> {
  const c = await col();
  const now = new Date();

  // 1. Auto-upsert the company
  let companyId: ObjectId | undefined;
  if (lead.companyName) {
    try {
      companyId = await upsertCompany({
        companyName: lead.companyName,
        website: lead.website,
        companyProfileUrl: lead.companyProfileUrl || lead.website,
        websiteConfidence: lead.websiteConfidence,
        linkedinUrl: lead.linkedinUrl,
        linkedinCompanySlug: lead.linkedinCompanySlug,
        linkedinCompanyId: lead.linkedinCompanyId,
        linkedinConfidence: lead.linkedinConfidence,
        linkedinFollowers: typeof lead.linkedinFollowers === "string" ? parseInt(lead.linkedinFollowers) || undefined : (lead.linkedinFollowers as number),
        sector: lead.sector,
        industry: lead.industry,
        companyType: lead.companyType,
        country: lead.country,
        state: lead.state,
        city: lead.city,
        fundingStage: lead.fundingStage,
        isB2BSaaS: lead.isB2BSaaS,
        numberOfEmployees: lead.numberOfEmployees,
        employeeSource: lead.employeeSource,
        employeeSize: lead.employeeSize,
        techStack: typeof lead.techStack === "object" ? JSON.stringify(lead.techStack) : lead.techStack,
        techStackDetailed: lead.techStackDetailed,
        fundingInfo: lead.fundingInfo,
        recentFundingSignal: lead.recentFundingSignal
      });
    } catch (err: any) {
      console.warn(`[upsertLead] Failed to upsert company "${lead.companyName}":`, err.message);
    }
  }

  if (companyId) {
    lead.companyId = companyId;
  }

  // 2. Upsert the lead
  const incomingLead = {
    ...lead,
    updatedAt: now
  };

  // Build OR query to find potential duplicate leads
  const queryConditions: Filter<LeadDocument>[] = [];
  const lUrl = lead.linkedinProfileUrl || lead.linkedinUrl;
  if (lUrl) {
    queryConditions.push({ linkedinProfileUrl: lUrl });
    queryConditions.push({ linkedinUrl: lUrl });
  }
  if (lead.email) {
    queryConditions.push({ email: lead.email });
  }
  if (lead.contactName && lead.companyId) {
    queryConditions.push({
      contactName: lead.contactName,
      companyId: lead.companyId
    });
  }

  let existing: LeadDocument | null = null;
  if (queryConditions.length > 0) {
    existing = await c.findOne({ $or: queryConditions });
  }

  let leadId: ObjectId;

  if (existing) {
    // 1. Calculate completeness
    const existingScore = calculateLeadCompleteness(existing);
    const incomingScore = calculateLeadCompleteness(incomingLead);

    let primary: LeadDocument;
    let secondary: LeadDocument;

    if (existingScore >= incomingScore) {
      primary = existing;
      secondary = incomingLead;
    } else {
      // Incoming is more complete, but keep existing's database ID & creation date
      primary = { ...incomingLead, _id: existing._id, createdAt: existing.createdAt };
      secondary = existing;
    }

    // 2. Merge records
    const { merged, mergedFields } = mergeLeads(primary, secondary);

    // 3. Update primary record in MongoDB
    await c.updateOne({ _id: existing._id }, { $set: merged });

    // 4. Log to duplicate_audit if fields were merged
    if (mergedFields.length > 0) {
      await insertDuplicateAudit({
        sourceCollection: "leads",
        originalRecord: merged,
        duplicateRecord: secondary,
        mergeReason: `realtime_upsert_merge: ${mergedFields.join(", ")}`,
        mergedAt: now
      }).catch((err) => {
        console.warn("⚠️ Failed to write lead duplicate audit:", err.message);
      });
    }

    leadId = existing._id as ObjectId;
  } else {
    // Insert fresh record
    const result = await c.insertOne({
      ...incomingLead,
      createdAt: now
    } as LeadDocument);
    leadId = result.insertedId;
  }

  // 3. Auto-upsert the job posting
  if (lead.jobLink && companyId) {
    try {
      await upsertJob({
        source: lead.source || "Unknown",
        jobUrl: lead.jobLink,
        jobTitle: lead.jobTitle,
        companyName: lead.companyName,
        location: lead.location,
        salary: lead.salary,
        minSalary: lead.minSalary,
        maxSalary: lead.maxSalary,
        currency: lead.currency,
        companyRating: typeof lead.companyRating === "string" ? parseFloat(lead.companyRating) || undefined : (lead.companyRating as number),
        companyId,
        scrapeRunId: lead.scrapeRunId,
        country: lead.country,
        state: lead.state,
        city: lead.city,
        sector: lead.sector,
        scrapeTimestamp: lead.scrapeTimestamp ? new Date(lead.scrapeTimestamp) : now
      });
    } catch (err: any) {
      console.warn(`[upsertLead] Failed to upsert job for "${lead.companyName}":`, err.message);
    }
  }

  // 4. Auto-insert growth / buying intent signals
  if (companyId) {
    try {
      // Hiring Velocity Signal
      if (lead.hiringVelocity && (lead.hiringVelocity.last30days > 0 || lead.hiringVelocity.trend)) {
        await insertSignal({
          category: "hiring_velocity",
          signalType: lead.hiringVelocity.trend,
          headline: `${lead.companyName} is hiring actively`,
          detail: `Found ${lead.hiringVelocity.last30days} active roles in 30 days. Top roles: ${(lead.hiringVelocity.topRoles || []).join(", ")}`,
          confidence: lead.icpScore || 50,
          companyId,
          leadId,
          scrapeRunId: lead.scrapeRunId,
          country: lead.country,
          state: lead.state,
          city: lead.city,
          sector: lead.sector,
          detectedAt: now
        });
      }

      // Recent Funding Signal
      if (lead.recentFundingSignal || lead.fundingStage) {
        await insertSignal({
          category: "recent_funding",
          signalType: lead.fundingStage,
          headline: `${lead.companyName} funding event: ${lead.fundingStage || "Venture funding"}`,
          detail: lead.fundingInfo || `Inferred funding stage is ${lead.fundingStage}`,
          confidence: 85,
          companyId,
          leadId,
          scrapeRunId: lead.scrapeRunId,
          country: lead.country,
          state: lead.state,
          city: lead.city,
          sector: lead.sector,
          detectedAt: now
        });
      }

      // News Signal
      if (lead.newsHeadline) {
        await insertSignal({
          category: "news",
          headline: lead.newsHeadline,
          detail: lead.fundingInfo || "",
          confidence: 80,
          companyId,
          leadId,
          scrapeRunId: lead.scrapeRunId,
          country: lead.country,
          state: lead.state,
          city: lead.city,
          sector: lead.sector,
          detectedAt: now
        });
      }

      // LinkedIn Activity Signal
      if (lead.linkedinPainSignals) {
        await insertSignal({
          category: "linkedin_activity",
          headline: `${lead.companyName} leadership posted on LinkedIn`,
          detail: lead.linkedinPainSignals,
          confidence: lead.emailConfidenceScore || 70,
          companyId,
          leadId,
          scrapeRunId: lead.scrapeRunId,
          country: lead.country,
          state: lead.state,
          city: lead.city,
          sector: lead.sector,
          detectedAt: now
        });
      }
    } catch (err: any) {
      console.warn(`[upsertLead] Failed to insert signals for "${lead.companyName}":`, err.message);
    }
  }

  return leadId;
}

/** Insert multiple leads at once (skips duplicates via ordered:false). */
export async function insertManyLeads(
  leads: Omit<LeadDocument, "_id">[]
): Promise<number> {
  if (leads.length === 0) return 0;
  const c = await col();
  const now = new Date();
  const docs = leads.map((l) => ({ ...l, createdAt: now, updatedAt: now }));
  try {
    const result = await c.insertMany(docs, { ordered: false });
    return result.insertedCount;
  } catch (err: any) {
    // Ignore duplicate key errors (code 11000) — count only successful inserts
    if (err.code === 11000 || err.name === "MongoBulkWriteError") {
      return err.result?.insertedCount ?? 0;
    }
    throw err;
  }
}

/** Find a lead by its _id. */
export async function findLeadById(id: ObjectId): Promise<LeadDocument | null> {
  const c = await col();
  return c.findOne({ _id: id });
}

/**
 * Retrieve leads filtered by ICP tier with descending score sort.
 * @param tier  "Hot" | "Warm" | "Cold" | undefined (all tiers)
 */
export async function findLeadsByTier(
  tier?: "Hot" | "Warm" | "Cold",
  limit = 100,
  skip = 0
): Promise<LeadDocument[]> {
  const c = await col();
  const filter: Filter<LeadDocument> = tier ? { icpTier: tier } : {};
  const sort: Sort = { icpScore: -1 };
  return c.find(filter).sort(sort).skip(skip).limit(limit).toArray();
}

/** Get top N leads by ICP score across all tiers. */
export async function getTopLeads(
  n = 50,
  scrapeRunId?: ObjectId
): Promise<LeadDocument[]> {
  const c = await col();
  const filter: Filter<LeadDocument> = scrapeRunId ? { scrapeRunId } : {};
  return c.find(filter).sort({ icpScore: -1 }).limit(n).toArray();
}

/** Count leads per ICP tier for a scrape run. */
export async function countLeadsByTier(
  scrapeRunId?: ObjectId
): Promise<{ hot: number; warm: number; cold: number; total: number }> {
  const c = await col();
  const match = scrapeRunId ? { scrapeRunId } : {};

  const agg = await c
    .aggregate<{ _id: string; count: number }>([
      { $match: match },
      { $group: { _id: "$icpTier", count: { $sum: 1 } } },
    ])
    .toArray();

  const counts = { hot: 0, warm: 0, cold: 0, total: 0 };
  for (const { _id, count } of agg) {
    counts.total += count;
    if (_id === "Hot") counts.hot = count;
    else if (_id === "Warm") counts.warm = count;
    else if (_id === "Cold") counts.cold = count;
  }
  return counts;
}

/** Count leads matching filters. */
export async function countLeads(
  filter: Filter<LeadDocument> = {}
): Promise<number> {
  const c = await col();
  return c.countDocuments(filter);
}

/** Retrieve leads matching filters with pagination and ICP score sorting. */
export async function listLeadsPaginated(
  page = 1,
  limit = 25,
  filter: Filter<LeadDocument> = {}
): Promise<LeadDocument[]> {
  const c = await col();
  const skip = (page - 1) * limit;
  return c.find(filter).sort({ icpScore: -1 }).skip(skip).limit(limit).toArray();
}

/** Retrieve geographic distribution of leads. */
export async function getLeadsByRegion(): Promise<{ name: string; value: number }[]> {
  const c = await col();
  return c.aggregate<{ name: string; value: number }>([
    { $match: { country: { $nin: [null, ""] } } },
    { $group: { _id: "$country", value: { $sum: 1 } } },
    { $project: { _id: 0, name: "$_id", value: 1 } },
    { $sort: { value: -1 } },
    { $limit: 10 }
  ]).toArray();
}

/** Retrieve sector distribution of leads. */
export async function getLeadsBySector(): Promise<{ name: string; value: number }[]> {
  const c = await col();
  return c.aggregate<{ name: string; value: number }>([
    { $match: { sector: { $nin: [null, ""] } } },
    { $group: { _id: "$sector", value: { $sum: 1 } } },
    { $project: { _id: 0, name: "$_id", value: 1 } },
    { $sort: { value: -1 } },
    { $limit: 10 }
  ]).toArray();
}

/** Retrieve leads count grouped by ICP tier. */
export async function getLeadsByTier(): Promise<{ name: string; value: number }[]> {
  const c = await col();
  return c.aggregate<{ name: string; value: number }>([
    { $match: { icpTier: { $ne: null } } },
    { $group: { _id: "$icpTier", value: { $sum: 1 } } },
    { $project: { _id: 0, name: "$_id", value: 1 } },
    { $sort: { value: -1 } }
  ]).toArray();
}

/** Retrieve email and phone discovery rates. */
export async function getLeadDiscoveryRates(): Promise<{
  total: number;
  withEmail: number;
  withPhone: number;
  withBoth: number;
  emailRate: number;
  phoneRate: number;
  bothRate: number;
}> {
  const c = await col();
  const total = await c.countDocuments({});
  if (total === 0) {
    return { total: 0, withEmail: 0, withPhone: 0, withBoth: 0, emailRate: 0, phoneRate: 0, bothRate: 0 };
  }

  const withEmail = await c.countDocuments({ email: { $nin: [null, ""] } });
  const withPhone = await c.countDocuments({ phoneNumber: { $nin: [null, ""] } });
  const withBoth = await c.countDocuments({
    email: { $nin: [null, ""] },
    phoneNumber: { $nin: [null, ""] }
  });

  return {
    total,
    withEmail,
    withPhone,
    withBoth,
    emailRate: Math.round((withEmail / total) * 1000) / 10,
    phoneRate: Math.round((withPhone / total) * 1000) / 10,
    bothRate: Math.round((withBoth / total) * 1000) / 10
  };
}

/** Find all leads belonging to a company. */
export async function findLeadsByCompany(companyId: ObjectId): Promise<LeadDocument[]> {
  const c = await col();
  return c.find({ companyId }).sort({ icpScore: -1 }).toArray();
}

/**
 * Bulk upsert an array of leads using a single MongoDB bulkWrite() call.
 * Each lead is matched by linkedinUrl → email → companyName (in priority order).
 * Falls back to individual upsertLead() calls if bulkWrite is unavailable.
 *
 * This replaces N individual updateOne() round-trips with a single batch operation.
 * Expected speedup: ~60–80% reduction in MongoDB write latency for batches ≥ 5 leads.
 *
 * @param leads   Array of lead objects (with optional scrapeRunId attached)
 * @returns       Number of documents upserted/modified
 */
export async function bulkUpsertLeads(
  leads: Array<Omit<LeadDocument, "_id">>
): Promise<{ upserted: number; modified: number }> {
  if (!leads || leads.length === 0) return { upserted: 0, modified: 0 };

  const c = await col();
  const now = new Date();

  // Build bulkWrite operations: one updateOne (upsert) per lead
  const ops = leads.map((lead) => {
    // Match priority: linkedinUrl → email → companyName
    const filter: Record<string, any> = {};
    const lUrl = (lead as any).linkedinProfileUrl || (lead as any).linkedinUrl;
    if (lUrl) {
      filter.linkedinUrl = lUrl;
    } else if ((lead as any).email) {
      filter.email = (lead as any).email;
    } else {
      filter.companyName = (lead as any).companyName || "";
    }

    return {
      updateOne: {
        filter,
        update: {
          $set: { ...lead, updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        upsert: true,
      },
    };
  });

  try {
    const result = await c.bulkWrite(ops, { ordered: false });
    return {
      upserted: result.upsertedCount ?? 0,
      modified: result.modifiedCount ?? 0,
    };
  } catch (err: any) {
    // Log but don't crash — fall back to individual upserts
    console.warn("[bulkUpsertLeads] bulkWrite failed, falling back to individual upserts:", err.message);
    let count = 0;
    for (const lead of leads) {
      try {
        await upsertLead(lead);
        count++;
      } catch { /* non-fatal */ }
    }
    return { upserted: count, modified: 0 };
  }
}

