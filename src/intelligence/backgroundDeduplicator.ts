/**
 * backgroundDeduplicator.ts — Dispatches batch scans to deduplicate existing
 * companies and leads in MongoDB and cascades relational foreign keys.
 */

import { ObjectId } from "mongodb";
import { getDb } from "../database/connection.ts";
import { CompanyDocument } from "../database/models/Company.ts";
import { LeadDocument } from "../database/models/Lead.ts";
import {
  calculateCompanyCompleteness,
  isDuplicateCompany,
  mergeCompanies,
  normalizeWebsite,
  normalizeLinkedinUrl
} from "./companyDeduplicator.ts";
import {
  calculateLeadCompleteness,
  isDuplicateLead,
  mergeLeads,
  normalizeContactName
} from "./leadDeduplicator.ts";
import { insertDuplicateAudit } from "../database/repositories/DuplicateAuditRepository.ts";

/**
 * Union-Find (Disjoint-Set) structure for clustering matching records
 */
class UnionFind {
  parent: Map<string, string> = new Map();

  find(id: string): string {
    if (!this.parent.has(id)) {
      this.parent.set(id, id);
      return id;
    }
    let curr = id;
    while (this.parent.get(curr) !== curr) {
      curr = this.parent.get(curr)!;
    }
    // Path compression
    let p = id;
    while (p !== curr) {
      const next = this.parent.get(p)!;
      this.parent.set(p, curr);
      p = next;
    }
    return curr;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) {
      this.parent.set(rootA, rootB);
    }
  }
}

/**
 * Runs the complete data quality deduplication job on companies and leads
 */
