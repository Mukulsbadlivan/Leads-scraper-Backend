/**
 * NewsEnricher.ts — Links news articles to startup company and event records.
 *
 * Responsibilities:
 *   1. Match article company name to startup_companies (and optionally companies)
 *   2. Extract structured events (funding, hiring, growth) from classified articles
 *   3. Insert into funding_events / hiring_events / growth_events collections
 *
 * ISOLATED — writes only to the 3 new event collections.
 * Reads startup_companies and companies (read-only) for cross-referencing.
 */
import { ObjectId } from "mongodb";
import { getDb } from "../../database/connection.ts";
import { CompanyNewsDocument } from "../../database/models/CompanyNews.ts";
import { insertFundingEvent } from "../../database/repositories/FundingEventRepository.ts";
import { insertHiringEvent } from "../../database/repositories/HiringEventRepository.ts";
import { insertGrowthEvent } from "../../database/repositories/GrowthEventRepository.ts";
import { classifyNewsArticle, extractInvestors } from "./NewsClassifier.ts";

export interface CompanyLinkResult {
  startupCompanyId?: ObjectId;
  existingCompanyId?: ObjectId;
  companyName?: string;
}

/**
 * Attempts to link a news article to a startup company by extracting
 * the company name from the title and searching startup_companies.
 *
 * READ-ONLY on both startup_companies and companies.
 */
export async function linkNewsToCompany(
  title: string,
  url: string
): Promise<CompanyLinkResult> {
  const result: CompanyLinkResult = {};

  // Extract company name — typically the first capitalized phrase before action verb
  const companyMatch = title.match(
    /^([A-Z][\w.&'\- ]{1,40?})\s+(?:raises?|secures?|closes?|acquires?|launches?|hires?|appoints?|expands?|opens?|partners?|announces?)/i
  );
  const companyName = companyMatch?.[1]?.trim();
  if (!companyName) return result;

  result.companyName = companyName;

  try {
    const db = await getDb();
    const normName = companyName
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    // Search startup_companies first
    const startupMatch = await db.collection("startup_companies").findOne(
      {
        $or: [
          { normalizedName: normName },
          { companyName: { $regex: new RegExp(`^${companyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") } },
        ],
      },
      { projection: { _id: 1 } }
    );

    if (startupMatch) {
      result.startupCompanyId = startupMatch._id;
      return result;
    }

    // Fallback: search existing companies (READ-ONLY)
    const existingMatch = await db.collection("companies").findOne(
      {
        $or: [
          { normalizedName: normName },
          { companyName: { $regex: new RegExp(`^${companyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") } },
        ],
      },
      { projection: { _id: 1 } }
    );

    if (existingMatch) {
      result.existingCompanyId = existingMatch._id;
    }
  } catch { /* non-fatal — proceed without company link */ }

  return result;
}

/**
 * Processes a news article and inserts structured events based on its classification.
 * Called after a company_news document is inserted.
 */
export async function extractAndSaveEvents(
  newsDoc: CompanyNewsDocument & { _id: ObjectId }
): Promise<{ eventsCreated: number; errors: string[] }> {
  const summary = { eventsCreated: 0, errors: [] as string[] };
  const classification = classifyNewsArticle(newsDoc.title, newsDoc.rawText ?? "");

  try {
    if (classification.eventType === "funding" && classification.fundingRound) {
      const investors = extractInvestors(`${newsDoc.title} ${newsDoc.rawText ?? ""}`);
      // Extract USD amount
      const amountMatch = newsDoc.title.match(/\$([\d.]+)\s*([MB])/i);
      let amount: number | undefined;
      let amountRaw: string | undefined;
      if (amountMatch) {
        const num = parseFloat(amountMatch[1]);
        const multiplier = amountMatch[2].toUpperCase() === "B" ? 1_000_000_000 : 1_000_000;
        amount = num * multiplier;
        amountRaw = amountMatch[0];
      }

      await insertFundingEvent({
        newsId: newsDoc._id,
        startupCompanyId: newsDoc.startupCompanyId,
        existingCompanyId: newsDoc.existingCompanyId,
        companyName: newsDoc.companyName,
        round: classification.fundingRound,
        amount,
        amountRaw,
        currency: amount ? "USD" : undefined,
        investors: investors.length ? investors : undefined,
        leadInvestor: investors[0],
        announcedAt: newsDoc.publishedAt,
        pressReleaseUrl: newsDoc.url,
        sourceTracking: [{ source: newsDoc.source ?? "news", fetchedAt: new Date() }],
      });
      summary.eventsCreated++;
    } else if (classification.eventType === "hiring" && classification.hiringEventType) {
      await insertHiringEvent({
        newsId: newsDoc._id,
        startupCompanyId: newsDoc.startupCompanyId,
        existingCompanyId: newsDoc.existingCompanyId,
        companyName: newsDoc.companyName,
        eventType: classification.hiringEventType,
        announcedAt: newsDoc.publishedAt,
        sourceTracking: [{ source: newsDoc.source ?? "news", fetchedAt: new Date() }],
      });
      summary.eventsCreated++;
    } else if (
      (classification.eventType === "growth" || classification.eventType === "acquisition") &&
      classification.growthEventType
    ) {
      await insertGrowthEvent({
        newsId: newsDoc._id,
        startupCompanyId: newsDoc.startupCompanyId,
        existingCompanyId: newsDoc.existingCompanyId,
        companyName: newsDoc.companyName,
        eventType: classification.growthEventType,
        detail: newsDoc.title,
        announcedAt: newsDoc.publishedAt,
        sourceTracking: [{ source: newsDoc.source ?? "news", fetchedAt: new Date() }],
      });
      summary.eventsCreated++;
    }
  } catch (err: any) {
    summary.errors.push(`extractAndSaveEvents: ${err.message}`);
  }

  return summary;
}
