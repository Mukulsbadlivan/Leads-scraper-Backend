// @ts-nocheck
import dns from "dns";

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
export function isValidEmail(email = "") {
    if (!email || !email.includes("@")) return false;

    // Reject URL-encoded strings immediately (e.g. csat%20champion@1x.png)
    if (email.includes("%")) return false;

    const [local, domain] = email.split("@");
    if (!local || !domain || !domain.includes(".")) return false;

    // Reject if local part is too short or too long
    if (local.length < 1 || local.length > 64) return false;

    // Reject local parts that look like file paths or contain path-like chars
    if (/[\/\\:*?"<>|]/.test(local)) return false;

    // Reject if local part contains numbers only or looks like a filename (e.g. logo_large@2x)
    if (/[@\s]/.test(local)) return false;

    // Reject local parts that look like image/asset names: contain @Nx suffix, underscores with
    // digits, or common image prefixes
    if (/(?:^|[_\-])(?:logo|icon|image|img|banner|avatar|photo|thumbnail|sprite|bg|background|hero|cover|placeholder)(?:[_\-@]|$)/i.test(local)) return false;
    if (/@\d+x$/.test(local) || /\d+x$/.test(local)) return false; // e.g. logo@2x or champion@1x

    const domainParts = domain.split(".");
    const tld = domainParts[domainParts.length - 1];

    // TLD must be letters only (2–6 chars), no digits — rejects .png, .jpg, .1x, etc.
    if (!/^[a-zA-Z]{2,6}$/.test(tld)) return false;

    // Reject known file extensions masquerading as TLDs
    if (FILE_EXTENSIONS.has(tld.toLowerCase())) return false;

    // Reject if domain has 3+ sub-levels (e.g. o1234.ingest.eu.sentry.io)
    if (domainParts.length > 3) return false;

    // Reject domain parts that contain only digits (e.g. @1x.png → domain = 1x.png)
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
 * Perform a DNS lookup to check if the hostname has an active DNS record.
 */
export async function isDomainAlive(domain = "") {
    if (!domain) return false;
    let hostname = domain;
    try {
        const u = new URL(domain.startsWith("http") ? domain : `https://${domain}`);
        hostname = u.hostname;
    } catch { /* ignore */ }
    
    return new Promise(resolve => {
        dns.lookup(hostname, (err) => {
            if (err && err.code === "ENOTFOUND") {
                resolve(false);
            } else {
                resolve(true);
            }
        });
    });
}
