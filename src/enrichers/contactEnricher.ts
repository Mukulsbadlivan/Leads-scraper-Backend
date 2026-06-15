// @ts-nocheck
// ─── Contact Enricher ─────────────────────────────────────────────────────────
// Collects: phone · email · numberOfEmployees · linkedinUrl
//
// Source Waterfall (highest → lowest confidence):
//   Tier 1 → Explorium API   — 3-step: match business → match prospect → contact enrich
//   Tier 2 → Proxycurl API   — LinkedIn/company enrichment
//   Tier 3 → Apollo API      — company/contact enrichment
//   Tier 4 → Clearbit API    — company profile: headcount, sector, LinkedIn, phone
//   Tier 5 → Hunter.io API   — domain-search: verified business emails
//   Tier 6 → Website Scrape  — tel: links + phone regex on /contact /about pages
//   Tier 7 → Smart fallback  — disabled (no guessing policy)
//
// Set API keys in .env (see .env.example):
//   EXPLORIUM_API_KEY → https://developers.explorium.ai/
//   PROXYCURL_KEY     → https://nubela.co/proxycurl/
//   APOLLO_KEY        → https://www.apollo.io/
//   CLEARBIT_API_KEY  → https://dashboard.clearbit.com/api
//   HUNTER_KEY        → https://hunter.io/dashboard → API

import https from "https";
import { ddgGet, jitter } from "../scrapers/linkedinScraper.ts";
import { isValidEmail, isDomainAlive } from "../utils/validation.ts";

