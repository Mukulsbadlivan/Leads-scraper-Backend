// @ts-nocheck
// ─── LinkedIn Activity Tracker ────────────────────────────────────────────────
// Tier 1: Playwright recent-activity/all/ page
// Tier 2: DDG snippet fallback when authwall detected

import { ddgGet, jitter, geekflareGoogleSearch } from "../scrapers/linkedinScraper.ts";

// ─── Types ────────────────────────────────────────────────────────────────────
export interface LinkedInActivityResult {
    ctoLinkedInActive: boolean;
    lastPostDate: string;
    postCount30Days: number;
    painSignals: string[];
    postSnippets: string[];
    activitySource: string;
}

// ─── Pain keyword dictionary ──────────────────────────────────────────────────
const PAIN_KEYWORDS = {
    scaling_infra:    ["scaling", "infrastructure", "latency", "downtime", "outage", "performance"],
    hiring_struggle:  ["hiring", "talent", "recruitment", "hard to find", "talent gap", "team growing"],
    data_problems:    ["data pipeline", "data quality", "analytics", "reporting", "dashboard"],
    security_concern: ["security", "breach", "compliance", "gdpr", "audit", "vulnerability"],
    tool_evaluation:  ["looking for", "recommendations", "anyone used", "alternatives to", "switching from", " vs "],
    funding_news:     ["excited to announce", "raised", "series", "funding", "investment"],
    product_launch:   ["launched", "shipping", "release", "new product", "go live"],
    ai_interest:      ["ai", "llm", "gpt", "machine learning", "automation", "copilot"],
};

function emptyResult() {
    return { ctoLinkedInActive: false, lastPostDate: "", postCount30Days: 0, painSignals: [], postSnippets: [], activitySource: "" };
}

function isAuthwall(url) {
    return /login|authwall|signup|checkpoint/i.test(url);
}

// ─── Pain signal extractor ────────────────────────────────────────────────────
export function extractPainSignals(texts) {
    const combined = texts.join(" ").toLowerCase();
    const signals = [];
    for (const [cat, keywords] of Object.entries(PAIN_KEYWORDS)) {
        if (keywords.some(kw => combined.includes(kw.toLowerCase()))) signals.push(cat);
    }
    return [...new Set(signals)];
}

