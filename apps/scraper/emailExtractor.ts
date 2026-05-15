// @ts-nocheck
// ─── Email Extractor ──────────────────────────────────────────────────────────
// Step 1: Visit homepage + high-probability paths
// Step 2: Extract & rank emails
// Step 3: If nothing real found, return empty (confidence 0)

import { ddgGet, jitter } from "./linkedinScraper.ts";

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
 * Strict email validator — rejects filenames, URL-encoded strings,
 * file-extension TLDs, sentry addresses, and placeholder emails.
 */
function isValidEmail(email = "") {
    if (!email || !email.includes("@")) return false;

    // Reject URL-encoded strings immediately (e.g. csat%20champion@1x.png)
    if (email.includes("%")) return false;

    const [local, domain] = email.split("@");
    if (!local || !domain || !domain.includes(".")) return false;

    // Reject oversized local parts
    if (local.length < 1 || local.length > 64) return false;

    // Reject image/asset-like local parts (ends with 1x, 2x, 3x etc.)
    if (/\d+x$/.test(local)) return false;

    // Reject common image/asset name prefixes in the local part
    if (/(?:^|[_\-])(?:logo|icon|image|img|banner|avatar|photo|thumbnail|sprite|bg|background|hero|cover|placeholder)(?:[_\-@]|$)/i.test(local)) return false;

    const domainParts = domain.split(".");
    const tld = domainParts[domainParts.length - 1];

    // TLD must be pure letters, 2–6 chars — rejects .png, .jpg, .1x, .2x, etc.
    if (!/^[a-zA-Z]{2,6}$/.test(tld)) return false;

    // Reject known file extensions masquerading as TLDs
    if (FILE_EXTENSIONS.has(tld.toLowerCase())) return false;

    // Reject 4+ sub-level domains (e.g. o1234.ingest.eu.sentry.io)
    if (domainParts.length > 3) return false;

    // Reject domains whose first part starts with a digit (e.g. 1x.png)
    if (/^\d/.test(domainParts[0])) return false;

    // Reject sentry / tracking service addresses
    if (domain.includes("sentry") || domain.includes(".ingest.")) return false;

    // Reject noreply / bounce / daemon addresses
    if (/^(noreply|no-reply|donotreply|bounce|mailer|daemon|postmaster|automailer)$/i.test(local)) return false;

    // Reject test / placeholder emails
    const PLACEHOLDER_EMAILS = [
        "john@company.com", "jane@company.com", "user@example.com",
        "test@test.com", "email@example.com", "name@domain.com",
    ];
    if (PLACEHOLDER_EMAILS.includes(email)) return false;

    // Reject known bad domains
    if (["example.com", "w3.org", "test.com", "domain.com"].includes(domain)) return false;

    // Reject if domain contains a path separator or space
    if (/[\/\\\s]/.test(domain)) return false;

    // Reject @yourdomain.*
    if (domain.startsWith("yourdomain")) return false;

    // Reject UUID / long hex hash local parts
    if (/^[0-9a-f]{32,}$/i.test(local.replace(/-/g, ""))) return false;

    return true;
}

/**
 * @param {string} domain  - e.g. "acme.com"
 * @returns {Promise<{email: string, allEmails: string[], confidence: number}>}
 */
export async function extractEmail(domain) {
    const result = { email: "", allEmails: [], confidence: 0 };
    if (!domain) return result;

    const paths = [
        `https://${domain}`,
        `https://www.${domain}`,
        `https://${domain}/careers`,
        `https://${domain}/jobs`,
        `https://${domain}/contact`,
        `https://${domain}/about`,
        `https://${domain}/contact-us`,
        `https://www.${domain}/careers`,
        `https://www.${domain}/contact`,
    ];

    const found = new Set();

    for (const url of paths) {
        try {
            await jitter(300, 800);
            const html = await ddgGet(url, 8000);
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
        } catch { /* 404 / timeout — try next */ }
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