// ─── ENV helper ───────────────────────────────────────────────────────────────
function env(key) { return process.env[key] || ""; }
function envAny(...keys) {
    for (const key of keys) {
        if (process.env[key]) return process.env[key];
    }
    return "";
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enrich contact data for a company using multiple authentic sources.
 * @param {object} params
 * @param {string} params.companyName   Company display name
 * @param {string} params.domain        e.g. "razorpay.com"
 * @param {string} params.linkedinUrl   Already-known LinkedIn URL (optional)
 * @returns {Promise<ContactResult>}
 */
export async function enrichContact({ companyName, domain, linkedinUrl = "", browser = null }) {
    const result = emptyResult();

    // If we already have a LinkedIn URL, fill it in at confidence 70+
    if (linkedinUrl) {
        result.linkedinUrl        = linkedinUrl;
        result.linkedinConfidence = 70;
    }

    // ── Tier 1: Explorium API (business match → prospect match → contact enrich) ─
    if (envAny("EXPLORIUM_API_KEY") && (companyName || domain) && resultNeedsMore(result)) {
        try {
            const explorium = await exploriumEnrich({ companyName, domain, linkedinUrl });
            mergeResult(result, explorium, "Explorium");
        } catch { /* fallthrough */ }
    }

    // ── Tier 2: Proxycurl API ─────────────────────────────────────────────────
    if (envAny("PROXYCURL_KEY") && (linkedinUrl || domain)) {
        try {
            const proxycurl = await proxycurlEnrich({ domain, linkedinUrl });
            mergeResult(result, proxycurl, "Proxycurl");
        } catch { /* fallthrough */ }
    }

    // ── Tier 3: Apollo API ────────────────────────────────────────────────────
    if (envAny("APOLLO_KEY") && domain && resultNeedsMore(result)) {
        try {
            const apollo = await apolloEnrich({ domain });
            mergeResult(result, apollo, "Apollo");
        } catch { /* fallthrough */ }
    }

    // ── Tier 4: Clearbit API ──────────────────────────────────────────────────
    if (env("CLEARBIT_API_KEY") && domain && resultNeedsMore(result)) {
        try {
            const clearbit = await clearbitEnrich({ domain });
            mergeResult(result, clearbit, "Clearbit");
        } catch { /* fallthrough */ }
    }

    // ── Tier 5: Hunter.io API (email + employee count) ────────────────────────
    if (envAny("HUNTER_KEY", "HUNTER_API_KEY") && domain && (!result.email || result.emailConfidence < 70)) {
        try {
            const hunter = await hunterEnrich({ domain });
            mergeResult(result, hunter, "Hunter");
        } catch { /* fallthrough */ }
    }

    // ── Tier 6: Website Scraping (phone + email) ──────────────────────────────
    if (domain && (!result.phone || !result.email || result.emailConfidence < 50)) {
        try {
            const web = await websiteContactScrape(domain, { browser });
            mergeResult(result, web, "WebScrape");
        } catch { /* fallthrough */ }
    }

    // LinkedIn page text fallback for phone extraction (when website has no phone)
    if (!result.phone && linkedinUrl) {
        try {
            const liPhone = await linkedinPhoneFallback(linkedinUrl, browser);
            if (liPhone) {
                result.phone = liPhone;
                result.phoneSource = "LinkedIn";
            }
        } catch { /* ignore */ }
    }

    // ── Tier 5: Smart Fallback (DISABLED) ─────────────────────────────────────
    // Removed to comply with 'No Guessing' policy.
    if (!result.email && domain) {
        // Only return if verified via APIs or Crawl
    }

    return result;
}

async function proxycurlEnrich({ domain, linkedinUrl = "" }) {
    const result = emptyResult();
    const apiKey = envAny("PROXYCURL_KEY");
    if (!apiKey) return result;

    const headers = { Authorization: `Bearer ${apiKey}` };
    const urls = [];
    if (linkedinUrl) {
        urls.push(`https://nubela.co/proxycurl/api/linkedin/company?url=${encodeURIComponent(linkedinUrl)}&resolve_numeric_id=false`);
    }
    if (domain) {
        urls.push(`https://nubela.co/proxycurl/api/linkedin/company/resolve?company_domain=${encodeURIComponent(domain)}`);
    }

    for (const url of urls) {
        try {
            const raw = await httpsGet(url, 12000, headers);
            const data = JSON.parse(raw || "{}");
            applyCompanyShape(result, data, "Proxycurl");
            const li = data?.linkedin_company_profile_url || data?.linkedin_url;
            if (li && !result.linkedinUrl) {
                result.linkedinUrl = normalizeLinkedIn(li);
                result.linkedinConfidence = 92;
            }
            if (result.linkedinUrl || result.numberOfEmployees) break;
        } catch {
            // fallback to next endpoint
        }
    }
    return result;
}

async function apolloEnrich({ domain }) {
    const result = emptyResult();
    const apiKey = envAny("APOLLO_KEY");
    if (!apiKey) return result;

    const payload = JSON.stringify({ domain });
    const raw = await apiPost("api.apollo.io", "/v1/organizations/enrich", payload, {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "x-api-key": apiKey,
    });
    const data = JSON.parse(raw || "{}");
    const org = data?.organization || {};
    applyCompanyShape(result, org, "Apollo");
    return result;
}

// ─── CLEARBIT API ──────────────────────────────────────────────────────────────
// Docs: https://dashboard.clearbit.com/docs#enrichment-api-company-api
async function clearbitEnrich({ domain }) {
    const result = emptyResult();
    const apiKey = env("CLEARBIT_API_KEY");
    if (!apiKey || !domain) return result;

    const raw = await httpsGet(
        `https://company.clearbit.com/v2/companies/find?domain=${encodeURIComponent(domain)}`,
        12000,
        { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
    );

    const data = JSON.parse(raw || "{}");
    const metrics = data.metrics || {};

    if (data.linkedin?.handle) {
        result.linkedinUrl = `https://www.linkedin.com/company/${data.linkedin.handle}`;
        result.linkedinConfidence = 90;
    }

    if (metrics.employees) {
        result.numberOfEmployees = formatHeadcount(metrics.employees);
        result.employeeSource = "Clearbit";
    }

    if (data.phone) {
        result.phone = cleanPhone(data.phone);
        result.phoneSource = "Clearbit";
    }

    // Clearbit normally doesn't provide generic company email, but use if present.
    if (data.email) {
        result.email = String(data.email).toLowerCase();
        result.emailConfidence = 78;
        result.emailSource = "Clearbit";
    }

    // Optional sector/category pass-through for downstream scoring/filtering.
    if (data.category?.sector) result.sector = data.category.sector;
    if (data.category?.industry) result.industry = data.category.industry;
    if (data.type) result.companyType = data.type;

    return result;
}

// ─── EXPLORIUM API ─────────────────────────────────────────────────────────────
// Docs:  https://developers.explorium.ai/
// Flow:  1) Match business  →  get business_id
//        2) Match prospect (CEO)  →  get prospect_id
//        3) Enrich contacts  →  get emails + phone numbers
// Auth:  header  api_key: <key>

async function exploriumEnrich({ companyName = "", domain = "", linkedinUrl = "" }) {
    const result = emptyResult();
    const apiKey = envAny("EXPLORIUM_API_KEY");
    if (!apiKey) return result;

    const BASE = "https://api.explorium.ai";
    const headers = {
        "Content-Type": "application/json",
        "api_key": apiKey,
    };

    // ── Step 1: Match Business → get business_id ─────────────────────────────
    let businessId = "";
    try {
        const bizPayload = JSON.stringify({
            request_context: null,
            businesses_to_match: [{
                name:         companyName || undefined,
                domain:       domain      || undefined,
                linkedin_url: linkedinUrl || undefined,
            }],
        });
        const bizRaw  = await httpsPostAbsolute(`${BASE}/v1/businesses/match`, bizPayload, headers, 15000);
        const bizData = JSON.parse(bizRaw || "{}");
        businessId    = bizData?.matched_businesses?.[0]?.business_id || "";
    } catch {
        // If business match fails, still attempt prospect match with name alone
    }

    if (!businessId && !companyName) return result;   // nothing to work with

    // ── Step 2: Match Prospect (target role = CEO) → get prospect_id ─────────
    let prospectId = "";
    try {
        const proPayload = JSON.stringify({
            request_context: null,
            prospects_to_match: [{
                business_id:  businessId  || undefined,
                company_name: companyName || undefined,
                full_name:    null,
                email:        null,
                phone_number: null,
                linkedin:     null,
            }],
        });
        const proRaw  = await httpsPostAbsolute(`${BASE}/v1/prospects/match`, proPayload, headers, 15000);
        const proData = JSON.parse(proRaw || "{}");
        prospectId    = proData?.matched_prospects?.[0]?.prospect_id || "";
    } catch { /* fallthrough */ }

    if (!prospectId) return result;

    // ── Step 3: Enrich Contact Details → emails + phone numbers ──────────────
    try {
        const enrichPayload = JSON.stringify({
            prospect_id: prospectId,
            parameters: { contact_types: ["email", "phone"] },
        });
        const enrichRaw  = await httpsPostAbsolute(`${BASE}/v1/prospects/contacts_information/enrich`, enrichPayload, headers, 20000);
        const enrichData = JSON.parse(enrichRaw || "{}");
        const data       = enrichData?.data || {};

        // ── Extract email ──
        // Prefer professions_email (current professional address)
        const profEmail = data?.professions_email || "";
        const emailStatus = data?.professional_email_status || "";
        // Fall back to first 'professional' type from the emails array
        const allEmailObjs = Array.isArray(data?.emails) ? data.emails : [];
        const proEmails    = allEmailObjs
            .filter(e => e?.type === "professional" && e?.email)
            .map(e => String(e.email).toLowerCase());
        const bestEmail = profEmail
            ? String(profEmail).toLowerCase()
            : proEmails[0] || "";

        if (bestEmail && isValidEmail(bestEmail)) {
            // Score: valid=92, catch-all=75, anything else=80
            const conf = emailStatus === "valid" ? 92
                       : emailStatus === "catch-all" ? 75 : 80;
            result.email           = bestEmail;
            result.emailConfidence = conf;
            result.emailSource     = "Explorium";
            result.allEmails       = [
                bestEmail,
                ...proEmails.filter(e => e !== bestEmail),
                ...allEmailObjs
                    .filter(e => e?.email && e?.type !== "professional")
                    .map(e => String(e.email).toLowerCase()),
            ].filter((e, i, a) => a.indexOf(e) === i && isValidEmail(e));
        }

        // ── Extract phone ──
        // mobile_phone is the highest-quality number
        const mobilePhone  = data?.mobile_phone || "";
        const allPhoneObjs = Array.isArray(data?.phone_numbers) ? data.phone_numbers : [];
        const rawPhone = mobilePhone
            || allPhoneObjs.find(p => p?.phone)?.phone
            || "";

        if (rawPhone) {
            const cleaned = cleanPhone(String(rawPhone));
            if (cleaned) {
                result.phone       = cleaned;
                result.phoneSource = "Explorium";
            }
        }
    } catch { /* fallthrough */ }

    return result;
}

// ─── HUNTER.IO API ────────────────────────────────────────────────────────────
// Docs: https://hunter.io/api-documentation/v2#domain-search
// Free tier: 25 domain searches/month  |  Paid from $49/mo
// Returns verified business emails tied to the domain + employee count

async function hunterEnrich({ domain }) {
    const result  = emptyResult();
    const apiKey  = envAny("HUNTER_KEY", "HUNTER_API_KEY");
    const url     = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&api_key=${apiKey}&limit=5`;

    const raw  = await httpsGet(url);
    const data = JSON.parse(raw);
    const meta = data?.data;

    if (!meta) return result;

    // Employee count from Hunter
    if (meta.organization?.employees || meta.employees_count) {
        result.numberOfEmployees = formatHeadcount(meta.organization?.employees || meta.employees_count);
        result.employeeSource    = "Hunter";
    }

    // Best email: pick highest-confidence result
    const emails = (meta.emails || [])
        .filter(e => e.value && e.confidence >= 50)
        .sort((a, b) => b.confidence - a.confidence);

    if (emails.length > 0) {
        const best             = emails[0];
        result.email           = best.value.toLowerCase();
        result.emailConfidence = Math.min(95, best.confidence);
        result.emailSource     = "Hunter";
        result.allEmails       = emails.map(e => e.value.toLowerCase());
    }

    // Hunter sometimes returns a phone via organization data
    if (meta.organization?.phone_number) {
        result.phone       = cleanPhone(meta.organization.phone_number);
        result.phoneSource = "Hunter";
    }

    return result;
}

// ─── WEBSITE SCRAPING ────────────────────────────────────────────────────────
// Scrapes company website contact/about pages for phone numbers and emails.
// Authentic: only extracts real data that exists on the public website.

// Stricter phone regex: requires an explicit phone-context prefix OR +CC format to avoid matching
// bare numbers, dates, IDs, zip codes, etc.
// Accepts:
//   tel:+1-800-555-1234  |  phone: (800) 555-1234  |  +44 20 7946 0958
// Rejects:
//   123456789 (no context)  |  02-05-2025 (date)  |  3.67E+13 (scientific)
const PHONE_REGEX = /(?:(?:tel|phone|ph|call|fax|mob(?:ile)?|☎|📞)[:\s.]*)(\+?[\d][\d\s\-().]{6,18}[\d])|(?:^|[\s"'(,])(?:\+[1-9][\d\s\-().]{7,18}[\d])/gim;
const EMAIL_REGEX = /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g;

const CONTACT_PATHS = [
    "/contact",
    "/contact-us",
    "/about",
    "/about-us",
];


async function websiteContactScrape(domain, opts = {}) {
    const result = emptyResult();
    
    // Quick DNS lookup check to bypass unreachable guessed domains
    if (!await isDomainAlive(domain)) {
        return result;
    }

    const timeoutMs = parseInt(envAny("SCRAPE_TIMEOUT_MS"), 10) || 3000;

    // Quick base reachability check: if both homepage attempts fail/timeout, skip sub-paths!
    let baseReachable = false;
    for (const base of [`https://${domain}`, `https://www.${domain}`]) {
        try {
            const testHtml = await fetchHtmlSmart(base, timeoutMs, opts.browser);
            if (testHtml && testHtml.length > 50) {
                baseReachable = true;
                break;
            }
        } catch {
            // try next base
        }
    }

    if (!baseReachable) {
        return result;
    }

    const phones = new Set();
    const emails = new Set();

    for (const path of CONTACT_PATHS) {
        for (const base of [`https://${domain}`, `https://www.${domain}`]) {
            try {
                await jitter(400, 1000);
                const html = await fetchHtmlSmart(`${base}${path}`, timeoutMs, opts.browser);
                if (!html || html.length < 50) continue;

                // ── Phone extraction ────────────────────────────────────────
                // Priority 1: tel: href links (most reliable)
                const telLinks = [...html.matchAll(/href="tel:([^"]+)"/gi)];
                for (const m of telLinks) {
                    const p = cleanPhone(m[1]);
                    if (p && p.length >= 7) phones.add(p);
                }

                // Priority 2: Phone regex on visible text
                const rawText  = html.replace(/<[^>]+>/g, " ");
                const phoneMatches = [...rawText.matchAll(PHONE_REGEX)];
                for (const m of phoneMatches) {
                    // m[1] = captured phone after keyword prefix (group 1), m[0] = full match
                    const raw = (m[1] || m[0]).trim();
                    const p   = cleanPhone(raw);
                    if (p) phones.add(p);
                }

                // ── Email extraction ─────────────────────────────────────────
                const mailtoLinks = [...html.matchAll(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi)];
                for (const m of mailtoLinks) {
                    const e = m[1].toLowerCase();
                    if (isValidEmail(e)) emails.add(e);
                }

                const inlineEmails = [...html.matchAll(EMAIL_REGEX)];
                for (const m of inlineEmails) {
                    const e = m[1].toLowerCase();
                    if (isValidEmail(e)) emails.add(e);
                }

                // Stop early if we have both
                if (phones.size > 0 && emails.size > 0) break;
            } catch { /* 404 / timeout */ }
        }
        if (phones.size > 0 && emails.size > 0) break;
    }

    // Rank and assign phone — only if cleanPhone passes full validation
    if (phones.size > 0) {
        const rankedPhones = rankPhones([...phones], domain);
        const bestPhone = rankedPhones[0] || "";
        if (bestPhone) {
            result.phone       = bestPhone;
            result.phoneSource = "WebScrape";
        }
    }

    // Rank and assign email — apply strict filter before ranking
    const validEmails = [...emails].filter(isValidEmail);
    if (validEmails.length > 0) {
        const ranked           = rankEmailsByDomain(validEmails, domain);
        const bestEmail        = ranked[0] || "";
        // Final guard: must contain @ and a dot after @
        if (bestEmail && bestEmail.includes("@") && bestEmail.split("@")[1]?.includes(".")) {
            result.email           = bestEmail;
            result.allEmails       = ranked;
            result.emailConfidence = bestEmail.includes(`@${domain}`) ? 80 : 55;
            result.emailSource     = "WebScrape";
        }
    }

    return result;
}

async function linkedinPhoneFallback(linkedinUrl, browser) {
    const targets = [`${linkedinUrl}/about`, linkedinUrl];
    for (const target of targets) {
        try {
            const html = await fetchHtmlSmart(target, 4000, browser);
            const text = html.replace(/<[^>]+>/g, " ");
            const match = text.match(/(?:\+?\d[\d\s().-]{7,}\d)/g);
            if (match?.length) {
                const cleaned = match.map(cleanPhone).find(Boolean);
                if (cleaned) return cleaned;
            }
        } catch { /* continue */ }
    }
    return "";
}

async function fetchHtmlSmart(url, timeoutMs = 20000, browser = null) {
    // 1) ScrapingBee (JS render + anti-bot infra)
    const scrapingBeeKey = envAny("SCRAPINGBEE_API_KEY");
    if (scrapingBeeKey) {
        try {
            const api = `https://app.scrapingbee.com/api/v1/?api_key=${encodeURIComponent(scrapingBeeKey)}&url=${encodeURIComponent(url)}&render_js=true&premium_proxy=true`;
            const html = await httpsGet(api, timeoutMs, { Accept: "text/html" });
            if (html?.length > 100) return html;
        } catch { /* fallback */ }
    }

    // 2) Browserless content API
    const browserlessToken = envAny("BROWSERLESS_TOKEN");
    const browserlessUrl = envAny("BROWSERLESS_URL") || "https://chrome.browserless.io/content";
    if (browserlessToken) {
        try {
            const payload = JSON.stringify({ url, gotoOptions: { waitUntil: "domcontentloaded", timeout: timeoutMs } });
            const html = await httpsPostAbsolute(`${browserlessUrl}?token=${encodeURIComponent(browserlessToken)}`, payload, {
                "Content-Type": "application/json",
                Accept: "text/html",
            }, timeoutMs);
            if (html?.length > 100) return html;
        } catch { /* fallback */ }
    }

    // 3) Local Playwright browser for JS-heavy pages (+ optional rotating proxies)
    if (browser) {
        const proxy = pickProxyServer();
        try {
            let html = "";
            if (proxy) {
                const context = await Promise.race([
                    browser.newContext({ proxy: { server: proxy } }),
                    new Promise<any>((_, reject) => setTimeout(() => reject(new Error("fetchHtmlSmart newContext timeout")), 15000))
                ]);
                const page = await Promise.race([
                    context.newPage(),
                    new Promise<any>((_, reject) => setTimeout(() => reject(new Error("fetchHtmlSmart newPage timeout")), 15000))
                ]);
                await Promise.race([
                    page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs }),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error("fetchHtmlSmart page.goto timeout")), timeoutMs)
                    )
                ]);
                await page.waitForTimeout(2000);
                html = await page.content();
                await context.close();
            } else {
                const page = await Promise.race([
                    browser.newPage(),
                    new Promise<any>((_, reject) => setTimeout(() => reject(new Error("fetchHtmlSmart newPage timeout")), 15000))
                ]);
                await Promise.race([
                    page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs }),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error("fetchHtmlSmart page.goto timeout")), timeoutMs)
                    )
                ]);
                await page.waitForTimeout(2000);
                html = await page.content();
                await page.close();
            }
            if (html?.length > 100) return html;
        } catch { /* fallback */ }
    }

    // 4) Raw request fallback
    return await ddgGet(url, timeoutMs);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function emptyResult() {
    return {
        phone:              "",
        phoneSource:        "",
        email:              "",
        emailConfidence:    0,
        emailSource:        "",
        allEmails:          [],
        numberOfEmployees:  "",
        employeeSource:     "",
        linkedinUrl:        "",
        linkedinConfidence: 0,
        sector:             "",
        industry:           "",
        companyType:        "",
    };
}

