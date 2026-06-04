// @ts-nocheck
// ─── Email Extractor ──────────────────────────────────────────────────────────
// Step 1: Visit homepage + high-probability paths
// Step 2: Extract & rank emails
// Step 3: If nothing real found, return empty (confidence 0)

import { ddgGet, jitter } from "../scrapers/linkedinScraper.ts";
import { isDomainAlive, isValidEmail } from "./validation.ts";

const EMAIL_REGEX = /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g;

// Prioritized prefixes for ranking
const PREFIX_RANK = ["hr", "careers", "jobs", "talent", "recruit", "hiring", "people", "info", "hello", "contact", "support"];

// Known file extensions that should NEVER appear as TLDs in a real email
const FILE_EXTENSIONS = new Set([
    "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "tiff",
    "pdf", "doc", "docx", "xls", "xlsx", "zip", "tar", "gz", "js",
    "css", "html", "htm", "xml", "json", "txt", "csv", "mp4", "mp3",
    "woff", "woff2", "ttf", "eot", "otf",
]);



/**
 * @param {string} domain  - e.g. "acme.com"
 * @returns {Promise<{email: string, allEmails: string[], confidence: number}>}
 */
export async function extractEmail(domain) {
    const result = { email: "", allEmails: [], confidence: 0 };
    if (!domain) return result;

    // Quick DNS lookup check to bypass unreachable guessed domains
    if (!await isDomainAlive(domain)) {
        return result;
    }

    const paths = [
        `https://${domain}`,
        `https://www.${domain}`,
        `https://${domain}/contact`,
        `https://${domain}/about`,
    ];

    const found = new Set();
    let baseReachable = false;

    for (let idx = 0; idx < paths.length; idx++) {
        const url = paths[idx];
        try {
            await jitter(300, 800);
            const html = await ddgGet(url, 3000);
            if (html && html.length > 50) {
                baseReachable = true;
                // Match mailto: links and inline emails in text/attributes
                const mailtoMatches = [...html.matchAll(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi)];
                const inlineMatches = [...html.matchAll(EMAIL_REGEX)];

                for (const m of [...mailtoMatches, ...inlineMatches]) {
                    const email = m[1].toLowerCase().trim();
                    if (isValidEmail(email)) {
                        found.add(email);
                    }
                }

                // If we already have domain-matching emails stop early
                const domainEmails = [...found].filter(e => e.endsWith(`@${domain}`) || e.endsWith(`@www.${domain}`));
                if (domainEmails.length > 0) break;
            }
        } catch {
            // If both homepages fail/timeout, skip remaining sub-paths!
            if (idx === 1 && !baseReachable) {
                break;
            }
        }
    }

    if (found.size === 0) return result;

    const ranked = rankEmails([...found], domain);
    result.email      = ranked[0];
    result.allEmails  = ranked;
    result.confidence = ranked[0].includes(domain) ? 85 : 65;
    return result;
}

function rankEmails(emails, domain) {
    return emails.sort((a, b) => {
        const scoreA = getEmailScore(a, domain);
        const scoreB = getEmailScore(b, domain);
        return scoreB - scoreA;
    });
}

function getEmailScore(email, domain) {
    let score = 0;
    const [prefix, emailDomain] = email.split("@");

    // Same domain gets huge bonus
    if (emailDomain === domain || emailDomain === `www.${domain}`) score += 100;

    // Rank by prefix
    const rankIdx = PREFIX_RANK.indexOf(prefix.toLowerCase());
    if (rankIdx !== -1) score += (PREFIX_RANK.length - rankIdx) * 10;

    return score;
}
