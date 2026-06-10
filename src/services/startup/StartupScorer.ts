/**
 * StartupScorer.ts — Scores startup companies on growth and hiring signals.
 *
 * Produces a composite `startupScore` (0–100) built from four sub-scores:
 *
 *   ┌────────────────────────────┬──────────────┐
 *   │ Component                  │ Max Points   │
 *   ├────────────────────────────┼──────────────┤
 *   │ Funding stage premium      │      25      │
 *   │ Hiring signal strength     │      30      │
 *   │ Growth signal strength     │      30      │
 *   │ Data quality bonus         │      15      │
 *   └────────────────────────────┴──────────────┘
 *
 * The resulting score drives the `growthTier` classification:
 *   • Hot  → score ≥ 70
 *   • Warm → score ≥ 40
 *   • Cold → score < 40
 *
 * ISOLATED — reads from startup_companies + startup_executives only.
 * Writes the scored record to startup_leads via StartupLeadRepository.
 * NEVER writes to the existing leads/companies/signals collections.
 */
import { ObjectId } from "mongodb";
import { StartupCompanyDocument } from "../../database/models/StartupCompany.ts";
import { StartupExecutiveDocument } from "../../database/models/StartupExecutive.ts";
import { upsertStartupLead } from "../../database/repositories/StartupLeadRepository.ts";
import { GrowthTier } from "../../database/models/StartupLead.ts";

// ─── Public Types ──────────────────────────────────────────────────────────────

/**
 * Full scoring result returned by {@link scoreAndSaveStartupLead}.
 * Also written as part of the StartupLeadDocument.
 */
export interface StartupScore {
  /** Composite 0–100 score. Higher is more attractive. */
  startupScore: number;
  /** Qualitative tier derived from startupScore. */
  growthTier: GrowthTier;
  /** 0–100 hiring activity component (scaled from 30-point raw). */
  hiringSignalStrength: number;
  /** 0–100 growth activity component (scaled from 30-point raw). */
  growthSignalStrength: number;
  /** Human-readable hiring signals that contributed to the score. */
  hiringSignals: string[];
  /** Human-readable growth signals that contributed to the score. */
  growthSignals: string[];
}

// ─── Sub-Scorers ──────────────────────────────────────────────────────────────

/**
 * Returns a 0–25 funding-stage premium based on the company's stated
 * funding stage. Later stages are valued higher because they signal
 * proven market fit and larger hiring budgets.
 *
 * @param stage - The raw funding stage string (e.g. "Series A", "Seed").
 * @returns An integer premium in the range [0, 25].
 */
function stagePremium(stage?: string): number {
  if (!stage) return 0;

  const s = stage.toLowerCase();

  if (/pre[- ]?seed/.test(s)) return 8;
  if (/\bseed\b/.test(s)) return 12;
  if (/series a/.test(s)) return 18;
  if (/series b/.test(s)) return 22;
  if (/series c|series d/.test(s)) return 24;
  if (/series [e-z]/.test(s)) return 25;
  if (/ipo|public/.test(s)) return 20;
  if (/acqui/.test(s)) return 15;
  if (/venture|backed/.test(s)) return 10;

  return 5;
}

/**
 * Scores the company's hiring activity on a 0–30 scale.
 *
 * Factors considered:
 *   • Number of open roles (primary signal)
 *   • Number of distinct job listing URLs
 *   • Hiring velocity trend (accelerating / stable / decelerating)
 *   • Proportion of engineering / technical roles (team-building signal)
 *
 * @param company - The startup company document.
 * @returns Raw score (0–30) and array of human-readable signal labels.
 */
function scoreHiringSignals(
  company: StartupCompanyDocument
): { score: number; signals: string[] } {
  let score = 0;
  const signals: string[] = [];

  const roleCount = company.hiringRoles?.length ?? 0;
  const jobCount = company.jobLinks?.length ?? 0;

  // Base score from role count
  if (roleCount >= 10) {
    score += 20;
    signals.push("Aggressive Hiring (10+ roles)");
  } else if (roleCount >= 5) {
    score += 14;
    signals.push("Active Hiring (5+ roles)");
  } else if (roleCount >= 2) {
    score += 8;
    signals.push("Moderate Hiring (2+ roles)");
  } else if (roleCount >= 1) {
    score += 4;
    signals.push("Hiring Active");
  }

  // Bonus: more job links than roles → multiple postings per role
  if (jobCount > roleCount) {
    score += 5;
    signals.push("Multiple Job Listings");
  }

  // Hiring velocity bonus
  const vel = company.hiringVelocity;
  if (vel?.trend === "accelerating") {
    score += 10;
    signals.push("Hiring Accelerating");
  } else if (vel?.trend === "stable" && (vel.last30Days ?? 0) > 3) {
    score += 5;
    signals.push("Consistent Hiring Pace");
  }

  // Engineering / technical role bonus — signals core team build-out
  const engineeringRoles = (company.hiringRoles ?? []).filter((r) =>
    /(engineer|developer|architect|backend|frontend|devops|ml|ai|data|security|infra)/i.test(r)
  );
  if (engineeringRoles.length >= 3) {
    score += 5;
    signals.push("Engineering Team Expansion");
  } else if (engineeringRoles.length >= 1) {
    score += 2;
    signals.push("Technical Hiring Active");
  }

  return { score: Math.min(score, 30), signals };
}

/**
 * Scores the company's broader growth indicators on a 0–30 scale.
 *
 * Factors considered:
 *   • YC backing (strong credibility signal)
 *   • Web and LinkedIn presence
 *   • Number of identified executives
 *   • Size of known tech stack
 *   • Expansion / product-launch / partnership signals from enrichment
 *
 * @param company    - The startup company document.
 * @param executives - Executive documents already linked to this company.
 * @returns Raw score (0–30) and array of human-readable signal labels.
 */