function resultNeedsMore(r) {
    return !r.phone || !r.email || !r.numberOfEmployees || !r.linkedinUrl;
}

function mergeResult(target, source, sourceName) {
    if (source.linkedinUrl && !target.linkedinUrl) {
        target.linkedinUrl        = source.linkedinUrl;
        target.linkedinConfidence = source.linkedinConfidence || 80;
    }
    if (source.numberOfEmployees && !target.numberOfEmployees) {
        target.numberOfEmployees = source.numberOfEmployees;
        target.employeeSource    = source.employeeSource || sourceName;
    }
    if (source.sector && !target.sector) {
        target.sector = source.sector;
    }
    if (source.industry && !target.industry) {
        target.industry = source.industry;
    }
    if (source.companyType && !target.companyType) {
        target.companyType = source.companyType;
    }
    if (source.phone && !target.phone) {
        target.phone       = source.phone;
        target.phoneSource = source.phoneSource || sourceName;
    }
    if (source.email && source.emailConfidence > target.emailConfidence) {
        target.email           = source.email;
        target.emailConfidence = source.emailConfidence;
        target.emailSource     = source.emailSource || sourceName;
        target.allEmails       = source.allEmails?.length ? source.allEmails : target.allEmails;
    }
}

function applyCompanyShape(target, company, sourceName) {
    if (!company || typeof company !== "object") return;
    const linkedin = company.linkedin_url || company.linkedin || company.linkedin_company_url;
    if (linkedin && !target.linkedinUrl) {
        target.linkedinUrl = normalizeLinkedIn(linkedin);
        target.linkedinConfidence = sourceName === "Explorium" ? 90 : 86;
    }

    const headcount = company.employee_count || company.headcount || company.estimated_num_employees || company.employees;
    if (headcount && !target.numberOfEmployees) {
        target.numberOfEmployees = formatHeadcount(headcount);
        target.employeeSource = sourceName;
    }

    const phone = company.phone || company.company_phone || company.phone_number;
    if (phone && !target.phone) {
        target.phone = cleanPhone(phone);
        target.phoneSource = sourceName;
    }

    const email = company.email || company.contact_email || company.primary_email;
    if (email && !target.email) {
        target.email = String(email).toLowerCase();
        target.emailConfidence = sourceName === "Explorium" ? 84 : 80;
        target.emailSource = sourceName;
    }

    if (company.sector && !target.sector) target.sector = company.sector;
    if (company.industry && !target.industry) target.industry = company.industry;
    if (company.type && !target.companyType) target.companyType = company.type;
}

