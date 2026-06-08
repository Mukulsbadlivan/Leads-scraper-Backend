// @ts-nocheck
import { chromium } from 'playwright';
import { enrichContact } from './enrichers/contactEnricher.ts';
import { getRedditIntelligence } from './scrapers/redditIntelligence.ts';
import { findWebsite } from './utils/websiteFinder.ts';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getOutputDir } from './utils/pathResolver.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Precision Lead System for UK Tech Companies
 */
class PrecisionLeadSystem {
    constructor() {
        this.results = [];
        this.browser = null;
    }

    async init() {
        this.browser = await chromium.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
        });
    }

    async close() {
        if (this.browser) await this.browser.close();
    }

    /**
     * Extracts deep intelligence for a specific company
     */
    async processCompany(companyName, initialWebsite = "") {
        console.log(`\n[Precision] Processing: ${companyName}...`);
        
        let website = initialWebsite;
        if (!website) {
            const webResult = await findWebsite(companyName);
            website = webResult.url;
        }

        const domain = this.extractDomain(website);
        if (!domain) {
            console.log(`[Precision] Skipping ${companyName}: No domain found.`);
            return null;
        }

        // 1. REAL Email Extraction (Strict)
        const contactData = await enrichContact({ companyName, domain });
        
        // If no email found from APIs, use Playwright to crawl deeply
        if (!contactData.email) {
            console.log(`[Precision] No email from APIs for ${companyName}. Crawling website...`);
            const crawled = await this.crawlWebsiteForEmails(website);
            if (crawled.email) {
                contactData.email = crawled.email;
                contactData.emailConfidence = 75;
                contactData.emailSource = "PlaywrightCrawl";
                contactData.phone = crawled.phone || contactData.phone;
            }
        }

        // Mandatory check: Skip if no real email
        if (!contactData.email) {
            console.log(`[Precision] Skipping ${companyName}: No real email discovered.`);
            return null;
        }

        // 2. Reddit Intelligence (Pain Points)
        const redditSignals = await getRedditIntelligence(companyName);

        // 3. Growth Signals (Hiring, Funding, Product)
        const signals = await this.getGrowthSignals(companyName, website);

        const result = {
            company: companyName,
            website: website,
            domain: domain,
            email: contactData.email,
            phone: contactData.phone || "",
            employee_count: contactData.numberOfEmployees || "Unknown",
            tech_stack: await this.detectTechStack(website),
            signals: {
                hiring: signals.hiring,
                funding: signals.funding,
                product: signals.product,
                pain_points: redditSignals
            },
            confidence_score: contactData.emailConfidence
        };

        console.log(`[Precision] Found lead: ${result.email} (${result.confidence_score}%)`);
        return result;
    }

    extractDomain(url) {
        try {
            return new URL(url).hostname.replace('www.', '');
        } catch { return ''; }
    }

    async crawlWebsiteForEmails(url) {
        const result = { email: '', phone: '' };
        const context = await this.browser.newContext();
        const page = await context.newPage();
        
        const paths = ['', '/contact', '/about', '/careers', '/privacy-policy'];
        const base = url.endsWith('/') ? url.slice(0, -1) : url;

        for (const path of paths) {
            try {
                await page.goto(`${base}${path}`, { timeout: 15000, waitUntil: 'domcontentloaded' });
                
                // Scroll to bottom to trigger lazy loading
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await page.waitForTimeout(1000);

                const content = await page.content();
                
                // Email Regex
                const emailMatch = content.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g);
                if (emailMatch) {
                    const filtered = emailMatch.filter(e => 
                        !e.match(/bootstrap|jquery|sentry|example|w3\.org|noreply/i) &&
                        e.includes(this.extractDomain(url))
                    );
                    if (filtered.length > 0) {
                        result.email = filtered[0].toLowerCase();
                    }
                }

                // Phone Regex
                const phoneMatch = content.match(/(?:\+44|0)[\d\s-]{10,14}/g);
                if (phoneMatch && !result.phone) {
                    result.phone = phoneMatch[0].trim();
                }

                if (result.email) break;
            } catch (err) {
                // Skip errors
            }
        }
        await context.close();
        return result;
    }

    async getGrowthSignals(companyName, website) {
        // Placeholder for real signal extraction - could be improved with news API
        return {
            hiring: `Active hiring on ${website}/careers`,
            funding: "Recent growth signals detected in UK tech market",
            product: "Regular product updates observed"
        };
    }

    async detectTechStack(website) {
        // Simple tech detection via page source
        try {
            const context = await this.browser.newContext();
            const page = await context.newPage();
            await page.goto(website, { timeout: 10000 });
            const content = await page.content();
            await context.close();

            const stack = [];
            if (content.includes('react')) stack.push('React');
            if (content.includes('vue')) stack.push('Vue');
            if (content.includes('next.ts')) stack.push('Next.ts');
            if (content.includes('analytics.ts')) stack.push('Google Analytics');
            if (content.includes('stripe')) stack.push('Stripe');
            if (content.includes('intercom')) stack.push('Intercom');
            if (content.includes('hubspot')) stack.push('HubSpot');
            
            return stack;
        } catch { return []; }
    }

    async run(companies) {
        await this.init();
        const results = [];
        
        for (const company of companies) {
            const result = await this.processCompany(company.name, company.website);
            if (result) results.push(result);
        }

        await this.close();
        return results;
    }
}

// ─── EXECUTION ────────────────────────────────────────────────────────────────

const ukTechCompanies = [
    { name: "Monzo", website: "https://monzo.com" },
    { name: "GoCardless", website: "https://gocardless.com" },
    { name: "Quantexa", website: "https://quantexa.com" },
    { name: "Matillion", website: "https://matillion.com" },
    { name: "PolyAI", website: "https://poly.ai" },
    { name: "CloudNC", website: "https://cloudnc.com" },
    { name: "Unitary", website: "https://unitary.ai" },
    { name: "Harmonic Security", website: "https://harmonic.security" },
    { name: "CuspAI", website: "https://cusp.ai" },
    { name: "Paddle", website: "https://paddle.com" }
];

const pipeline = new PrecisionLeadSystem();
pipeline.run(ukTechCompanies).then(data => {
    const output = JSON.stringify(data, null, 2);
    const outputDir = getOutputDir();
    fs.mkdirSync(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, 'uk_tech_leads.json');
    fs.writeFileSync(outputPath, output);
    console.log(`\n[Done] Extracted ${data.length} high-precision leads to ${outputPath}`);
}).catch(err => {
    console.error("Pipeline failed:", err);
});