function scoreGrowthSignals(
  company: StartupCompanyDocument,
  executives: StartupExecutiveDocument[]
): { score: number; signals: string[] } {
  let score = 0;
  const signals: string[] = [];

  // YC backing is a strong quality signal
  if (company.isYCBacked) {
    score += 12;
    signals.push("Y Combinator Backed");
  }

  // Digital presence signals
  if (company.website) {
    score += 3;
    signals.push("Website Verified");
  }
  if (company.linkedinUrl) {
    score += 3;
    signals.push("LinkedIn Presence");
  }

  // Executive identification signals operational maturity
  const execCount = executives.length;
  if (execCount >= 3) {
    score += 8;
    signals.push(`${execCount} Executives Identified`);
  } else if (execCount >= 1) {
    score += 4;
    signals.push(`${execCount} Executive Identified`);
  }

  // Tech stack breadth suggests product is actively built out
  if (company.techStack && company.techStack.length >= 3) {
    score += 4;
    signals.push("Established Tech Stack");
  } else if (company.techStack && company.techStack.length >= 1) {
    score += 2;
    signals.push("Tech Stack Identified");
  }

  // Process any free-text growth signals surfaced during enrichment
  for (const sig of company.growthSignals ?? []) {
    if (/new office|expansion|opens/i.test(sig)) {
      score += 5;
      signals.push(sig);
    } else if (/product launch|launch|released|ships/i.test(sig)) {
      score += 4;
      signals.push(sig);
    } else if (/partnership|integrates?|announces?/i.test(sig)) {
      score += 3;
      signals.push(sig);
    }
    // Cap at 30 — no need to continue past the ceiling
    if (score >= 30) break;
  }

  return { score: Math.min(score, 30), signals };
}

/**
 * Computes a data-quality bonus (0–15) based on which key fields
 * are populated on the company record.
 *
 * @param company    - The startup company document.
 * @param executives - Executive documents for the company.
 * @returns Integer quality bonus.
 */
function dataQualityBonus(
  company: StartupCompanyDocument,
  executives: StartupExecutiveDocument[]
): number {
  let bonus = 0;

  if (company.website) bonus += 3;
  if (company.linkedinUrl) bonus += 3;
  if (company.foundingYear) bonus += 2;
  if (company.industry) bonus += 2;
  if (company.companySize || company.headcount) bonus += 2;
  if (executives.length > 0) bonus += 3;

  return Math.min(bonus, 15);
}

// ─── Main Scoring Function ────────────────────────────────────────────────────

/**
 * Computes the composite startup score for a company + its executives,
 * then upserts the result into the `startup_leads` collection.
 *
 * Score breakdown:
 *   ```
 *   startupScore = stagePremium (≤25)
 *                + hiringScore   (≤30)
 *                + growthScore   (≤30)
 *                + qualityBonus  (≤15)
 *   ```
 * Capped at 100.
 *
 * @param company    - The startup company document (must include `_id`).
 * @param executives - Executive documents already stored for this company.
 * @returns The full {@link StartupScore} result after persisting the lead.
 *
 * @example
 * ```ts
 * const executives = await findExecutivesByCompany(company._id);
 * const score = await scoreAndSaveStartupLead(company, executives);
 * console.log(`${company.companyName}: ${score.startupScore} (${score.growthTier})`);
 * ```
 */
export async function scoreAndSaveStartupLead(
  company: StartupCompanyDocument & { _id: ObjectId },
  executives: StartupExecutiveDocument[]
): Promise<StartupScore> {
  // ── Sub-score computation ─────────────────────────────────────────────────
  const stageScore = stagePremium(company.companyStage);
  const { score: hiringScore, signals: hiringSignals } = scoreHiringSignals(company);
  const { score: growthScore, signals: growthSignals } = scoreGrowthSignals(company, executives);
  const qualityBonus = dataQualityBonus(company, executives);

  // ── Composite score ───────────────────────────────────────────────────────
  const startupScore = Math.min(
    stageScore + hiringScore + growthScore + qualityBonus,
    100
  );

  // ── Tier classification ───────────────────────────────────────────────────
  const growthTier: GrowthTier =
    startupScore >= 70 ? "Hot" :
    startupScore >= 40 ? "Warm" :
    "Cold";

  // ── Scale raw sub-scores to 0–100 for the lead record fields ─────────────
  // Raw hiring/growth scores are out of 30; multiply by (10/3) ≈ 3.33 to reach 100
  const hiringSignalStrength = Math.min(
    Math.round(hiringScore * (10 / 3)),
    100
  );
  const growthSignalStrength = Math.min(
    Math.round(growthScore * (10 / 3)),
    100
  );

  // ── Persist the lead ──────────────────────────────────────────────────────
  await upsertStartupLead({
    startupCompanyId: company._id,
    jobLinks: company.jobLinks ?? [],
    hiringRoles: company.hiringRoles ?? [],
    startupScore,
    growthTier,
    hiringSignalStrength,
    growthSignalStrength,
    discoverySource: company.sourceTracking?.[0]?.source ?? "unknown",
    sourceTracking: [{ source: "startup_scorer", fetchedAt: new Date() }],
  });

  console.log(
    `[StartupScorer] ${company.companyName} → ` +
      `score=${startupScore}, tier=${growthTier}, ` +
      `hiring=${hiringScore}/30, growth=${growthScore}/30, ` +
      `stage=${stageScore}/25, quality=${qualityBonus}/15`
  );

  return {
    startupScore,
    growthTier,
    hiringSignalStrength,
    growthSignalStrength,
    hiringSignals,
    growthSignals,
  };
}