function normalizeLinkedIn(url = "") {
    try {
        const u = new URL(url.startsWith("http") ? url : `https://linkedin.com${url}`);
        const parts = u.pathname.replace(/\/$/, "").split("/").filter(Boolean);
        if (parts[0] === "company" && parts[1]) {
            return `https://www.linkedin.com/company/${parts[1]}`;
        }
        return url;
    } catch { return url; }
}

function formatHeadcount(count) {
    if (!count) return "";
    const n = typeof count === "string"
        ? parseInt(count.replace(/[^0-9]/g, ""), 10)
        : Math.round(Number(count));
    if (isNaN(n)) return String(count);
    if (n >= 10000)  return "10,000+";
    if (n >= 5000)   return "5,000–10,000";
    if (n >= 1000)   return "1,000–5,000";
    if (n >= 500)    return "500–1,000";
    if (n >= 200)    return "200–500";
    if (n >= 50)     return "50–200";
    if (n >= 10)     return "10–50";
    return "1–10";
}

/**
 * Clean and validate a raw phone string.
 * Returns the cleaned phone, or "" if it fails any validation rule.
 */
function cleanPhone(raw = "") {
    if (!raw) return "";
    const str = String(raw).trim();

    // Reject scientific notation immediately (e.g. 3.67E+13)
    if (/[Ee][+\-]\d/.test(str)) return "";

    // Reject date-like patterns (02-05-2025, 02/05/2025)
    if (/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(str)) return "";

    // Keep only phone-safe characters
    const cleaned = str.replace(/[^\d\s\-().+]/g, "").trim();
    const digits  = cleaned.replace(/\D/g, "");

    // Digit count must be 7–15 (E.164 allows up to 15)
    if (digits.length < 7 || digits.length > 15) return "";

    // Reject INT32 max sentinel
    if (digits === "2147483647") return "";

    // Reject all-same-digit strings (1111111, 0000000, 9999999)
    if (/^(\d)\1{6,}$/.test(digits)) return "";

    // Reject known fake/placeholder patterns
    const FAKE_PATTERNS = [
        /555[\s\-.]?000/,   // 555-000-xxxx (US test numbers)
        /\(555\)/,          // (555) area code
        /^1234567890$/,     // sequential digits
        /^0{7,}$/,          // all zeros
        /^9{7,}$/,          // all nines
        /^2147483647$/,     // INT_MAX
    ];
    if (FAKE_PATTERNS.some(p => p.test(digits) || p.test(cleaned))) return "";

    // Reject values that are exactly INT_MAX or 0
    const asNum = parseInt(digits, 10);
    if (asNum === 2147483647 || asNum === 0) return "";

    return cleaned;
}


