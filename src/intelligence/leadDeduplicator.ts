/**
 * leadDeduplicator.ts — Evaluates duplicate leads based on LinkedIn URL, email,
 * and contact name + company name, and manages completeness scoring and merging.
 */

import { LeadDocument } from "../database/models/Lead.ts";
import { normalizeLinkedinUrl, normalizeWebsite } from "./companyDeduplicator.ts";
import { normalizeCompanyName } from "./companyNormalizer.ts";

/**
 * Normalizes contact names by lowercasing and stripping punctuation/whitespace
 */
export function normalizeContactName(name: string): string {
  if (!name) return "";
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w]/g, ""); // strip everything except letters/digits
}

/**
 * Evaluates a completeness score for a lead document.
 * Higher score represents a more enriched contact.
 */
export function calculateLeadCompleteness(lead: LeadDocument): number {
  let score = 0;

  // Key contact details (weighted heavily)
  if (lead.email && lead.email.trim().length > 0) score += 4;
  if (lead.linkedinProfileUrl && lead.linkedinProfileUrl.trim().length > 0) score += 3;
  else if (lead.linkedinUrl && lead.linkedinUrl.trim().length > 0) score += 3;

  if (lead.contactName && lead.contactName.trim().length > 0) score += 1.5;
  if (lead.phoneNumber && lead.phoneNumber.trim().length > 0) score += 1.5;
  if (lead.icpScore && lead.icpScore > 0) score += 1;

  // General profile details
  const fields: (keyof LeadDocument)[] = [
    "designation",
    "ceoName",
    "cfoName",
    "ctoName",
    "cooName",
    "companyName",
    "website",
    "sector",
    "industry",
    "country",
    "state",
    "city",
    "fundingStage",
    "numberOfEmployees",
    "jobTitle",
    "jobLink"
  ];

  for (const field of fields) {
    const val = lead[field];
    if (val !== undefined && val !== null && val !== "") {
      if (typeof val === "string" && val.trim().length === 0) continue;
      score += 0.5;
    }
  }

  // Arrays
  if (Array.isArray(lead.allEmails) && lead.allEmails.length > 0) score += 0.5;
  if (Array.isArray(lead.intents) && lead.intents.length > 0) score += 0.5;

  return score;
}

/**
 * Checks if two lead records represent the same individual.
 */
export function isDuplicateLead(
  l1: LeadDocument,
  l2: LeadDocument
): { isDup: boolean; reason: string } {
  // 1. Match by LinkedIn Profile URL
  const link1 = l1.linkedinProfileUrl || l1.linkedinUrl;
  const link2 = l2.linkedinProfileUrl || l2.linkedinUrl;
  if (link1 && link2) {
    const cLink1 = normalizeLinkedinUrl(link1);
    const cLink2 = normalizeLinkedinUrl(link2);
    if (cLink1 && cLink2 && cLink1 === cLink2) {
      return { isDup: true, reason: `linkedin_url_match: ${cLink1}` };
    }
  }

  // 2. Match by Email Address
  if (l1.email && l2.email) {
    const e1 = l1.email.toLowerCase().trim();
    const e2 = l2.email.toLowerCase().trim();
    if (e1 && e2 && e1 === e2) {
      return { isDup: true, reason: `email_match: ${e1}` };
    }
  }

  // 3. Match by Contact Name + Company
  if (l1.contactName && l2.contactName) {
    const n1 = normalizeContactName(l1.contactName);
    const n2 = normalizeContactName(l2.contactName);

    if (n1 && n2 && n1 === n2) {
      // If company IDs match (preferred)
      if (l1.companyId && l2.companyId) {
        if (l1.companyId.toString() === l2.companyId.toString()) {
          return { isDup: true, reason: `name_company_id_match: ${l1.contactName}` };
        }
      }

      // If company names match
      if (l1.companyName && l2.companyName) {
        const comp1 = normalizeCompanyName(l1.companyName);
        const comp2 = normalizeCompanyName(l2.companyName);
        if (comp1 && comp2 && comp1 === comp2) {
          return { isDup: true, reason: `name_company_name_match: ${l1.contactName} @ ${l1.companyName}` };
        }
      }
    }
  }

  return { isDup: false, reason: "" };
}

/**
 * Merges the secondary lead document into primary.
 * Returns the merged document and a list of field names that were updated.
 */
export function mergeLeads(
  primary: LeadDocument,
  secondary: LeadDocument
): { merged: LeadDocument; mergedFields: string[] } {
  const merged = { ...primary };
  const mergedFields: string[] = [];

  for (const key of Object.keys(secondary) as (keyof LeadDocument)[]) {
    if (
      key === "_id" ||
      key === "createdAt" ||
      key === "updatedAt" ||
      key === "companyId" ||
      key === "scrapeRunId" ||
      key === "allEmails" ||
      key === "intents"
    ) {
      continue;
    }

    const priVal = primary[key];
    const secVal = secondary[key];

    const isPriEmpty =
      priVal === undefined ||
      priVal === null ||
      priVal === "" ||
      (typeof priVal === "string" && priVal.trim().length === 0);

    const isSecFilled =
      secVal !== undefined &&
      secVal !== null &&
      secVal !== "" &&
      (typeof secVal === "string" && secVal.trim().length > 0);

    if (isPriEmpty && isSecFilled) {
      (merged as any)[key] = secVal;
      mergedFields.push(key);
    }
  }

  // Merge allEmails list
  const existingEmails = new Set(
    (merged.allEmails || []).map((e) => e.toLowerCase().trim()).filter(Boolean)
  );
  if (primary.email) {
    existingEmails.add(primary.email.toLowerCase().trim());
  }

  const newEmails = (secondary.allEmails || [])
    .filter((e) => e && !existingEmails.has(e.toLowerCase().trim()));

  if (secondary.email && !existingEmails.has(secondary.email.toLowerCase().trim())) {
    newEmails.push(secondary.email);
  }

  if (newEmails.length > 0) {
    merged.allEmails = [...(merged.allEmails || []), ...newEmails];
    mergedFields.push("allEmails");
  }

  // Merge intents list
  const existingIntents = new Set((merged.intents || []).map((i) => i.id).filter(Boolean));
  const newIntents = (secondary.intents || []).filter((i) => i && i.id && !existingIntents.has(i.id));

  if (newIntents.length > 0) {
    merged.intents = [...(merged.intents || []), ...newIntents];
    mergedFields.push("intents");
  }

  merged.updatedAt = new Date();
  return { merged, mergedFields };
}
