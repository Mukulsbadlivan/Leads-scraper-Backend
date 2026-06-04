/**
 * companyDeduplicator.ts — Evaluates duplicate companies based on website,
 * linkedin url, and normalized names, and manages completeness scoring and merging.
 */

import { CompanyDocument } from "../database/models/Company.ts";
import { normalizeCompanyName } from "./companyNormalizer.ts";

/**
 * Normalizes website URLs to a canonical base hostname (e.g. google.com)
 */
export function normalizeWebsite(url: string): string {
  if (!url) return "";
  try {
    let clean = url.trim().toLowerCase();
    if (!/^https?:\/\//i.test(clean)) {
      clean = "http://" + clean;
    }
    const parsed = new URL(clean);
    let host = parsed.hostname;
    if (host.startsWith("www.")) {
      host = host.substring(4);
    }
    return host.replace(/\/+$/, "");
  } catch {
    // Fallback simple string cleaning if URL parsing throws
    return url
      .toLowerCase()
      .replace(/https?:\/\/(www\.)?/i, "")
      .replace(/\/+$/, "")
      .trim();
  }
}

/**
 * Normalizes LinkedIn Company URL to extract the slug
 */
export function normalizeLinkedinUrl(url: string): string {
  if (!url) return "";
  const clean = url.trim().toLowerCase();
  
  // Extract slug from typical patterns: linkedin.com/company/slug or linkedin.com/school/slug
  const match = clean.match(/linkedin\.com\/(?:company|school)\/([a-zA-Z0-9\-_.]+)/i);
  if (match && match[1]) {
    return match[1];
  }
  return clean.replace(/https?:\/\/(www\.)?/i, "").replace(/\/+$/, "");
}

/**
 * Evaluates a completeness score for a company document.
 * Higher score represents a more enriched and reliable record.
 */
export function calculateCompanyCompleteness(company: CompanyDocument): number {
  let score = 0;

  // Essential unique identifier fields (weighted higher)
  if (company.website && company.website.trim().length > 0) score += 3;
  if (company.linkedinUrl && company.linkedinUrl.trim().length > 0) score += 3;
  if (company.companyName && company.companyName.trim().length > 0) score += 1;

  // Information fields
  const fields: (keyof CompanyDocument)[] = [
    "industry",
    "sector",
    "companyType",
    "country",
    "state",
    "city",
    "fundingStage",
    "numberOfEmployees",
    "employeeSize",
    "techStack",
    "techStackDetailed",
    "fundingInfo"
  ];

  for (const field of fields) {
    const val = company[field];
    if (val !== undefined && val !== null && val !== "") {
      if (typeof val === "string" && val.trim().length === 0) continue;
      score += 1;
    }
  }

  // Boolean flags
  if (company.isB2BSaaS === true || company.isB2BSaaS === false) score += 0.5;
  if (company.recentFundingSignal === true || company.recentFundingSignal === false) score += 0.5;

  return score;
}

/**
 * Checks if two company records represent the same company.
 */
export function isDuplicateCompany(
  c1: CompanyDocument,
  c2: CompanyDocument
): { isDup: boolean; reason: string } {
  // 1. Match by website domain
  if (c1.website && c2.website) {
    const w1 = normalizeWebsite(c1.website);
    const w2 = normalizeWebsite(c2.website);
    if (w1 && w2 && w1 === w2) {
      return { isDup: true, reason: `website_match: ${w1}` };
    }
  }

  // 2. Match by LinkedIn URL
  if (c1.linkedinUrl && c2.linkedinUrl) {
    const l1 = normalizeLinkedinUrl(c1.linkedinUrl);
    const l2 = normalizeLinkedinUrl(c2.linkedinUrl);
    if (l1 && l2 && l1 === l2) {
      return { isDup: true, reason: `linkedin_url_match: ${l1}` };
    }
  }

  // 3. Match by Normalized Name
  const n1 = c1.normalizedName || normalizeCompanyName(c1.companyName);
  const n2 = c2.normalizedName || normalizeCompanyName(c2.companyName);
  if (n1 && n2 && n1 === n2) {
    return { isDup: true, reason: `normalized_name_match: ${n1}` };
  }

  return { isDup: false, reason: "" };
}

/**
 * Merges the secondary company document into primary.
 * Returns the merged document and a list of field names that were updated.
 */
export function mergeCompanies(
  primary: CompanyDocument,
  secondary: CompanyDocument
): { merged: CompanyDocument; mergedFields: string[] } {
  const merged = { ...primary };
  const mergedFields: string[] = [];

  for (const key of Object.keys(secondary) as (keyof CompanyDocument)[]) {
    if (key === "_id" || key === "createdAt" || key === "updatedAt") continue;

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

  merged.updatedAt = new Date();
  return { merged, mergedFields };
}