function rankPhones(phones, domain) {
    // Prefer international format (+XX...)
    return [...phones].sort((a, b) => {
        const aInt = a.startsWith("+") ? 1 : 0;
        const bInt = b.startsWith("+") ? 1 : 0;
        return bInt - aInt;
    });
}

function rankEmailsByDomain(emails, domain) {
    // Priority 1: exact domain match  Priority 2: recognisable business prefix
    const BEST_PREFIXES   = ["info", "hello", "contact", "support", "sales", "press", "partnerships", "team"];
    const GOOD_PREFIXES   = ["hr", "careers", "jobs", "office", "admin", "general", "enquiries"];
    const REJECT_PREFIXES = /^(noreply|no-reply|donotreply|bounce|mailer|daemon|postmaster|automailer)$/i;

    return [...emails].sort((a, b) => {
        const [pa, da] = a.split("@");
        const [pb, db] = b.split("@");

        // Noreply/bounce always goes to bottom
        const aReject = REJECT_PREFIXES.test(pa) ? -200 : 0;
        const bReject = REJECT_PREFIXES.test(pb) ? -200 : 0;

        const sameDomainA = (da === domain || da === `www.${domain}`) ? 100 : 0;
        const sameDomainB = (db === domain || db === `www.${domain}`) ? 100 : 0;

        const bestA = BEST_PREFIXES.indexOf(pa.toLowerCase());
        const bestB = BEST_PREFIXES.indexOf(pb.toLowerCase());
        const goodA = GOOD_PREFIXES.indexOf(pa.toLowerCase());
        const goodB = GOOD_PREFIXES.indexOf(pb.toLowerCase());

        const prefixScoreA = bestA >= 0 ? (BEST_PREFIXES.length - bestA) * 10
                           : goodA >= 0 ? (GOOD_PREFIXES.length - goodA) * 4 : 0;
        const prefixScoreB = bestB >= 0 ? (BEST_PREFIXES.length - bestB) * 10
                           : goodB >= 0 ? (GOOD_PREFIXES.length - goodB) * 4 : 0;

        const scoreA = aReject + sameDomainA + prefixScoreA;
        const scoreB = bReject + sameDomainB + prefixScoreB;
        return scoreB - scoreA;
    });
}

