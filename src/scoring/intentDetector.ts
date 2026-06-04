// @ts-nocheck
/**
 * Intent Detector
 * Maps lead signals (job posts, tech stack, funding, etc.) to specific business intents.
 */

export interface Intent {
    id: number;
    name: string;
    description: string;
    confidence: number;
}

export function detectIntents(lead: any): Intent[] {
    const intents: Intent[] = [];
    const jobPosts = lead.companyJobPosts || [];
    const allText = (
        (lead.jobTitle || "") + " " +
        (lead.jobDescription || "") + " " +
        (jobPosts.map(p => p.jobTitle + " " + (p.description || "")).join(" ")) + " " +
        (lead.newsHeadline || "") + " " +
        (lead.sector || "")
    ).toLowerCase();

    const techStack = JSON.stringify(lead.techStackDetailed || lead.techStack || "").toLowerCase();

    // 1. Digital transformation inquiry
    if (/modernisation|legacy migration|digital transformation|monolith to microservices/i.test(allText)) {
        intents.push({
            id: 1,
            name: "Digital transformation inquiry",
            description: "Company posted 'modernisation', 'legacy migration' job or blog.",
            confidence: 0.8
        });
    }

    // 2. Cybersecurity audit request
    const hasCybersecurityRole = /cybersecurity|information security|iso27001|soc2|gdpr compliance/i.test(allText);
    const hasFunding = !!lead.recentFundingSignal || /funding|raised/i.test(allText);
    if (hasCybersecurityRole || (hasCybersecurityRole && hasFunding)) {
        intents.push({
            id: 2,
            name: "Cybersecurity audit request",
            description: "ISO/SOC2/GDPR compliance role posted or funding received.",
            confidence: hasFunding ? 0.9 : 0.7
        });
    }

    // 3. Cloud migration scoping
    if (/aws|azure|gcp|google cloud/i.test(allText) && /migration|lift-and-shift|lift and shift|transition/i.test(allText)) {
        intents.push({
            id: 3,
            name: "Cloud migration scoping",
            description: "Evaluating AWS / Azure / GCP lift-and-shift for infrastructure.",
            confidence: 0.85
        });
    }

    // 4. ERP/CRM implementation
    if (/sap|oracle|salesforce|dynamics 365|erp admin|crm admin|implementation consultant/i.test(allText)) {
        intents.push({
            id: 4,
            name: "ERP/CRM implementation",
            description: "SAP/Oracle/Salesforce admin or consultant hiring.",
            confidence: 0.9
        });
    }

    // 5. IT staff augmentation
    const contractRoles = jobPosts.filter(p => /contract|short-term|freelance|temporary/i.test(p.jobTitle || ""));
    if (contractRoles.length >= 3) {
        intents.push({
            id: 5,
            name: "IT staff augmentation",
            description: "Multiple short-term tech contract roles open simultaneously.",
            confidence: 0.75
        });
    }

    // 6. Managed services evaluation
    if (/noc|helpdesk|infrastructure monitoring|managed services|it support/i.test(allText)) {
        intents.push({
            id: 6,
            name: "Managed services evaluation",
            description: "NOC, helpdesk, infra monitoring job postings.",
            confidence: 0.8
        });
    }

    // 7. AI/ML pilot exploration
    const isHiringAI = /data scientist|ml engineer|machine learning|ai engineer|nlp engineer/i.test(allText);
    const hasAIStack = /tensorflow|pytorch|openai|scikit-learn|pandas|numpy/i.test(techStack);
    if (isHiringAI && !hasAIStack) {
        intents.push({
            id: 7,
            name: "AI/ML pilot exploration",
            description: "Data scientist or ML engineer hiring + no existing AI stack.",
            confidence: 0.85
        });
    }

    // 8. Data warehouse/BI setup
    if (/bi developer|snowflake|dbt|tableau|power bi|data warehouse|looker/i.test(allText)) {
        intents.push({
            id: 8,
            name: "Data warehouse/BI setup",
            description: "BI developer, Snowflake, dbt or Tableau role posted.",
            confidence: 0.9
        });
    }

    // 10. Compliance gap assessment
    const hasComplianceRole = /legal officer|compliance officer|data protection officer/i.test(allText);
    const hasExpansion = /expansion|new market|international growth/i.test(allText) || !!lead.recentFundingSignal;
    if (hasComplianceRole && hasExpansion) {
        intents.push({
            id: 10,
            name: "Compliance gap assessment",
            description: "Legal/compliance officer hired + funding or expansion news.",
            confidence: 0.9
        });
    }

    // 12. Technology vendor selection
    if (/comparing|vs|evaluation|selection|alternatives to/i.test(allText) && /tool|software|platform|vendor/i.test(allText)) {
        intents.push({
            id: 12,
            name: "Technology vendor selection",
            description: "Blog posts, LinkedIn polls, or Reddit threads comparing tools.",
            confidence: 0.6
        });
    }

    // 13. Bulk tech hiring campaign
    if (jobPosts.length >= 10) {
        intents.push({
            id: 13,
            name: "Bulk tech hiring campaign",
            description: "10+ open engineering roles posted at the same company.",
            confidence: 0.95
        });
    }

    // 14. C-level / executive search
    if (/cto|cpo|ciso|vp engineering|vp eng|head of engineering/i.test(allText) || /leadership change|new executive/i.test(lead.newsHeadline || "")) {
        intents.push({
            id: 14,
            name: "C-level / executive search",
            description: "CTO, CPO, CISO, VP Eng role posted or leadership change news.",
            confidence: 0.85
        });
    }

    // 18. Employer branding consultation
    const rating = parseFloat(lead.companyRating) || 0;
    const lowGrowth = lead.linkedinFollowerGrowth < 2; // Assuming this metric exists
    if ((rating > 0 && rating < 3.2) || lowGrowth) {
        intents.push({
            id: 18,
            name: "Employer branding consultation",
            description: "Negative Glassdoor reviews or low LinkedIn follower growth.",
            confidence: 0.7
        });
    }

    // 19. Hiring process audit
    // Checking for same role reposted 3+ times might need historical data, 
    // but we can check if there are duplicate job titles in the current scrape.
    const roleFrequencies = {};
    jobPosts.forEach(p => {
        const title = (p.jobTitle || "").toLowerCase();
        roleFrequencies[title] = (roleFrequencies[title] || 0) + 1;
    });
    const hasHighRepost = Object.values(roleFrequencies).some(count => count >= 3);
    if (hasHighRepost) {
        intents.push({
            id: 19,
            name: "Hiring process audit",
            description: "High job repost frequency — same role reposted 3+ times.",
            confidence: 0.8
        });
    }

    // 20. LinkedIn pain signal — tool evaluation
    const liSignals = lead.linkedinPainSignals || [];
    if (liSignals.includes("tool_evaluation")) {
        intents.push({ id: 20, name: "Active tool evaluation", description: "CEO/CTO posted asking for tool recommendations or comparing vendors.", confidence: 0.95 });
    }

    // 21. LinkedIn pain signal — scaling infra
    if (liSignals.includes("scaling_infra")) {
        intents.push({ id: 21, name: "Infrastructure scaling pain", description: "CEO/CTO posted about scaling or infrastructure problems.", confidence: 0.9 });
    }

    // 22. LinkedIn pain signal — AI interest
    if (liSignals.includes("ai_interest")) {
        intents.push({ id: 22, name: "AI/Automation interest", description: "CEO/CTO actively posting about AI or automation adoption.", confidence: 0.85 });
    }

    return intents;
}