// ─── Step 1: Find profile URL via DDG ────────────────────────────────────────
export async function findPersonLinkedInUrl(personName, companyName) {
    if (!personName || !companyName) return "";

    // Try Geekflare Google Search first!
    try {
        const q = `"${personName}" "${companyName}" site:linkedin.com/in`;
        const results = await geekflareGoogleSearch(q);
        for (const res of results) {
            const m = res.url.match(/linkedin\.com\/in\/([a-z0-9][a-z0-9\-]{1,60})/i);
            if (m) {
                const slug = m[1].replace(/['">\s]/g, "");
                if (slug && slug.length > 2) return `https://www.linkedin.com/in/${slug}`;
            }
        }
    } catch { /* ignore */ }

    // If Geekflare is enabled, skip the slow/blocked DDG fallbacks
    if (process.env.GEEKFLARE_API_KEY) {
        return "";
    }

    try {
        await jitter(800, 2000);
        const q = encodeURIComponent(`"${personName}" "${companyName}" site:linkedin.com/in`);
        const html = await ddgGet(`https://lite.duckduckgo.com/lite/?q=${q}`, 12000);
        if (!html || html.length < 200) return "";
        const matches = [...html.matchAll(/linkedin\.com\/in\/([a-z0-9][a-z0-9\-]{1,60})/gi)];
        for (const m of matches) {
            const slug = m[1].replace(/['">\s]/g, "");
            if (slug && slug.length > 2) return `https://www.linkedin.com/in/${slug}`;
        }
    } catch (err) {
        console.warn("[linkedinActivityTracker] findPersonLinkedInUrl:", err.message);
    }
    return "";
}

// ─── Step 2: Playwright scrape ────────────────────────────────────────────────
async function scrapeRecentActivityPlaywright(profileUrl, browser) {
    const empty = { posts: [], dates: [] };
    if (!browser || !profileUrl) return empty;
    let page = null;
    try {
        page = await browser.newPage();
        await page.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf}", r => r.abort());
        const activityUrl = `${profileUrl.replace(/\/$/, "")}/recent-activity/all/`;
        await page.goto(activityUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        await page.waitForTimeout(2500 + Math.random() * 1000);
        if (isAuthwall(page.url())) return empty;
        const data = await page.evaluate(() => {
            const posts = [];
            const dates = [];
            document.querySelectorAll(".feed-shared-update-v2__description span.break-words, span.break-words, div[data-urn] span[dir='ltr']").forEach(el => {
                const t = el.innerText?.trim();
                if (t && t.length > 20) posts.push(t.slice(0, 500));
            });
            document.querySelectorAll("span.visually-hidden, time").forEach(el => {
                const t = el.innerText?.trim() || el.getAttribute("datetime") || "";
                if (t && (t.includes("ago") || /\d{4}-\d{2}-\d{2}/.test(t))) dates.push(t);
            });
            return { posts, dates };
        });
        return { posts: data.posts || [], dates: data.dates || [] };
    } catch (err) {
        console.warn("[linkedinActivityTracker] playwright scrape:", err.message);
        return empty;
    } finally {
        if (page) try { await page.close(); } catch {}
    }
}

// ─── Step 3: DDG snippet fallback ────────────────────────────────────────────
async function ddgSnippetFallback(slug) {
    if (!slug) return [];

    // Try Geekflare Google Search first!
    try {
        const q = `site:linkedin.com/in/${slug} posts`;
        const results = await geekflareGoogleSearch(q);
        const snippets = [];
        for (const res of results) {
            const t = `${res.title} ${res.snippet}`.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            if (t.length > 30) snippets.push(t.slice(0, 300));
        }
        if (snippets.length > 0) return snippets;
    } catch { /* ignore */ }

    // If Geekflare is enabled, skip the slow/blocked DDG fallbacks
    if (process.env.GEEKFLARE_API_KEY) {
        return [];
    }

    try {
        await jitter(800, 2000);
        const q = encodeURIComponent(`site:linkedin.com/in/${slug} posts`);
        const html = await ddgGet(`https://lite.duckduckgo.com/lite/?q=${q}`, 12000);
        if (!html || html.length < 200) return [];
        const snippets = [];
        [...html.matchAll(/<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi)].forEach(m => {
            const t = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            if (t.length > 30) snippets.push(t.slice(0, 300));
        });
        [...html.matchAll(/<a [^>]*class="result-link"[^>]*>([\s\S]*?)<\/a>/gi)].forEach(m => {
            const t = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            if (t.length > 20) snippets.push(t.slice(0, 200));
        });
        return snippets;
    } catch (err) {
        console.warn("[linkedinActivityTracker] ddgSnippetFallback:", err.message);
        return [];
    }
}

// ─── Date parsing helpers ─────────────────────────────────────────────────────
function parsePostDate(raw) {
    if (!raw) return "";
    const iso = raw.match(/(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
    const now = new Date();
    const min = raw.match(/(\d+)\s*minute/i); if (min) { now.setMinutes(now.getMinutes() - +min[1]); return now.toISOString().slice(0, 10); }
    const hr  = raw.match(/(\d+)\s*hour/i);   if (hr)  { now.setHours(now.getHours() - +hr[1]);     return now.toISOString().slice(0, 10); }
    const day = raw.match(/(\d+)\s*day/i);    if (day) { now.setDate(now.getDate() - +day[1]);       return now.toISOString().slice(0, 10); }
    const wk  = raw.match(/(\d+)\s*week/i);   if (wk)  { now.setDate(now.getDate() - +wk[1] * 7);   return now.toISOString().slice(0, 10); }
    const mo  = raw.match(/(\d+)\s*month/i);  if (mo)  { now.setMonth(now.getMonth() - +mo[1]);      return now.toISOString().slice(0, 10); }
    return "";
}

function isWithin30Days(isoDate) {
    if (!isoDate) return false;
    try {
        const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
        return new Date(isoDate) >= cutoff;
    } catch { return false; }
}

// ─── Main export ──────────────────────────────────────────────────────────────
export async function trackLinkedInActivity(lead, browser) {
    const result = emptyResult();
    const personName  = (lead.ctoName || lead.ceoName || "").trim();
    const companyName = (lead.companyName || "").trim();
    if (!personName || !companyName) return result;

    // Step 1: profile URL
    let profileUrl = "";
    try { profileUrl = await findPersonLinkedInUrl(personName, companyName); }
    catch (err) { console.warn("[linkedinActivityTracker]", err.message); return result; }
    if (!profileUrl) return result;

    const slugMatch   = profileUrl.match(/linkedin\.com\/in\/([^/?#]+)/i);
    const profileSlug = slugMatch ? slugMatch[1] : "";

    // Step 2: Playwright
    let posts = [];
    let dates = [];
    let usedPlaywright = false;

    if (browser) {
        try {
            await jitter(1000, 3000);
            const scraped = await scrapeRecentActivityPlaywright(profileUrl, browser);
            if (scraped.posts.length > 0) { posts = scraped.posts; dates = scraped.dates; usedPlaywright = true; }
        } catch (err) { console.warn("[linkedinActivityTracker] playwright:", err.message); }
    }

    // Step 3: DDG fallback
    if (!usedPlaywright || posts.length === 0) {
        try {
            await jitter(800, 2000);
            const snippets = await ddgSnippetFallback(profileSlug);
            if (snippets.length > 0) { posts = snippets; result.activitySource = "DDGSnippet"; }
        } catch (err) { console.warn("[linkedinActivityTracker] ddg fallback:", err.message); }
    } else {
        result.activitySource = "LinkedIn";
    }

    if (posts.length === 0) return result;

    // Step 4: Pain signals
    result.painSignals  = extractPainSignals(posts);
    result.postSnippets = posts.map(p => p.slice(0, 100));

    // Step 5: Activity determination
    const parsedDates = dates.map(parsePostDate).filter(Boolean);
    const count30 = usedPlaywright ? parsedDates.filter(isWithin30Days).length : posts.length;

    result.postCount30Days   = count30;
    result.ctoLinkedInActive = count30 >= 1;
    result.lastPostDate      = parsedDates.length > 0
        ? parsedDates.sort().reverse()[0]
        : (count30 > 0 ? new Date().toISOString().slice(0, 10) : "");

    return result;
}