// ─── HTTP helpers (native — no dependencies) ──────────────────────────────────

function httpsGet(url, timeoutMs = 12000, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (compatible; LeadEnricher/3.0)",
                "Accept": "application/json",
                ...extraHeaders,
            },
            timeout: timeoutMs,
        }, (res) => {
            if (res.statusCode && res.statusCode >= 400) {
                let errorData = "";
                res.setEncoding("utf8");
                res.on("data", c => { if (errorData.length < 1000) errorData += c; });
                res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${errorData.slice(0, 180)}`)));
                return;
            }
            if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
                httpsGet(res.headers.location, timeoutMs, extraHeaders).then(resolve).catch(reject);
                return;
            }
            let data = "";
            res.setEncoding("utf8");
            res.on("data", c => { if (data.length < 500000) data += c; });
            res.on("end", () => resolve(data));
        });
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    });
}

function apiPost(host, path, body, headers = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: host,
            path,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
                ...headers,
            },
            timeout: timeoutMs,
        };
        const req = https.request(options, (res) => {
            let data = "";
            res.setEncoding("utf8");
            res.on("data", c => { if (data.length < 500000) data += c; });
            res.on("end", () => {
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
                else reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            });
        });
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.write(body);
        req.end();
    });
}

function httpsPostAbsolute(rawUrl, body, headers = {}, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(rawUrl);
        const options = {
            hostname: parsed.hostname,
            path: `${parsed.pathname}${parsed.search}`,
            method: "POST",
            headers: {
                "Content-Length": Buffer.byteLength(body),
                ...headers,
            },
            timeout: timeoutMs,
        };
        const req = https.request(options, (res) => {
            let data = "";
            res.setEncoding("utf8");
            res.on("data", c => { if (data.length < 1000000) data += c; });
            res.on("end", () => {
                if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
                else reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 220)}`));
            });
        });
        req.on("error", reject);
        req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
        req.write(body);
        req.end();
    });
}

function pickProxyServer() {
    const single = envAny("PROXY_URL");
    const rotationRaw = envAny("ROTATING_PROXIES", "PROXY_ROTATION_URLS");
    const pool = [
        ...String(rotationRaw || "")
            .split(",")
            .map(p => p.trim())
            .filter(Boolean),
    ];
    if (single) pool.push(single);
    if (!pool.length) return "";
    const idx = Math.floor(Math.random() * pool.length);
    return pool[idx];
}


