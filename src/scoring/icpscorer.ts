// @ts-nocheck
// ─── ICP Scorer v2 ────────────────────────────────────────────────────────────
// Incorporates confidence scoring from the new enrichment tiers.

const ICP_CONFIG = {
    targetSectors: [
        "Technology", "AI/ML & Data", "Finance & Fintech",
        "E-Commerce/Retail", "Healthcare", "Cybersecurity",
    ],
    targetEmployeeSizes: ["10-50", "50-500", "10-200", "200-1,000", "1,000-10,000"],
    highValueSignals: [
        "Leadership Hire", "Team Expansion", "AI/ML Investment",
        "Sales Growth", "Infrastructure Scaling",
    ],
    targetDesignations: ["cto", "vp", "director", "head", "founder", "manager", "lead", "principal"],
};

export function scoreICP(lead) {
    // Hard intent rule: Head of Sales + Series B + Fintech
    const hasHeadOfSalesRole = (lead.hiringTopRoles || []).some(r => /head of sales/i.test(r || ""));
    if (hasHeadOfSalesRole && /series b/i.test(lead.fundingStage || "") && /fintech|finance/i.test(lead.sector || "")) {
        return { ...lead, icpScore: 95, icpTier: "Hot" };
    }

    let score = 0;

    // ── Sector fit (25 pts) ───────────────────────────────────────────────────
    score += ICP_CONFIG.targetSectors.includes(lead.sector) ? 25 : 8;

    // ── Signal strength (20 pts) ──────────────────────────────────────────────
    score += ICP_CONFIG.highValueSignals.includes(lead.signalType) ? 20 : 10;

    // ── Employee size (10 pts) ────────────────────────────────────────────────
    score += ICP_CONFIG.targetEmployeeSizes.includes(lead.employeeSize) ? 10 : 3;

    // ── Designation (10 pts) ──────────────────────────────────────────────────
    const desig = (lead.designation || "").toLowerCase();
    score += ICP_CONFIG.targetDesignations.some(d => desig.includes(d)) ? 10 : 0;

    // ── Contact name (5 pts) ──────────────────────────────────────────────────
    score += lead.contactName ? 5 : 0;

    // ── Email confidence (10 pts) — weighted by tier ──────────────────────────
    const emailConf = lead.emailConfidenceScore || 0;
    if (emailConf >= 80) score += 10;
    else if (emailConf >= 60) score += 6;
    else if (emailConf >= 20) score += 2;

    // ── Website confidence (5 pts) ────────────────────────────────────────────
    const webConf = lead.websiteConfidence || 0;
    if (webConf >= 80) score += 5;
    else if (webConf >= 50) score += 3;
    else if (webConf > 0) score += 1;

    // ── LinkedIn confidence (5 pts) ───────────────────────────────────────────
    const liConf = lead.linkedinConfidence || 0;
    if (liConf >= 80) score += 5;
    else if (liConf >= 60) score += 3;
    else if (liConf > 0) score += 1;

    // CTO LinkedIn activity boost
    if (lead.ctoLinkedInActive) score += 10;

    // Recent funding boost
    if (lead.recentFundingSignal) score += 10;

    // Hiring velocity boost
    const hv = lead.hiringVelocity || {};
    if ((hv.last30days || 0) >= 10 && (hv.trend || "") === "accelerating") score += 15;
    else if ((hv.last30days || 0) >= 5) score += 8;

    // Data Engineer hiring now
    const isHiringDataEng = (lead.hiringTopRoles || []).some(r => /data engineer/i.test(r || ""));
    if (isHiringDataEng) score += 8;

    // Target stack fit: Python + AWS
    const stackText = JSON.stringify(lead.techStackDetailed || lead.techStack || "").toLowerCase();
    if (stackText.includes("python") && stackText.includes("aws")) score += 10;

    // ── Company rating (5 pts) ────────────────────────────────────────────────
    const rating = parseFloat(lead.companyRating) || 0;
    score += rating >= 4.0 ? 5 : rating >= 3.5 ? 3 : rating > 0 ? 1 : 0;

    // ── Intent Boost (10 pts) ─────────────────────────────────────────────────
    if (lead.intents && lead.intents.length > 0) {
        score += Math.min(lead.intents.length * 5, 10);
    }

    // ── Data completeness bonus (5 pts) ───────────────────────────────────────
    const fields = [lead.website, lead.linkedinUrl, lead.email, lead.salary, lead.newsHeadline];
    score += Math.round((fields.filter(Boolean).length / fields.length) * 5);

    const final = Math.min(score, 100);
    return {
        ...lead,
        icpScore: final,
        icpTier: final >= 70 ? "Hot" : final >= 45 ? "Warm" : "Cold",
    };
}

