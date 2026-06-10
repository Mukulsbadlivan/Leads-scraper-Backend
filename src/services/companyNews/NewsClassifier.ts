/**
 * NewsClassifier.ts — Classifies news articles into structured event types.
 *
 * Event types: funding | hiring | growth | technology | acquisition | other
 *
 * Works entirely offline — no API keys required.
 * Pure keyword-matching with confidence scoring.
 */
import { NewsEventType } from "../../database/models/CompanyNews.ts";
import { FundingRound } from "../../database/models/FundingEvent.ts";
import { HiringEventType } from "../../database/models/HiringEvent.ts";
import { GrowthEventType } from "../../database/models/GrowthEvent.ts";

export interface ClassificationResult {
  eventType: NewsEventType;
  eventSubtype?: string;
  confidence: number;
  fundingRound?: FundingRound;
  hiringEventType?: HiringEventType;
  growthEventType?: GrowthEventType;
  extractedAmount?: string;
  extractedInvestors?: string[];
}

// ─── Funding Classification ───────────────────────────────────────────────────

const FUNDING_SIGNALS = [
  { pattern: /pre[- ]?seed/i, round: "pre_seed" as FundingRound, weight: 30 },
  { pattern: /\bseed\b/i, round: "seed" as FundingRound, weight: 25 },
  { pattern: /series a\b/i, round: "series_a" as FundingRound, weight: 30 },
  { pattern: /series b\b/i, round: "series_b" as FundingRound, weight: 30 },
  { pattern: /series c\b/i, round: "series_c" as FundingRound, weight: 30 },
  { pattern: /series [def]\b/i, round: "series_d_plus" as FundingRound, weight: 30 },
  { pattern: /\bipo\b|initial public offering/i, round: "ipo" as FundingRound, weight: 35 },
  { pattern: /acqui/i, round: "acquisition" as FundingRound, weight: 35 },
];

const FUNDING_ACTION_WORDS = /raises?|raised|secures?|closes?|lands?|gets?|announces?|completes?|wraps?|nabs?/i;

function classifyFunding(text: string): { round?: FundingRound; confidence: number; amount?: string } {
  const combined = text.toLowerCase();
  let topRound: FundingRound | undefined;
  let maxWeight = 0;

  for (const sig of FUNDING_SIGNALS) {
    if (sig.pattern.test(text)) {
      if (sig.weight > maxWeight) {
        maxWeight = sig.weight;
        topRound = sig.round;
      }
    }
  }

  const hasAction = FUNDING_ACTION_WORDS.test(text);
  const hasMoneyKeyword = /\$\d|million|billion|\bm\b|\bb\b|funding|investment|capital/i.test(text);

  // Extract amount
  const amountMatch = text.match(/\$[\d.,]+\s*(?:million|billion|M|B)?/i);
  const amount = amountMatch?.[0]?.trim();

  let confidence = maxWeight;
  if (hasAction) confidence += 20;
  if (hasMoneyKeyword) confidence += 15;

  return { round: topRound, confidence: Math.min(confidence, 95), amount };
}

// ─── Hiring Classification ────────────────────────────────────────────────────

const HIRING_SIGNALS: Array<{ pattern: RegExp; type: HiringEventType; weight: number }> = [
  { pattern: /new ceo|appoints? ceo|names? ceo|hires? ceo/i, type: "new_ceo", weight: 40 },
  { pattern: /new cto|appoints? cto|names? cto|hires? cto/i, type: "new_cto", weight: 40 },
  { pattern: /new cfo|appoints? cfo|names? cfo|hires? cfo/i, type: "new_cfo", weight: 40 },
  { pattern: /new coo|appoints? coo|names? coo|hires? coo/i, type: "new_coo", weight: 35 },
  { pattern: /leadership change|executive change|c-suite|management change/i, type: "leadership_change", weight: 25 },
  { pattern: /hires? new|appoints? new|names? new|joins? as|promoted? to/i, type: "new_exec", weight: 20 },
  { pattern: /team expan|headcount|hiring spree|\d+\s*new hires?/i, type: "team_expansion", weight: 20 },
];

