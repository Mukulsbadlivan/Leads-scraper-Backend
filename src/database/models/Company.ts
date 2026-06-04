import { ObjectId } from "mongodb";

/**
 * Represents a company discovered and enriched by the scraper pipeline.
 * Maps to the `companies` collection in MongoDB.
 */
export interface CompanyDocument {
  _id?: ObjectId;

  // ── Identity ────────────────────────────────────────────────────────────────
  companyName: string;
  normalizedName?: string;
  website?: string;
  companyProfileUrl?: string;    // job-board or LinkedIn company page URL
  websiteConfidence?: number;

  // ── LinkedIn ─────────────────────────────────────────────────────────────────
  linkedinUrl?: string;
  linkedinCompanySlug?: string;
  linkedinCompanyId?: string;
  linkedinConfidence?: number;
  linkedinFollowers?: number;

  // ── Classification ───────────────────────────────────────────────────────────
  sector?: string;
  industry?: string;
  companyType?: string;
  country?: string;
  state?: string;
  city?: string;
  fundingStage?: string;
  isB2BSaaS?: boolean;

  // ── Size ─────────────────────────────────────────────────────────────────────
  numberOfEmployees?: string;
  employeeSource?: string;
  employeeSize?: string;          // keyword-fallback band e.g. "51-200"

  // ── Tech Stack ───────────────────────────────────────────────────────────────
  techStack?: string;
  techStackDetailed?: Record<string, unknown> | string;

  // ── Funding & News ───────────────────────────────────────────────────────────
  fundingInfo?: string;
  recentFundingSignal?: boolean;

  // ── Meta ─────────────────────────────────────────────────────────────────────
  createdAt?: Date;
  updatedAt?: Date;
}