export async function runDeduplication(): Promise<{ companiesMerged: number; leadsMerged: number }> {
  console.log("[DedupWorker] 🔍 Running background database deduplication...");
  const db = await getDb();
  
  let companiesMerged = 0;
  let leadsMerged = 0;

  // ─── 1. COMPANY DEDUPLICATION ──────────────────────────────────────────────

  try {
    const companies = await db.collection<CompanyDocument>("companies").find({}).toArray();
    console.log(`[DedupWorker] Found ${companies.length} total companies in DB.`);

    const compUf = new UnionFind();
    const seenWebsites = new Map<string, string>(); // websiteDomain -> companyId
    const seenLinkedinSlugs = new Map<string, string>(); // linkedinSlug -> companyId
    const seenNames = new Map<string, string>(); // normalizedName -> companyId

    // Map each company and perform unions on matching keys
    for (const comp of companies) {
      const idStr = comp._id!.toString();
      compUf.find(idStr); // Initialize in UF

      // Match by website
      if (comp.website) {
        const domain = normalizeWebsite(comp.website);
        if (domain) {
          if (seenWebsites.has(domain)) {
            compUf.union(idStr, seenWebsites.get(domain)!);
          } else {
            seenWebsites.set(domain, idStr);
          }
        }
      }

      // Match by LinkedIn
      if (comp.linkedinUrl) {
        const slug = normalizeLinkedinUrl(comp.linkedinUrl);
        if (slug) {
          if (seenLinkedinSlugs.has(slug)) {
            compUf.union(idStr, seenLinkedinSlugs.get(slug)!);
          } else {
            seenLinkedinSlugs.set(slug, idStr);
          }
        }
      }

      // Match by Normalized Name
      if (comp.normalizedName) {
        const name = comp.normalizedName;
        if (seenNames.has(name)) {
          compUf.union(idStr, seenNames.get(name)!);
        } else {
          seenNames.set(name, idStr);
        }
      }
    }

    // Group companies by their disjoint set root ID
    const companyGroups = new Map<string, CompanyDocument[]>();
    for (const comp of companies) {
      const root = compUf.find(comp._id!.toString());
      if (!companyGroups.has(root)) {
        companyGroups.set(root, []);
      }
      companyGroups.get(root)!.push(comp);
    }

    // Process duplicate groups
    for (const [rootId, group] of companyGroups.entries()) {
      if (group.length <= 1) continue;

      console.log(`[DedupWorker] Merging group of ${group.length} companies...`);

      // Determine the primary record based on completeness
      let primary = group.reduce((best, curr) => {
        const scoreBest = calculateCompanyCompleteness(best);
        const scoreCurr = calculateCompanyCompleteness(curr);
        return scoreCurr > scoreBest ? curr : best;
      });

      // Keep reference to primary's DB ID
      const primaryId = primary._id!;

      for (const comp of group) {
        if (comp._id!.toString() === primaryId.toString()) continue;

        // Merge secondary into primary
        const { merged, mergedFields } = mergeCompanies(primary, comp);
        primary = merged;

        // Log the merge operation to duplicate audit
        await insertDuplicateAudit({
          sourceCollection: "companies",
          originalRecord: primary,
          duplicateRecord: comp,
          mergeReason: `background_batch_merge: ${mergedFields.join(", ") || "identical_record"}`,
          mergedAt: new Date()
        }).catch(() => {});

        // Delete duplicate secondary company
        await db.collection("companies").deleteOne({ _id: comp._id });

        // Update all related records pointing to deleted company to now point to the primary
        await db.collection("leads").updateMany({ companyId: comp._id }, { $set: { companyId: primaryId } });
        await db.collection("jobs").updateMany({ companyId: comp._id }, { $set: { companyId: primaryId } });
        await db.collection("signals").updateMany({ companyId: comp._id }, { $set: { companyId: primaryId } });

        companiesMerged++;
      }

      // Save the merged primary company
      await db.collection("companies").updateOne({ _id: primaryId }, { $set: primary });
    }
  } catch (err: any) {
    console.error("[DedupWorker] ❌ Error deduplicating companies:", err.message);
  }

  // ─── 2. LEAD DEDUPLICATION ─────────────────────────────────────────────────

  try {
    const leads = await db.collection<LeadDocument>("leads").find({}).toArray();
    console.log(`[DedupWorker] Found ${leads.length} total leads in DB.`);

    const leadUf = new UnionFind();
    const seenLinkedinUrls = new Map<string, string>(); // linkedinProfileUrl -> leadId
    const seenEmails = new Map<string, string>(); // email -> leadId
    const seenNameCompanies = new Map<string, string>(); // contactName_companyId -> leadId

    for (const lead of leads) {
      const idStr = lead._id!.toString();
      leadUf.find(idStr); // Initialize

      // Match by LinkedIn profile
      const lUrl = lead.linkedinProfileUrl || lead.linkedinUrl;
      if (lUrl) {
        const slug = normalizeLinkedinUrl(lUrl);
        if (slug) {
          if (seenLinkedinUrls.has(slug)) {
            leadUf.union(idStr, seenLinkedinUrls.get(slug)!);
          } else {
            seenLinkedinUrls.set(slug, idStr);
          }
        }
      }

      // Match by email
      if (lead.email) {
        const email = lead.email.toLowerCase().trim();
        if (email) {
          if (seenEmails.has(email)) {
            leadUf.union(idStr, seenEmails.get(email)!);
          } else {
            seenEmails.set(email, idStr);
          }
        }
      }

      // Match by Name + Company ID
      if (lead.contactName && lead.companyId) {
        const normName = normalizeContactName(lead.contactName);
        const compKey = `${normName}_${lead.companyId.toString()}`;
        if (seenNameCompanies.has(compKey)) {
          leadUf.union(idStr, seenNameCompanies.get(compKey)!);
        } else {
          seenNameCompanies.set(compKey, idStr);
        }
      }
    }

    // Group leads by root ID
    const leadGroups = new Map<string, LeadDocument[]>();
    for (const lead of leads) {
      const root = leadUf.find(lead._id!.toString());
      if (!leadGroups.has(root)) {
        leadGroups.set(root, []);
      }
      leadGroups.get(root)!.push(lead);
    }

    // Process duplicate groups
    for (const [rootId, group] of leadGroups.entries()) {
      if (group.length <= 1) continue;

      console.log(`[DedupWorker] Merging group of ${group.length} leads...`);

      // Determine primary lead based on completeness
      let primary = group.reduce((best, curr) => {
        const scoreBest = calculateLeadCompleteness(best);
        const scoreCurr = calculateLeadCompleteness(curr);
        return scoreCurr > scoreBest ? curr : best;
      });

      const primaryId = primary._id!;

      for (const lead of group) {
        if (lead._id!.toString() === primaryId.toString()) continue;

        // Merge secondary into primary
        const { merged, mergedFields } = mergeLeads(primary, lead);
        primary = merged;

        // Log the merge operation
        await insertDuplicateAudit({
          sourceCollection: "leads",
          originalRecord: primary,
          duplicateRecord: lead,
          mergeReason: `background_batch_merge: ${mergedFields.join(", ") || "identical_record"}`,
          mergedAt: new Date()
        }).catch(() => {});

        // Delete duplicate secondary lead
        await db.collection("leads").deleteOne({ _id: lead._id });

        // Update signals pointing to deleted lead to point to primary lead ID
        await db.collection("signals").updateMany({ leadId: lead._id }, { $set: { leadId: primaryId } });

        leadsMerged++;
      }

      // Save the merged primary lead
      await db.collection("leads").updateOne({ _id: primaryId }, { $set: primary });
    }
  } catch (err: any) {
    console.error("[DedupWorker] ❌ Error deduplicating leads:", err.message);
  }

  console.log(`[DedupWorker] Done. Merged ${companiesMerged} companies and ${leadsMerged} leads.`);
  return { companiesMerged, leadsMerged };
}