function classifyHiring(text: string): { type?: HiringEventType; confidence: number } {
  let topType: HiringEventType | undefined;
  let maxWeight = 0;

  for (const sig of HIRING_SIGNALS) {
    if (sig.pattern.test(text)) {
      if (sig.weight > maxWeight) {
        maxWeight = sig.weight;
        topType = sig.type;
      }
    }
  }

  return { type: topType, confidence: Math.min(maxWeight + 10, 90) };
}

// ─── Growth Classification ────────────────────────────────────────────────────

const GROWTH_SIGNALS: Array<{ pattern: RegExp; type: GrowthEventType; weight: number }> = [
  { pattern: /new office|opens? office|expands? to|new headquarter/i, type: "new_office", weight: 35 },
  { pattern: /product launch|launches? product|launches? platform|new product/i, type: "product_launch", weight: 30 },
  { pattern: /geographic expansion|expands? to|enters? market|new market/i, type: "geo_expansion", weight: 30 },
  { pattern: /acquires?|acquisition|merger|bought by/i, type: "acquisition", weight: 35 },
  { pattern: /partnership|partners? with|joint venture/i, type: "partnership", weight: 25 },
  { pattern: /engineering team|tech team|developer team|\d+\s*engineers/i, type: "engineering_growth", weight: 20 },
  { pattern: /team expansion|growing team|expands? team/i, type: "team_expansion", weight: 20 },
];

function classifyGrowth(text: string): { type?: GrowthEventType; confidence: number } {
  let topType: GrowthEventType | undefined;
  let maxWeight = 0;

  for (const sig of GROWTH_SIGNALS) {
    if (sig.pattern.test(text)) {
      if (sig.weight > maxWeight) {
        maxWeight = sig.weight;
        topType = sig.type;
      }
    }
  }

  return { type: topType, confidence: Math.min(maxWeight + 10, 90) };
}

// ─── Technology Classification ────────────────────────────────────────────────

const TECH_SIGNALS = /adopts?|migrates? to|switches? to|rebuilds?|replatforms?|ai\s+strategy|tech stack|kubernetes|cloud.native|microservices/i;

// ─── Main Classifier ──────────────────────────────────────────────────────────

/**
 * Classifies a news article by its title and optional body text.
 * Returns event type, subtype, and confidence score.
 */
export function classifyNewsArticle(
  title: string,
  bodyText = ""
): ClassificationResult {
  const combined = `${title} ${bodyText}`.slice(0, 1000);

  // Try each category in priority order
  const funding = classifyFunding(combined);
  if (funding.confidence >= 40) {
    return {
      eventType: "funding",
      eventSubtype: funding.round,
      fundingRound: funding.round,
      confidence: funding.confidence,
      extractedAmount: funding.amount,
    };
  }

  const hiring = classifyHiring(combined);
  if (hiring.confidence >= 40) {
    return {
      eventType: "hiring",
      eventSubtype: hiring.type,
      hiringEventType: hiring.type,
      confidence: hiring.confidence,
    };
  }

  const growth = classifyGrowth(combined);
  if (growth.confidence >= 35) {
    return {
      eventType: growth.type === "acquisition" ? "acquisition" : "growth",
      eventSubtype: growth.type,
      growthEventType: growth.type,
      confidence: growth.confidence,
    };
  }

  if (TECH_SIGNALS.test(combined)) {
    return { eventType: "technology", confidence: 60 };
  }

  return { eventType: "other", confidence: 30 };
}

/** Extract investor names from article text. */
export function extractInvestors(text: string): string[] {
  const investors: string[] = [];
  // Pattern: "led by X" or "with participation from X, Y"
  const ledBy = text.match(/(?:led|backed)\s+by\s+([A-Z][\w\s&.,]{3,60}?)(?:\s+and\s+[A-Z]|,|\.|$)/i);
  if (ledBy) investors.push(ledBy[1].trim());

  const participated = text.match(/(?:with participation from|participated by)\s+([A-Z][\w\s&.,]{3,100}?)(?:\.|$)/i);
  if (participated) {
    const parts = participated[1].split(/,| and /).map((s) => s.trim()).filter((s) => s.length > 2);
    investors.push(...parts);
  }

  return [...new Set(investors)].slice(0, 10);
}
