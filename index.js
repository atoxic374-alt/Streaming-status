// Copyright (c) Ahmed
require('dotenv').config({ quiet: true });

const { Client, RichPresence, CustomStatus, SpotifyRPC, Options } = require("discord.js-selfbot-v13");
const moment = require("moment-timezone");
const { schedule } = require("node-cron");
const os = require("os");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
require("colors");

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Human-simulation session — generated once per process restart.
// A stable fingerprint is chosen from a pool of real Discord desktop
// builds, then cookies + X-Super-Properties are derived from it.
// All simulated Discord API requests share this session so they look
// like a single consistent browser session, not random per-call noise.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const _SIM_SESSION = (() => {
    const POOL = [
        { chrome: '124.0.6367.208', electron: '30.0.6',  cv: '0.0.316', build: 338988, native: 49607, os: '10.0.22631' },
        { chrome: '122.0.6261.129', electron: '29.4.6',  cv: '0.0.313', build: 334300, native: 48702, os: '10.0.19045' },
        { chrome: '126.0.6478.127', electron: '31.2.1',  cv: '0.0.320', build: 344862, native: 50901, os: '10.0.22631' },
        { chrome: '120.0.6099.291', electron: '28.3.3',  cv: '0.0.309', build: 327348, native: 47563, os: '10.0.22631' },
        { chrome: '118.0.5993.119', electron: '27.3.11', cv: '0.0.305', build: 318682, native: 46102, os: '10.0.19045' },
    ];
    const fp  = POOL[Math.floor(Math.random() * POOL.length)];
    const ua  = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/${fp.cv} Chrome/${fp.chrome} Electron/${fp.electron} Safari/537.36`;
    const hex = (n) => crypto.randomBytes(n).toString('hex');
    const uuid = () => `${hex(4)}-${hex(2)}-${hex(2)}-${hex(2)}-${hex(6)}`;

    const dcfId     = uuid();
    const sdcfId    = hex(34);
    const cfuvid    = `${hex(4)}_${hex(4)}-${hex(4)}-${hex(8)}-${Math.floor(Date.now() / 1000)}`;
    const consentId = uuid();
    const cookies = [
        `__dcfduid=${dcfId}`,
        `__sdcfduid=${sdcfId}`,
        `locale=en-US`,
        `_cfuvid=${cfuvid}`,
        `OptanonConsent=isGpcEnabled=0&datestamp=${encodeURIComponent(new Date().toUTCString())}&version=202501.2.0&browserGpcFlag=0&isIABGlobal=false&consentId=${consentId}&interactionCount=1&isAnonUser=1&landingPath=NotLandingPage&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A1`,
    ].join('; ');

    const superProps = Buffer.from(JSON.stringify({
        os: 'Windows', browser: 'Discord Client', release_channel: 'stable',
        client_version: fp.cv, os_version: fp.os, os_arch: 'x64', app_arch: 'x64',
        system_locale: 'en-US', browser_user_agent: ua, browser_version: fp.electron,
        client_build_number: fp.build, native_build_number: fp.native,
        client_event_source: null, design_id: 0,
    })).toString('base64');

    const contextProps = Buffer.from(JSON.stringify({
        location: 'User Profile', location_tab: 'mutual_guilds',
    })).toString('base64');

    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';

    return { fp, ua, cookies, superProps, contextProps, tz };
})();

const VALID_PRESENCE_STATUSES = new Set(['online', 'idle', 'dnd']);
const MIN_STREAM_ROTATION_SEC = 60;
const MIN_CUSTOM_STATUS_SEC = 60;
const MAX_ROTATION_SEC = 86400;
const CONFIG_PATH = path.join(__dirname, "setup", "config.json");
const dashboardClients = new Set();
let dashboardCommandBuffer = "";
let pendingDashboardRefresh = false;

async function refreshDashboardClients(reason = "dashboard") {
    const clients = [...dashboardClients].filter(client => client?.user);
    if (!clients.length) {
        pendingDashboardRefresh = true;
        console.log(`[Dashboard] Refresh queued until an account is ready`.yellow);
        return;
    }

    await Promise.all(clients.map(client => client.refreshFromDashboard(reason).catch(e => {
        console.log(`[Dashboard] Refresh failed for ${client.user?.tag || client.user?.id || "account"}: ${e.message}`.red);
    })));
}

function setupDashboardControlChannel() {
    if (!process.stdin || process.stdin.isTTY) return;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => {
        dashboardCommandBuffer += chunk;
        const lines = dashboardCommandBuffer.split(/\r?\n/);
        dashboardCommandBuffer = lines.pop() || "";

        for (const line of lines) {
            const raw = line.trim();
            if (!raw) continue;
            let command = null;
            try {
                command = JSON.parse(raw);
            } catch {
                command = { type: raw };
            }

            if (command.type === "refreshPresence" || command.type === "refresh") {
                refreshDashboardClients(command.reason || "dashboard").catch(e => {
                    console.log(`[Dashboard] Refresh failed: ${e.message}`.red);
                });
            }
        }
    });
    process.stdin.resume();
}

class GetImage {
    constructor(client) {
        this.client = client;
    }

    isValidURL(url) {
        try { new URL(url); return true; }
        catch { return false; }
    }

    // Check if a Discord CDN attachment URL has expired
    isExpiredCdnUrl(url) {
        try {
            if (!url || !url.includes('cdn.discordapp.com/attachments')) return false;
            const ex = new URL(url).searchParams.get('ex');
            if (!ex) return false;
            return Date.now() > parseInt(ex, 16) * 1000;
        } catch { return false; }
    }

    // Convert a signed cdn.discordapp.com/attachments URL to a stable
    // media.discordapp.net URL that getExternal can actually proxy.
    // Discord's external-assets API rejects signed attachment URLs.
    convertCdnToMediaUrl(url) {
        try {
            if (!url) return url;
            const u = new URL(url);
            if (u.hostname !== 'cdn.discordapp.com') return url;
            if (!u.pathname.startsWith('/attachments/')) return url;
            // Replace host, strip signed query params
            u.hostname = 'media.discordapp.net';
            u.search = '';
            return u.toString();
        } catch { return url; }
    }

    // Check if URL is localhost (Discord servers can't reach it)
    isLocalUrl(url) {
        try {
            const h = new URL(url).hostname;
            return h === 'localhost' || h === '127.0.0.1' || h === '::1';
        } catch { return false; }
    }

    isManagedUploadUrl(url) {
        // Signed cdn.discordapp.com/attachments URLs must always be resolved
        // to their stable media.discordapp.net equivalents before getExternal.
        try {
            if (url) {
                const u = new URL(url);
                if (u.hostname === 'cdn.discordapp.com' && u.pathname.startsWith('/attachments/')) return true;
            }
        } catch {}
        const fileName = this.uploadFileNameFromUrl(url);
        if (!fileName) return false;
        if (this.isLocalUrl(url)) return true;
        return fs.existsSync(path.join(__dirname, "public", "uploads", fileName));
    }

    uploadFileNameFromUrl(url) {
        const safeDecode = (value) => {
            try { return decodeURIComponent(value); }
            catch { return value; }
        };
        try {
            const pathname = new URL(url).pathname;
            const raw = pathname.split('/uploads/').pop() || '';
            const fileName = path.basename(safeDecode(raw));
            return fileName && fileName !== 'manifest.json' ? fileName : null;
        } catch {
            const raw = String(url || '').split('/uploads/').pop()?.split(/[?#]/)[0] || '';
            const fileName = path.basename(safeDecode(raw));
            return fileName && fileName !== 'manifest.json' ? fileName : null;
        }
    }

    // Ask the dashboard server to resolve a URL:
    // - dashboard upload URLs → get/refresh Discord CDN URL
    // - expired CDN URLs → re-upload and return fresh URL
    // - valid URLs → returned unchanged
    async resolveImageUrl(url) {
        if (!url) return null;
        const managedUpload = this.isManagedUploadUrl(url);
        const localUrl = this.isLocalUrl(url);
        const needsResolve = managedUpload || localUrl || this.isExpiredCdnUrl(url);
        if (!needsResolve) return url;

        const reason = managedUpload ? 'dashboard upload URL' : localUrl ? 'local URL (unreachable by Discord)' : 'expired CDN URL';
        console.log(`[Image] Resolving ${reason}: ${url.slice(0, 60)}…`.yellow);

        try {
            const port = process.env.DASHBOARD_PORT || process.env.PORT || 5000;
            const r = await fetch(
                `http://localhost:${port}/api/uploads/resolve?url=${encodeURIComponent(url)}`,
                { signal: AbortSignal.timeout(25000) }
            );
            if (!r.ok) {
                console.log(`[Image] Resolve endpoint returned HTTP ${r.status}`.red);
                return url;
            }
            const data = await r.json();
            if (data.warning) console.log(`[Image] Warning: ${data.warning}`.yellow);
            if (data.refreshed) console.log(`[Image] URL refreshed from local backup`.cyan);
            if ((managedUpload || localUrl) && data.url === url && data.warning) return null;
            return data.url || url;
        } catch (e) {
            console.log(`[Image] Resolve error: ${e.message}`.red);
            // If it's a CDN attachment URL that we couldn't reach the resolve endpoint for,
            // fall back to the stable media URL conversion directly rather than returning null.
            if (managedUpload) {
                const converted = this.convertCdnToMediaUrl(url);
                if (converted !== url) {
                    console.log(`[Image] Fallback: using media.discordapp.net URL directly`.yellow);
                    return converted;
                }
            }
            return managedUpload || localUrl ? null : url;
        }
    }

    // ── Human-simulation nonce (Discord Snowflake-like ID) ───────────
    _simNonce() {
        const epoch = BigInt(Date.now() - 1420070400000);
        const inc   = BigInt(Math.floor(Math.random() * 4194304));
        return String((epoch << 22n) | inc);
    }

    // ── Human timing jitter: realistic pause before a request ────────
    _humanPause(minMs = 280, maxMs = 650) {
        const ms = minMs + Math.random() * (maxMs - minMs);
        return new Promise(r => setTimeout(r, Math.round(ms)));
    }

    // ── Primary: fully-simulated Discord desktop client request ──────
    // Calls POST /api/v9/applications/{appId}/external-assets directly
    // with a complete Discord desktop browser fingerprint, stable session
    // cookies, X-Super-Properties, and human timing jitter.
    // This looks like a real Discord client, not a bot API call.
    async _tryGetExternalSimulated(urls, applicationId) {
        const token = this.client?.token;
        if (!token) throw new Error('No client token available');

        const s   = _SIM_SESSION;
        const app = applicationId || '1109522937989562409';

        await this._humanPause(280, 650);

        const r = await fetch(
            `https://discord.com/api/v9/applications/${app}/external-assets`,
            {
                method: 'POST',
                signal: AbortSignal.timeout(15000),
                headers: {
                    'Authorization':         token,
                    'User-Agent':            s.ua,
                    'X-Super-Properties':    s.superProps,
                    'X-Context-Properties':  s.contextProps,
                    'X-Discord-Locale':      'en-US',
                    'X-Discord-Timezone':    s.tz,
                    'X-Debug-Options':       'bugReporterEnabled',
                    'X-Nonce':               this._simNonce(),
                    'Cookie':                s.cookies,
                    'Content-Type':          'application/json',
                    'Accept':                '*/*',
                    'Accept-Language':       'en-US,en;q=0.9',
                    'Accept-Encoding':       'gzip, deflate, br',
                    'Connection':            'keep-alive',
                    'Sec-Fetch-Dest':        'empty',
                    'Sec-Fetch-Mode':        'cors',
                    'Sec-Fetch-Site':        'same-origin',
                    'Referer':               'https://discord.com/channels/@me',
                    'Origin':                'https://discord.com',
                },
                body: JSON.stringify({ urls }),
            }
        );

        if (!r.ok) {
            const body = await r.text().catch(() => '');
            throw new Error(`HTTP ${r.status} — ${body.slice(0, 120)}`);
        }

        const data = await r.json();
        if (!Array.isArray(data) || !data.length) {
            throw new Error('External-assets API returned empty array');
        }
        return data;
    }

    // ── Low-level: call Discord's external-assets API ─────────────
    // Strategy: simulated human request first (3 attempts with back-off),
    // then falls back to the discord.js-selfbot-v13 library if simulation
    // fails entirely. The library is kept as a safety net, not removed.
    async _tryGetExternal(urls, applicationId) {
        const requested = urls.filter(Boolean);
        if (!requested.length) return [];

        // ── Pass 1: Full human simulation ────────────────────────────
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const images = await this._tryGetExternalSimulated(requested, applicationId);
                if (images.length) {
                    if (attempt > 1) console.log(`[Image] Simulated getExternal succeeded (attempt ${attempt})`.green);
                    else             console.log(`[Image] Simulated getExternal succeeded`.green);
                    return images;
                }
                throw new Error('Empty result');
            } catch (err) {
                if (attempt < 3) {
                    console.log(`[Image] Sim attempt ${attempt} failed (${err.message}) — retry in ${attempt * 2}s…`.yellow);
                    await new Promise(r => setTimeout(r, attempt * 2000));
                } else {
                    console.log(`[Image] Simulated getExternal failed after 3 attempts: ${err.message}`.yellow);
                    console.log(`[Image] Falling back to library getExternal…`.grey);
                }
            }
        }

        // ── Pass 2: discord.js-selfbot-v13 library (fallback) ────────
        const { getExternal } = RichPresence;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const images = await getExternal(this.client, applicationId || '1109522937989562409', ...requested);
                if (images.length) {
                    console.log(`[Image] Library getExternal succeeded (fallback)`.cyan);
                    return images;
                }
                throw new Error('Discord returned no external asset paths');
            } catch (err) {
                if (attempt < 3) {
                    console.log(`[Image] Library attempt ${attempt} failed (${err.message}) — retry in ${attempt * 2}s…`.yellow);
                    await new Promise(r => setTimeout(r, attempt * 2000));
                } else {
                    console.log(`[Image] Library getExternal also failed: ${err.message}`.red);
                    throw err;
                }
            }
        }
        return [];
    }

    // ── Map getExternal image list back to url1 / url2 slots
    // Discord's API returns items in the same ORDER as the input URLs.
    // We use URL matching first; if it fails (Discord normalized the URL),
    // we fall back to positional matching so mp:external/... is always used.
    _buildImageResult(images, url1, url2) {
        const resolve = (item) => item?.external_asset_path || item?.url || null;
        const inputs = [url1, url2].filter(Boolean);

        // Build lookup: exact URL → resolved value
        const byUrl = new Map();
        images.forEach((img, i) => {
            if (!img) return;
            const val = resolve(img);
            if (!val) return;
            // URL-based entry
            if (img.url) byUrl.set(img.url, val);
            // Positional fallback: map input[i] → val if not already mapped
            if (inputs[i] && !byUrl.has(inputs[i])) byUrl.set(inputs[i], val);
        });

        const big   = url1 ? (byUrl.get(url1) || null) : null;
        const small = url2 ? (byUrl.get(url2) || null) : null;

        // Log what we actually obtained so issues are visible in logs
        if (url1) {
            if (big?.startsWith('mp:')) console.log(`[Image] Large → ${big.slice(0, 60)}`.green);
            else if (big)              console.log(`[Image] Large → raw URL (mp: path missing) ${big.slice(0,60)}`.yellow);
            else                       console.log(`[Image] Large → no path obtained`.red);
        }
        if (url2) {
            if (small?.startsWith('mp:')) console.log(`[Image] Small → ${small.slice(0, 60)}`.green);
            else if (small)              console.log(`[Image] Small → raw URL (mp: path missing) ${small.slice(0,60)}`.yellow);
            else                         console.log(`[Image] Small → no path obtained`.red);
        }

        return { bigImage: big, smallImage: small };
    }

    // ── Ask the server to force-re-upload an image and return a fresh media URL
    async forceResolveUrl(url) {
        if (!url) return null;
        try {
            const port = process.env.DASHBOARD_PORT || process.env.PORT || 5000;
            const r = await fetch(
                `http://localhost:${port}/api/uploads/resolve?url=${encodeURIComponent(url)}&force=1`,
                { signal: AbortSignal.timeout(30000) }
            );
            if (!r.ok) return this.convertCdnToMediaUrl(url);
            const data = await r.json();
            return data.url || this.convertCdnToMediaUrl(url);
        } catch {
            return this.convertCdnToMediaUrl(url);
        }
    }

    // ── Deep preflight: verify a URL is actually reachable before calling getExternal.
    // Uses a real HTTP GET (not HEAD — some CDNs return 405 for HEAD) with a short
    // timeout, mimicking a browser image load. Returns { ok, status, reason }.
    async _preflightUrl(url) {
        if (!url) return { ok: false, reason: 'empty URL' };
        // Skip preflight for mp: paths (already Discord-internal)
        if (url.startsWith('mp:')) return { ok: true, reason: 'internal mp: path' };
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 7000);
            const r = await fetch(url, {
                method: 'GET',
                signal: ctrl.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                    'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                },
            });
            clearTimeout(timer);
            // 200–299 = ok, 302/301 = redirect (ok), 404/403 = broken
            const ok = r.status < 400;
            if (!ok) console.log(`[Image] Preflight ${r.status} — ${url.slice(0, 70)}`.yellow);
            return { ok, status: r.status, reason: ok ? 'reachable' : `HTTP ${r.status}` };
        } catch (e) {
            // Timeout, CORS abort, DNS failure — treat as likely inaccessible
            const reason = e.name === 'AbortError' ? 'timeout' : e.message;
            console.log(`[Image] Preflight error (${reason}) — ${url.slice(0, 70)}`.yellow);
            // On network errors we allow the attempt anyway (server-side restrictions differ from bot)
            return { ok: true, reason: `network error (${reason}) — allowing anyway` };
        }
    }

    // ── Run one strategy: preflight → getExternal → verify mp: paths obtained
    // Returns { bigImage, smallImage } if the strategy succeeds, null otherwise.
    async _runStrategy(label, rawUrls, url1, url2, applicationId) {
        const urls = rawUrls.filter(Boolean);
        if (!urls.length) return null;

        // ── Preflight: verify each URL is actually accessible ──────────────
        const checks = await Promise.all(urls.map(u => this._preflightUrl(u)));
        const alive  = urls.filter((_, i) => checks[i].ok);
        const dead   = urls.filter((_, i) => !checks[i].ok);

        if (dead.length) console.log(`[Image] ${label} preflight: ${dead.length} URL(s) not reachable — skipping them`.yellow);
        if (!alive.length) {
            console.log(`[Image] ${label}: all URLs failed preflight — skipping strategy`.yellow);
            return null;
        }

        // Adjust url1/url2 slots to only use alive URLs
        const alive1 = alive.includes(url1) ? url1 : null;
        const alive2 = alive.includes(url2) ? url2 : null;

        // ── getExternal call with retry ────────────────────────────────────
        try {
            const images = await this._tryGetExternal(alive, applicationId);
            if (!images.length) {
                console.log(`[Image] ${label}: getExternal returned empty`.yellow);
                return null;
            }
            const result = this._buildImageResult(images, alive1 || url1, alive2 || url2);

            // ── Verify we got actual mp: paths (not just raw URLs) ─────────
            const hasMp = (result.bigImage?.startsWith('mp:') || !url1) &&
                          (result.smallImage?.startsWith('mp:') || !url2);
            if (hasMp) {
                console.log(`[Image] ${label} ✓ — mp:external paths confirmed`.green);
                return result;
            }
            console.log(`[Image] ${label}: accepted but no mp: path returned — continuing to next strategy`.yellow);
            return null;
        } catch (e) {
            console.log(`[Image] ${label} rejected by Discord: ${e.message}`.yellow);
            return null;
        }
    }

    async get(url1, url2, applicationId) {
        try {
            url1 = this.isValidURL(url1) ? url1 : null;
            url2 = this.isValidURL(url2) ? url2 : null;
            if (!url1 && !url2) throw new Error("No Image");

            console.log(`[Image] ── Starting image resolution ──`.grey);

            // Resolve local / managed-upload / expired CDN URLs via dashboard server
            [url1, url2] = await Promise.all([
                this.resolveImageUrl(url1),
                this.resolveImageUrl(url2),
            ]);
            if (!url1 && !url2) throw new Error("No Image after resolution");

            // ══════════════════════════════════════════════════════════════
            // Strategy 0 — Direct URL (exactly as stored, before CDN conversion)
            // Try the URL the user configured without any transformation.
            // Preflight verifies it's actually reachable before calling Discord.
            // ══════════════════════════════════════════════════════════════
            console.log(`[Image] Strategy 0 — direct URL (as stored)…`.grey);
            const s0 = await this._runStrategy('S0:direct', [url1, url2], url1, url2, applicationId);
            if (s0) return s0;

            // ══════════════════════════════════════════════════════════════
            // Strategy 1 — Convert to media.discordapp.net (stable, no expiry)
            // Signed cdn.discordapp.com attachment URLs → media.discordapp.net
            // (only changes URL if it was a signed CDN URL; no-op otherwise)
            // ══════════════════════════════════════════════════════════════
            const m1 = this.convertCdnToMediaUrl(url1);
            const m2 = this.convertCdnToMediaUrl(url2);
            if (m1 !== url1 || m2 !== url2) {
                // Only run S1 if the URLs actually changed (avoid duplicate attempt)
                console.log(`[Image] Strategy 1 — media.discordapp.net (converted)…`.grey);
                const s1 = await this._runStrategy('S1:media', [m1, m2], m1, m2, applicationId);
                if (s1) return s1;
            } else {
                console.log(`[Image] Strategy 1 — skipped (same URL as S0)`.grey);
            }

            // ══════════════════════════════════════════════════════════════
            // Strategy 2 — Force re-upload → fresh CDN URL → new media URL
            // Bypasses any cached/stale URL by uploading the local file again.
            // Only applies to images with a local backup (managed uploads).
            // ══════════════════════════════════════════════════════════════
            const isMgd1 = url1 && this.isManagedUploadUrl(url1);
            const isMgd2 = url2 && this.isManagedUploadUrl(url2);
            if (isMgd1 || isMgd2) {
                console.log(`[Image] Strategy 2 — force re-upload…`.yellow);
                const [fresh1, fresh2] = await Promise.all([
                    isMgd1 ? this.forceResolveUrl(url1) : Promise.resolve(url1),
                    isMgd2 ? this.forceResolveUrl(url2) : Promise.resolve(url2),
                ]);
                const s2 = await this._runStrategy('S2:reupload', [fresh1, fresh2], fresh1, fresh2, applicationId);
                if (s2) return s2;
            }

            // ══════════════════════════════════════════════════════════════
            // Strategy 3 — Pass URL directly to Discord (no getExternal)
            // Discord's selfbot library accepts raw https:// URLs in setAssetsLargeImage
            // and handles the external-assets conversion internally on some versions.
            // Last resort before giving up completely.
            // ══════════════════════════════════════════════════════════════
            const directUrl1 = m1 || url1;
            const directUrl2 = m2 || url2;
            const directChecks = await Promise.all([
                directUrl1 ? this._preflightUrl(directUrl1) : Promise.resolve({ ok: false }),
                directUrl2 ? this._preflightUrl(directUrl2) : Promise.resolve({ ok: false }),
            ]);
            const hasDirect = directChecks.some(c => c.ok);
            if (hasDirect) {
                const d1 = (directUrl1 && directChecks[0].ok) ? directUrl1 : null;
                const d2 = (directUrl2 && directChecks[1].ok) ? directUrl2 : null;
                console.log(`[Image] Strategy 3 — direct URL bypass (no getExternal)…`.yellow);
                console.log(`[Image] S3: passing URL directly — Discord library will handle it`.grey);
                return { bigImage: d1, smallImage: d2 };
            }

            // ══════════════════════════════════════════════════════════════
            // All strategies exhausted — explicit failure, never silent
            // ══════════════════════════════════════════════════════════════
            console.log(`[Image] ✗ All strategies failed — images will be hidden`.red);
            console.log(`[Image]   Tried: ${[url1, url2].filter(Boolean).join(' | ')}`.red);
            console.log(`[Image]   → Go to Streaming → Check CDN to fix image URLs`.yellow);
            return { bigImage: null, smallImage: null };

        } catch (e) {
            console.log(`[Image] Error during image resolution: ${e.message}`.red);
            return { bigImage: null, smallImage: null };
        }
    }
}

class Weather {
    constructor(location) {
        this.location = location;
        this.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        this.city = "";
        this.region = "";
        this.country = "";
        this.temp_c = 0;
        this.temp_f = 0;
        this.wind_kph = 0;
        this.wind_mph = 0;
        this.wind_degree = 0;
        this.pressure_mb = 0;
        this.pressure_in = 0;
        this.precip_mm = 0;
        this.precip_in = 0;
        this.wind_dir = "";
        this.gust_kph = 0;
        this.gust_mph = 0;
        this.vis_km = 0;
        this.vis_mi = 0;
        this.humidity = 0;
        this.cloud = 0;
        this.uv = 0;
        this.pm2_5 = 0;
        this.feelslike_c = 0;
        this.feelslike_f = 0;
        this.windchill_c = 0;
        this.windchill_f = 0;
        this.heatindex_c = 0;
        this.heatindex_f = 0;
        this.dewpoint_c = 0;
        this.dewpoint_f = 0;
        this.co = 0;
        this.no2 = 0;
        this.o3 = 0;
        this.so2 = 0;
        this.pm10 = 0;
        this.stop = 0;
        schedule("*/5 * * * *", () => this.update());
    }

    async update() {
        try {
            const params = new URLSearchParams();
            params.append("key", process.env.WEATHER_API_KEY || "1e1a0f498dbf472cb3991045241608");
            params.append('q', encodeURIComponent(this.location));
            params.append("aqi", "yes");

            const response = await fetch(`https://api.weatherapi.com/v1/current.json?${params}`);
            const data = await response.json();

            this.timezone = data.location.tz_id;
            this.city = data.location.name;
            this.region = data.location.region;
            this.country = data.location.country;
            this.temp_c = data.current.temp_c;
            this.temp_f = data.current.temp_f;
            this.wind_kph = data.current.wind_kph;
            this.wind_mph = data.current.wind_mph;
            this.wind_degree = data.current.wind_degree;
            this.pressure_mb = data.current.pressure_mb;
            this.pressure_in = data.current.pressure_in;
            this.precip_mm = data.current.precip_mm;
            this.precip_in = data.current.precip_in;
            this.wind_dir = data.current.wind_dir;
            this.gust_kph = data.current.gust_kph;
            this.gust_mph = data.current.gust_mph;
            this.vis_km = data.current.vis_km;
            this.vis_mi = data.current.vis_miles;
            this.humidity = data.current.humidity;
            this.cloud = data.current.cloud;
            this.uv = data.current.uv;
            this.pm2_5 = data.current.air_quality.pm2_5;
            this.feelslike_c = data.current.feelslike_c;
            this.feelslike_f = data.current.feelslike_f;
            this.windchill_c = data.current.windchill_c;
            this.windchill_f = data.current.windchill_f;
            this.heatindex_c = data.current.heatindex_c;
            this.heatindex_f = data.current.heatindex_f;
            this.dewpoint_c = data.current.dewpoint_c;
            this.dewpoint_f = data.current.dewpoint_f;
            this.co = data.current.air_quality.co;
            this.no2 = data.current.air_quality.no2;
            this.o3 = data.current.air_quality.o3;
            this.so2 = data.current.air_quality.so2;
            this.pm10 = data.current.air_quality.pm10;
        } catch {
            if (this.stop > 10) {
                return;
            }
            this.stop++;
            this.update();
        }
    }
}

class SystemInfo {
    constructor() {
        this.cpuname = os.cpus()[0]?.model;
        this.cpucores = os.cpus()?.length;
        this.cpuspeed = (os.cpus()[0]?.speed / 1000 || 0).toFixed(1);
        this.cpu = 0;
        this.ram = 0;
    }

    getCpuUsage() {
        let totalIdle = 0, totalTick = 0;
        const cpus = os.cpus();

        cpus.forEach(cpu => {
            for (let type in cpu.times) {
                totalTick += cpu.times[type];
            }
            totalIdle += cpu.times.idle;
        });

        return 100 - Math.floor(totalIdle / totalTick * 100);
    }

    async getCpuUsageOverInterval(interval) {
        return new Promise(resolve => {
            const startMeasure = this._measureCpuTimes();
            setTimeout(() => {
                const endMeasure = this._measureCpuTimes();
                const idleDifference = endMeasure.idle - startMeasure.idle;
                const totalDifference = endMeasure.total - startMeasure.total;
                resolve(100 - Math.floor(idleDifference / totalDifference * 100));
            }, interval);
        });
    }

    _measureCpuTimes() {
        let totalIdle = 0, totalTick = 0;
        const cpus = os.cpus();

        cpus.forEach(cpu => {
            for (let type in cpu.times) {
                totalTick += cpu.times[type];
            }
            totalIdle += cpu.times.idle;
        });

        return { idle: totalIdle, total: totalTick };
    }

    getRamUsage() {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        return Math.floor((totalMem - freeMem) / totalMem * 100);
    }

    async update() {
        this.cpu = await this.getCpuUsageOverInterval(1000);
        this.ram = this.getRamUsage();
    }
}

class Emoji {
    random() {
        const emojis = ['😄', '😃', '😀', '😊', '☺', '😉', '😍', '😘', '😚', '😗', '😙', '😜', '😝', '😛', '😳', '😁', '😔', '😌', '😒', '😞', '😣', '😢', '😂', '😭', '😪', '😥', '😰', '😅', '😓', '😩', '😫', '😨', '😱', '😠', '😡', '😤', '😖', '😆', '😋', '😷', '😎', '😴', '😵', '😲', '😟', '😦', '😧', '😈', '👿', '😮', '😬', '😐', '😕', '😯', '😶', '😇', '😏', '😑', '👲', '👳', '👮', '👷', '💂', '👶', '👦', '👧', '👨', '👩', '👴', '👵', '👱', '👼', '👸', '😺', '😸', '😻', '😽', '😼', '🙀', '😿', '😹', '😾', '👹', '👺', '🙈', '🙉', '🙊', '💀', '👽', '💩', '🔥', '✨', '🌟', '💫', '💥', '💢', '💦', '💧', '💤', '💨', '👂', '👀', '👃', '👅', '👄', '👍', '👎', '👌', '👊', '✊', '✌', '👋', '✋', '👐', '👆', '👇', '👉', '👈', '🙌', '🙏', '☝', '👏', '💪', '🚶', '🏃', '💃', '👫', '👪', '👬', '👭', '💏', '💑', '👯', '🙆', '🙅', '💁', '🙋', '💆', '💇', '💅', '👰', '🙎', '🙍', '🙇', '🎩', '👑', '👒', '👟', '👞', '👡', '👠', '👢', '👕', '👔', '👚', '👗', '🎽', '👖', '👘', '👙', '💼', '👜', '👝', '👛', '👓', '🎀', '🌂', '💄', '💛', '💙', '💜', '💚', '❤', '💔', '💗', '💓', '💕', '💖', '💞', '💘', '💌', '💋', '💍', '💎', '👤', '👥', '💬', '👣', '💭', '🐶', '🐺', '🐱', '🐭', '🐹', '🐰', '🐸', '🐯', '🐨', '🐻', '🐷', '🐽', '🐮', '🐗', '🐵', '🐒', '🐴', '🐑', '🐘', '🐼', '🐧', '🐦', '🐤', '🐥', '🐣', '🐔', '🐍', '🐢', '🐛', '🐝', '🐜', '🐞', '🐌', '🐙', '🐚', '🐠', '🐟', '🐬', '🐳', '🐋', '🐄', '🐏', '🐀', '🐃', '🐅', '🐇', '🐉', '🐎', '🐐', '🐓', '🐕', '🐖', '🐁', '🐂', '🐲', '🐡', '🐊', '🐫', '🐪', '🐆', '🐈', '🐩', '🐾', '💐', '🌸', '🌷', '🍀', '🌹', '🌻', '🌺', '🍁', '🍃', '🍂', '🌿', '🌾', '🍄', '🌵', '🌴', '🌲', '🌳', '🌰', '🌱', '🌼', '🌐', '🌞', '🌝', '🌚', '🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘', '🌜', '🌛', '🌙', '🌍', '🌎', '🌏', '🌋', '🌌', '🌠', '⭐', '☀', '⛅', '☁', '⚡', '☔', '❄', '⛄', '🌀', '🌁', '🌈', '🌊', '🎍', '💝', '🎎', '🎒', '🎓', '🎏', '🎆', '🎇', '🎐', '🎑', '🎃', '👻', '🎅', '🎄', '🎁', '🎋', '🎉', '🎊', '🎈', '🎌', '🔮', '🎥', '📷', '📹', '📼', '💿', '📀', '💽', '💾', '💻', '📱', '☎', '📞', '📟', '📠', '📡', '📺', '📻', '🔊', '🔉', '🔈', '🔇', '🔔', '🔕', '📢', '📣', '⏳', '⌛', '⏰', '⌚', '🔓', '🔒', '🔏', '🔐', '🔑', '🔎', '💡', '🔦', '🔆', '🔅', '🔌', '🔋', '🔍', '🛁', '🛀', '🚿', '🚽', '🔧', '🔩', '🔨', '🚪', '🚬', '💣', '🔫', '🔪', '💊', '💉', '💰', '💴', '💵', '💷', '💶', '💳', '💸', '📲', '📧', '📥', '📤', '✉', '📩', '📨', '📯', '📫', '📪', '📬', '📭', '📮', '📦', '📝', '📄', '📃', '📑', '📊', '📈', '📉', '📜', '📋', '📅', '📆', '📇', '📁', '📂', '✂', '📌', '📎', '✒', '✏', '📏', '📐', '📕', '📗', '📘', '📙', '📓', '📔', '📒', '📚', '📖', '🔖', '📛', '🔬', '🔭', '📰', '🎨', '🎬', '🎤', '🎧', '🎼', '🎵', '🎶', '🎹', '🎻', '🎺', '🎷', '🎸', '👾', '🎮', '🃏', '🎴', '🀄', '🎲', '🎯', '🏈', '🏀', '⚽', '⚾', '🎾', '🎱', '🏉', '🎳', '⛳', '🚵', '🚴', '🏁', '🏇', '🏆', '🎿', '🏂', '🏊', '🏄', '🎣', '☕', '🍵', '🍶', '🍼', '🍺', '🍻', '🍸', '🍹', '🍷', '🍴', '🍕', '🍔', '🍟', '🍗', '🍖', '🍝', '🍛', '🍤', '🍱', '🍣', '🍥', '🍙', '🍘', '🍚', '🍜', '🍲', '🍢', '🍡', '🍳', '🍞', '🍩', '🍮', '🍦', '🍨', '🍧', '🎂', '🍰', '🍪', '🍫', '🍬', '🍭', '🍯', '🍎', '🍏', '🍊', '🍋', '🍒', '🍇', '🍉', '🍓', '🍑', '🍈', '🍌', '🍐', '🍍', '🍠', '🍆', '🍅', '🌽', '🏠', '🏡', '🏫', '🏢', '🏣', '🏥', '🏦', '🏪', '🏩', '🏨', '💒', '⛪', '🏬', '🏤', '🌇', '🌆', '🏯', '🏰', '⛺', '🏭', '🗼', '🗾', '🗻', '🌄', '🌅', '🌃', '🗽', '🌉', '🎠', '🎡', '⛲', '🎢', '🚢', '⛵', '🚤', '🚣', '⚓', '🚀', '✈', '💺', '🚁', '🚂', '🚊', '🚉', '🚞', '🚆', '🚄', '🚅', '🚈', '🚇', '🚝', '🚋', '🚃', '🚎', '🚌', '🚍', '🚙', '🚘', '🚗', '🚕', '🚖', '🚛', '🚚', '🚨', '🚓', '🚔', '🚒', '🚑', '🚐', '🚲', '🚡', '🚟', '🚠', '🚜', '💈', '🚏', '🎫', '🚦', '🚥', '⚠', '🚧', '🔰', '⛽', '🏮', '🎰', '♨', '🗿', '🎪', '🎭', '📍', '🚩', '⬆', '⬇', '⬅', '➡', '🔠', '🔡', '🔤', '↗', '↖', '↘', '↙', '↔', '↕', '🔄', '◀', '▶', '🔼', '🔽', '↩', '↪', 'ℹ', '⏪', '⏩', '⏫', '⏬', '⤵', '⤴', '🆗', '🔀', '🔁', '🔂', '🆕', '🆙', '🆒', '🆓', '🆖', '📶', '🎦', '🈁', '🈯', '🈳', '🈵', '🈴', '🈲', '🉐', '🈹', '🈺', '🈶', '🈚', '🚻', '🚹', '🚺', '🚼', '🚾', '🚰', '🚮', '🅿', '♿', '🚭', '🈷', '🈸', '🈂', 'Ⓜ', '🛂', '🛄', '🛅', '🛃', '🉑', '㊙', '㊗', '🆑', '🆘', '🆔', '🚫', '🔞', '📵', '🚯', '🚱', '🚳', '🚷', '🚸', '⛔', '✳', '❇', '❎', '✅', '✴', '💟', '🆚', '📳', '📴', '🅰', '🅱', '🆎', '🅾', '💠', '➿', '♻', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓', '⛎', '🔯', '🏧', '💹', '💲', '💱', '©', '®', '™', '〽', '〰', '🔝', '🔚', '🔙', '🔛', '🔜', '❌', '⭕', '❗', '❓', '❕', '❔', '🔃', '🕛', '🕧', '🕐', '🕜', '🕑', '🕝', '🕒', '🕞', '🕓', '🕟', '🕔', '🕠', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕡', '🕢', '🕣', '🕤', '🕥', '🕦', '✖', '➕', '➖', '➗', '♠', '♥', '♣', '♦', '💮', '💯', '✔', '☑', '🔘', '🔗', '➰', '🔱', '🔲', '🔳', '◼', '◻', '◾', '◽', '▪', '▫', '🔺', '⬜', '⬛', '⚫', '⚪', '🔴', '🔵', '🔻', '🔶', '🔷', '🔸', '🔹'];
        return emojis[Math.floor(Math.random() * emojis.length)];
    }

    getTime(hour) {
        const parsedHour = parseInt(hour, 10);
        return isNaN(parsedHour)
            ? "Invalid hour"
            : parsedHour >= 6 && parsedHour < 18
                ? "☀️"
                : "🌙";
    }

    getClock(hour) {
        const parsedHour = parseInt(hour, 10);
        const clocks = ["🕛", "🕐", "🕑", "🕒", "🕓", "🕔", "🕕", "🕖", "🕗", "🕘", "🕙", "🕚"];
        return parsedHour >= 0 && parsedHour <= 23
            ? clocks[parsedHour % 12]
            : "Invalid hour";
    }
}

class TextFont {
    getFont1(text) {
        const fontMap = {
            a: "๐", b: "๑", c: "๒", d: "๓", e: "๔", f: "๕", g: "๖",
            h: "๗", i: "๘", j: "๙", k: "๐", l: "๑", m: "๒", n: "๓",
            o: "๔", p: "๕", q: "๖", r: "๗", s: "๘", t: "๙", u: "๐",
            v: "๑", w: "๒", x: "๓", y: "๔", z: "๕",

            A: "๐", B: "๑", C: "๒", D: "๓", E: "๔", F: "๕", G: "๖",
            H: "๗", I: "๘", J: "๙", K: "๐", L: "๑", M: "๒", N: "๓",
            O: "๔", P: "๕", Q: "๖", R: "๗", S: "๘", T: "๙", U: "๐",
            V: "๑", W: "๒", X: "๓", Y: "๔", Z: "๕",

            "0": "๐", "1": "๑", "2": "๒", "3": "๓", "4": "๔",
            "5": "๕", "6": "๖", "7": "๗", "8": "๘", "9": "๙",

            "°": "°", ":": ":", "/": "/", " ": " ", "(": "(", ")": ")",
            "⤿": "⤿", "★": "★", "☆": "☆", "༊": "༊", "*": "*", "·": "·",
            "˚": "˚", "꒰": "꒰", "꒱": "꒱", "ˏ": "ˏ", "ˋ": "ˋ", "´": "´",
            "ˎ": "ˎ", "✦": "✦"
        };
        return text.split("").map(char => fontMap[char] || char).join("");
    }
    getFont2(text) {
        const fontMap = {
            a: "𝕒", b: "𝕓", c: "𝕔", d: "𝕕", e: "𝕖", f: "𝕗", g: "𝕘",
            h: "𝕙", i: "𝕚", j: "𝕛", k: "𝕜", l: "𝕝", m: "𝕞", n: "𝕟",
            o: "𝕠", p: "𝕡", q: "𝕢", r: "𝕣", s: "𝕤", t: "𝕥", u: "𝕦",
            v: "𝕧", w: "𝕨", x: "𝕩", y: "𝕪", z: "𝕫",

            A: "𝔸", B: "𝔹", C: "ℂ", D: "𝔻", E: "𝔼", F: "𝔽", G: "𝔾",
            H: "ℍ", I: "𝕀", J: "𝕁", K: "𝕂", L: "𝕃", M: "𝕄", N: "ℕ",
            O: "𝕆", P: "ℙ", Q: "ℚ", R: "ℝ", S: "𝕊", T: "𝕋", U: "𝕌",
            V: "𝕍", W: "𝕎", X: "𝕏", Y: "𝕐", Z: "ℤ",

            "0": "𝟘", "1": "𝟙", "2": "𝟚", "3": "𝟛", "4": "𝟜",
            "5": "𝟝", "6": "𝟞", "7": "𝟟", "8": "𝟠", "9": "𝟡",

            "°": "°", ":": ":", "/": "/", " ": " ", "(": "(", ")": ")",
            "⤿": "⤿", "★": "★", "☆": "☆", "༊": "༊", "*": "*", "·": "·",
            "˚": "˚", "꒰": "꒰", "꒱": "꒱", "ˏ": "ˏ", "ˋ": "ˋ", "´": "´",
            "ˎ": "ˎ", "✦": "✦"
        };
        return text.split("").map(char => fontMap[char] || char).join("");
    }

    getFont3(text) {
        const fontMap = {
            a: "𝗮", b: "𝗯", c: "𝗰", d: "𝗱", e: "𝗲", f: "𝗳", g: "𝗴",
            h: "𝗵", i: "𝗶", j: "𝗷", k: "𝗸", l: "𝗹", m: "𝗺", n: "𝗻",
            o: "𝗼", p: "𝗽", q: "𝗾", r: "𝗿", s: "𝘀", t: "𝘁", u: "𝘂",
            v: "𝘃", w: "𝘄", x: "𝘅", y: "𝘆", z: "𝘇",

            A: "𝗔", B: "𝗕", C: "𝗖", D: "𝗗", E: "𝗘", F: "𝗙", G: "𝗚",
            H: "𝗛", I: "𝗜", J: "𝗝", K: "𝗞", L: "𝗟", M: "𝗠", N: "𝗡",
            O: "𝗢", P: "𝗣", Q: "𝗤", R: "𝗥", S: "𝗦", T: "𝗧", U: "𝗨",
            V: "𝗩", W: "𝗪", X: "𝗫", Y: "𝗬", Z: "𝗭",

            "0": "𝟬", "1": "𝟭", "2": "𝟮", "3": "𝟯", "4": "𝟰",
            "5": "𝟱", "6": "𝟲", "7": "𝟳", "8": "𝟴", "9": "𝟵",

            "°": "°", ":": ":", "/": "/", " ": " ", "(": "(", ")": ")",
            "⤿": "⤿", "★": "★", "☆": "☆", "༊": "༊", "*": "*", "·": "·",
            "˚": "˚", "꒰": "꒰", "꒱": "꒱", "ˏ": "ˏ", "ˋ": "ˋ", "´": "´",
            "ˎ": "ˎ", "✦": "✦"
        };
        return text.split("").map(char => fontMap[char] || char).join("");
    }


    getFont4(text) {
        const fontMap = {
            a: "𝒶", b: "𝒷", c: "𝒸", d: "𝒹", e: "𝑒", f: "𝒻", g: "𝑔",
            h: "𝒽", i: "𝒾", j: "𝒿", k: "𝓀", l: "𝓁", m: "𝓂", n: "𝓃",
            o: "𝑜", p: "𝓅", q: "𝓆", r: "𝓇", s: "𝓈", t: "𝓉", u: "𝓊",
            v: "𝓋", w: "𝓌", x: "𝓍", y: "𝓎", z: "𝓏",

            A: "𝒜", B: "ℬ", C: "𝒞", D: "𝒟", E: "ℰ", F: "ℱ", G: "𝒢",
            H: "ℋ", I: "ℐ", J: "𝒥", K: "𝒦", L: "ℒ", M: "ℳ", N: "𝒩",
            O: "𝒪", P: "𝒫", Q: "𝒬", R: "ℛ", S: "𝒮", T: "𝒯", U: "𝒰",
            V: "𝒱", W: "𝒲", X: "𝒳", Y: "𝒴", Z: "𝒵",

            "0": "0", "1": "1", "2": "2", "3": "3", "4": "4",
            "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",

            "°": "°", ":": ":", "/": "/", " ": " ", "(": "(", ")": ")",
            "⤿": "⤿", "★": "★", "☆": "☆", "༊": "༊", "*": "*", "·": "·",
            "˚": "˚", "꒰": "꒰", "꒱": "꒱", "ˏ": "ˏ", "ˋ": "ˋ", "´": "´",
            "ˎ": "ˎ", "✦": "✦"
        };
        return text.split("").map(char => fontMap[char] || char).join("");
    }

    getFont5(text) {
        const fontMap = {
            a: "𝓪", b: "𝓫", c: "𝓬", d: "𝓭", e: "𝓮", f: "𝓯", g: "𝓰",
            h: "𝓱", i: "𝓲", j: "𝓳", k: "𝓴", l: "𝓵", m: "𝓶", n: "𝓷",
            o: "𝓸", p: "𝓹", q: "𝓺", r: "𝓻", s: "𝓼", t: "𝓽", u: "𝓾",
            v: "𝓿", w: "𝔀", x: "𝔁", y: "𝔂", z: "𝔃",

            A: "𝓐", B: "𝓑", C: "𝓒", D: "𝓓", E: "𝓔", F: "𝓕", G: "𝓖",
            H: "𝓗", I: "𝓘", J: "𝓙", K: "𝓚", L: "𝓛", M: "𝓜", N: "𝓝",
            O: "𝓞", P: "𝓟", Q: "𝓠", R: "𝓡", S: "𝓢", T: "𝓣", U: "𝓤",
            V: "𝓥", W: "𝓦", X: "𝓧", Y: "𝓨", Z: "𝓩",

            "0": "0", "1": "1", "2": "2", "3": "3", "4": "4",
            "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",

            "°": "°", ":": ":", "/": "/", " ": " ", "(": "(", ")": ")",
            "⤿": "⤿", "★": "★", "☆": "☆", "༊": "༊", "*": "*", "·": "·",
            "˚": "˚", "꒰": "꒰", "꒱": "꒱", "ˏ": "ˏ", "ˋ": "ˋ", "´": "´",
            "ˎ": "ˎ", "✦": "✦"
        };
        return text.split("").map(char => fontMap[char] || char).join("");
    }

    getFont6(text) {
        const fontMap = {
            a: "ⓐ", b: "ⓑ", c: "ⓒ", d: "ⓓ", e: "ⓔ", f: "ⓕ", g: "ⓖ",
            h: "ⓗ", i: "ⓘ", j: "ⓙ", k: "ⓚ", l: "ⓛ", m: "ⓜ", n: "ⓝ",
            o: "ⓞ", p: "ⓟ", q: "ⓠ", r: "ⓡ", s: "ⓢ", t: "ⓣ", u: "ⓤ",
            v: "ⓥ", w: "ⓦ", x: "ⓧ", y: "ⓨ", z: "ⓩ",

            A: "Ⓐ", B: "Ⓑ", C: "Ⓒ", D: "Ⓓ", E: "Ⓔ", F: "Ⓕ", G: "Ⓖ",
            H: "Ⓗ", I: "Ⓘ", J: "Ⓙ", K: "Ⓚ", L: "Ⓛ", M: "Ⓜ", N: "Ⓝ",
            O: "Ⓞ", P: "Ⓟ", Q: "Ⓠ", R: "Ⓡ", S: "Ⓢ", T: "Ⓣ", U: "Ⓤ",
            V: "Ⓥ", W: "Ⓦ", X: "Ⓧ", Y: "Ⓨ", Z: "Ⓩ",

            "0": "⓪", "1": "①", "2": "②", "3": "③", "4": "④",
            "5": "⑤", "6": "⑥", "7": "⑦", "8": "⑧", "9": "⑨",

            "°": "°", ":": ":", "/": "/", " ": " ", "(": "(", ")": ")",
            "⤿": "⤿", "★": "★", "☆": "☆", "༊": "༊", "*": "*", "·": "·",
            "˚": "˚", "꒰": "꒰", "꒱": "꒱", "ˏ": "ˏ", "ˋ": "ˋ", "´": "´",
            "ˎ": "ˎ", "✦": "✦"
        };
        return text.split("").map(char => fontMap[char] || char).join("");
    }
}

// ── Fingerprint Pool (rotates per session) ─────────────────────────
// Realistic Discord desktop client profiles — latest builds 2025
const FP_POOL = [
    {
        client_version:      '1.0.9194',
        chrome:              '128.0.6613.186',
        electron:            '32.2.7',
        client_build_number: 389842,
        native_build_number: 56378,
        os_version:          '10.0.22631',
    },
    {
        client_version:      '1.0.9188',
        chrome:              '128.0.6613.114',
        electron:            '32.2.5',
        client_build_number: 386204,
        native_build_number: 55910,
        os_version:          '10.0.19045',
    },
    {
        client_version:      '1.0.9177',
        chrome:              '126.0.6478.234',
        electron:            '31.7.6',
        client_build_number: 381502,
        native_build_number: 55102,
        os_version:          '10.0.22631',
    },
];

// ── Cookie generator (realistic Discord session cookies) ───────────
function genHex(len) {
    let s = '';
    const chars = '0123456789abcdef';
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * 16)];
    return s;
}
function genDcfduid()  { return genHex(8) + '-' + genHex(4) + '-' + genHex(4) + '-' + genHex(4) + '-' + genHex(12); }
function genSdcfduid() { return genHex(68); }
function genCfuvid()   { return genHex(8) + '_' + genHex(8) + '-' + genHex(8) + '-' + genHex(16) + '-' + Math.floor(Date.now()/1000); }

class ModClient extends Client {
    constructor(token, config, info) {
        // ── Pick a random fingerprint profile for this session ──────
        const fp = FP_POOL[Math.floor(Math.random() * FP_POOL.length)];
        const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/${fp.client_version} Chrome/${fp.chrome} Electron/${fp.electron} Safari/537.36`;

        super({
            partials: [],
            makeCache: Options.cacheWithLimits({ MessageManager: 0 }),
            checkUpdate: false,
            readyStatus: false,
            ws: {
                properties: {
                    os:                  'Windows',
                    browser:             'Discord Client',
                    release_channel:     'stable',
                    client_version:      fp.client_version,
                    os_version:          fp.os_version,
                    os_arch:             'x64',
                    app_arch:            'x64',
                    system_locale:       'en-US',
                    browser_user_agent:  UA,
                    browser_version:     fp.electron,
                    client_build_number: fp.client_build_number,
                    native_build_number: fp.native_build_number,
                    client_event_source: null,
                    design_id:           0,
                    device:              '',
                },
            },
        });

        this.TOKEN      = token;
        this.config     = config;
        this.targetTime = info.wait;
        this.intervals  = new Set();
        this._fp        = fp;
        this._UA        = UA;

        // ── Generate unique session cookies ─────────────────────────
        this._cookies = {
            __dcfduid:      genDcfduid(),
            __sdcfduid:     genSdcfduid(),
            locale:         'en-US',
            _cfuvid:        genCfuvid(),
            OptanonConsent: `isGpcEnabled=0&datestamp=${encodeURIComponent(new Date().toUTCString())}&version=202501.2.0&browserGpcFlag=0&isIABGlobal=false&consentId=${genDcfduid()}&interactionCount=1&isAnonUser=1&landingPath=NotLandingPage&groups=C0001%3A1%2CC0002%3A1%2CC0003%3A1`,
        };

        this.weather = new Weather('');
        this.sys         = new SystemInfo();
        this.emoji       = new Emoji();
        this.textFont    = new TextFont();
        this.getExternal = new GetImage(this);
        this.cacheImage  = new Map();
        this.lib         = { count: 0, countParty: 1, timestamp: 0, v: { patch: info.version } };
        this.index       = {
            url: 0, text_0: 0, text_1: 0, text_2: 0,
            text_3: 0, text_4: 0, bm: 0, sm: 0, bt_1: 0, bt_2: 0, cs: 0
        };
        this._firstPresence   = true;
        this._lastPresenceTs  = 0;
        this._sessionStart    = Date.now();
        this._rateLimitFails  = 0;
        // Session duration: 3–10 hours before a natural break
        this._maxSessionMs    = (this.rand(180, 600)) * 60 * 1000;
        // ── Rate-limit exponential backoff ──────────────────────────
        this._rlCooldownUntil = 0;   // timestamp when cooldown expires
        this._rlAttempts      = 0;   // consecutive hit counter
        this._rlBaseMs        = 15000; // base backoff 15 s
        this._lastCustomStatusRotation = 0;
        this._streamingTimer = null;
        this._customStatusTimer = null;
        this._spotifyTimer = null;
        this._lastCoreActivities = [];
        this._lastApplicationId = null;
        this._lastPresenceStatus = 'online';
        this._spotifyStartedAt = Date.now();
        this._lastCustomStatusKey = null;
        this._lastPresenceEcho = null;
        this._lastExpectedPresence = null;
        this._lastSpotifyTrackKey = null;
        this._lastSpotifyTrackIndex = null;
        this._warnedOnce = new Set();
        this._pendingCustomStatusRotated = false;
        this._pendingSpotifyRotation = false;

        // ── Listen for discord.js gateway rate-limit events ─────────
        this.on('rateLimit', (info) => {
            // info: { timeout, limit, method, path, route, global }
            this.handleRateLimit(info.timeout || 0);
        });

        this.on('presenceUpdate', (_, presence) => {
            if (presence?.userId === this.user?.id) this._lastPresenceEcho = presence;
        });
    }

    // ── Build cookie string ──────────────────────────────────────────
    buildCookieString() {
        return Object.entries(this._cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
    }

    // ── Build X-Super-Properties header ─────────────────────────────
    buildSuperProperties() {
        const sp = {
            os:                  'Windows',
            browser:             'Discord Client',
            release_channel:     'stable',
            client_version:      this._fp.client_version,
            os_version:          this._fp.os_version,
            os_arch:             'x64',
            app_arch:            'x64',
            system_locale:       'en-US',
            browser_user_agent:  this._UA,
            browser_version:     this._fp.electron,
            client_build_number: this._fp.client_build_number,
            native_build_number: this._fp.native_build_number,
            client_event_source: null,
            design_id:           0,
        };
        return Buffer.from(JSON.stringify(sp)).toString('base64');
    }

    // ── Build realistic Discord HTTP headers ─────────────────────────
    buildHeaders(extra = {}) {
        return {
            'Authorization':       this.TOKEN,
            'Content-Type':        'application/json',
            'User-Agent':          this._UA,
            'X-Super-Properties':  this.buildSuperProperties(),
            'X-Discord-Locale':    'en-US',
            'X-Discord-Timezone':  Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Bangkok',
            'X-Debug-Options':     'bugReporterEnabled',
            'Cookie':              this.buildCookieString(),
            'Accept':              '*/*',
            'Accept-Language':     'en-US,en;q=0.9',
            'Accept-Encoding':     'gzip, deflate, br',
            'Connection':          'keep-alive',
            'Sec-Fetch-Dest':      'empty',
            'Sec-Fetch-Mode':      'cors',
            'Sec-Fetch-Site':      'same-origin',
            'TE':                  'trailers',
            'Referer':             'https://discord.com/channels/@me',
            'Origin':              'https://discord.com',
            ...extra,
        };
    }

    // ── Human simulation helpers ────────────────────────────────────

    /**
     * Add random jitter to a delay value.
     * factor 0.25 = ±25% randomness around the base
     */
    jitter(ms, factor) {
        const f = factor ?? (this.config.config?.options?.humanJitter ?? 0.25);
        const variance = ms * f;
        return Math.max(5000, ms - variance + Math.random() * variance * 2);
    }

    /** Async sleep with optional jitter */
    humanSleep(ms, jitterFactor = 0) {
        const delay = jitterFactor > 0 ? this.jitter(ms, jitterFactor) : ms;
        return new Promise(r => setTimeout(r, delay));
    }

    /** Pick random int between min and max */
    rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

    // ── Streaming presence ──────────────────────────────────────────
    // ── Auto-detect Application ID from Developer Portal ───────────────
    async autoDetectAppId() {
        try {
            // Small pre-request jitter — real client doesn't hit API instantly
            await this.humanSleep(this.rand(800, 3200));
            const r = await fetch('https://discord.com/api/v10/applications?with_team_applications=true', {
                headers: this.buildHeaders({ 'Referer': 'https://discord.com/developers/applications' }),
                signal: AbortSignal.timeout(10000)
            });
            if (!r.ok) {
                if (r.status === 429) {
                    const retry = parseInt(r.headers.get('Retry-After') || '5', 10);
                    console.log(`[AppID] Rate limited - waiting ${retry}s`.yellow);
                    await this.humanSleep(retry * 1000 + this.rand(500, 2000));
                } else {
                    console.log(`[AppID] API returned ${r.status} - will use fallback`.yellow);
                }
                return null;
            }
            const apps = await r.json();
            if (Array.isArray(apps) && apps.length > 0) {
                const app = apps[0];
                console.log(`[AppID] Auto-detected: "${app.name}" (${app.id})`.cyan);
                return app.id;
            }
            console.log(`[AppID] No applications in Developer Portal - using fallback`.yellow);
        } catch (e) {
            console.log(`[AppID] Auto-detect error: ${e.message} - using fallback`.yellow);
        }
        return null;
    }

    // ── Rate-limit handler — exponential backoff ─────────────────────
    handleRateLimit(retryAfterMs = 0) {
        this._rlAttempts++;
        // Exponential backoff: 15s * 2^(attempts-1), capped at 5 minutes
        const backoff = Math.min(this._rlBaseMs * Math.pow(2, this._rlAttempts - 1), 300000);
        const waitMs  = Math.max(retryAfterMs, backoff);
        this._rlCooldownUntil = Date.now() + waitMs;
        const endTs = this._rlCooldownUntil;
        const mins  = (waitMs / 60000).toFixed(1);
        console.log(`[RL429:${this.maskToken(this.TOKEN)}:${endTs}:${this._rlAttempts}] Rate limited - backing off ${mins}min`.red);
    }

    // ── Clear rate-limit state after successful presence ──────────────
    clearRateLimit() {
        if (this._rlAttempts > 0) {
            console.log(`[RL429:${this.maskToken(this.TOKEN)}:0:0] Cooldown cleared`.green);
        }
        this._rlAttempts      = 0;
        this._rlCooldownUntil = 0;
    }

    spotifyId(seed, fallback) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const bytes = crypto.createHash('sha256').update(String(seed || fallback || 'spotify')).digest();
        let id = '';
        for (let i = 0; i < 22; i++) id += chars[bytes[i % bytes.length] % chars.length];
        return id;
    }

    async resolveSpotifyImage(spCfg, applicationId) {
        const raw = String(spCfg.albumArtId || spCfg.albumArtUrl || '').trim();
        if (!raw) return null;
        if (raw.startsWith('spotify:')) return raw;
        if (/^[a-zA-Z0-9]{20,80}$/.test(raw) && !this.getExternal.isValidURL(raw)) return `spotify:${raw}`;

        if (this.getExternal.isValidURL(raw)) {
            const url = new URL(raw);
            const spotifyImage = raw.match(/i\.scdn\.co\/image\/([a-zA-Z0-9]+)/i);
            if (spotifyImage?.[1]) return `spotify:${spotifyImage[1]}`;
            if (['cdn.discordapp.com', 'media.discordapp.net'].some(host => url.hostname.endsWith(host))) return raw;

            const images = await this.getExternal.get(raw, null, applicationId);
            return images.bigImage;
        }

        return null;
    }

    streamingStatus(opts = {}) {
        const raw = String(
            opts.status ||
            opts['presence-status'] ||
            opts.presenceStatus ||
            'online'
        ).toLowerCase();
        if (VALID_PRESENCE_STATUSES.has(raw)) return raw;
        this.warnOnce(
            `invalid-presence-status:${raw}`,
            `[Config] Invalid presence status "${raw || 'empty'}"; using online. Allowed: online, idle, dnd`.yellow,
        );
        return 'online';
    }

    activityMode(opts = {}) {
        const configured = String(opts['activity-type'] || opts.activityType || 'STREAMING').toUpperCase();
        if (configured && configured !== 'STREAMING') {
            this.warnOnce(
                `activity-mode:${configured}`,
                `[Config] Activity mode "${configured}" ignored; dashboard now uses normal STREAMING only`.yellow,
            );
        }
        return 'STREAMING';
    }

    activityType(activity) {
        if (typeof activity?.type === 'number') {
            return ['PLAYING', 'STREAMING', 'LISTENING', 'WATCHING', 'CUSTOM', 'COMPETING', 'HANG'][activity.type];
        }
        return activity?.type;
    }

    warnOnce(key, message, color = 'yellow') {
        if (this._warnedOnce.has(key)) return;
        this._warnedOnce.add(key);
        console.log(message[color] || message);
    }

    compactActivities(activities = []) {
        return activities.map(activity => ({
            name: activity.name,
            type: this.activityType(activity),
            url: activity.url || null,
            id: activity.id || null,
            details: activity.details || null,
            state: activity.state || null,
            emoji: activity.emoji || null,
            applicationId: activity.applicationId || activity.application_id || null,
        }));
    }

    selfPresenceCandidates() {
        const userId = this.user?.id;
        const candidates = [];
        const add = (source, presence) => {
            if (presence?.userId === userId || presence?.user?.id === userId) {
                candidates.push({ source, presence });
            }
        };

        add('client-cache', this.presences?.cache?.get(userId));
        for (const guild of this.guilds?.cache?.values?.() || []) {
            add(`guild:${guild.id}`, guild.presences?.cache?.get(userId));
        }
        return candidates;
    }

    waitForSelfPresenceEcho(timeoutMs = 9000, matcher = () => true) {
        const startedAt = Date.now();
        return new Promise(resolve => {
            let done = false;
            let lastCandidate = null;
            const finish = (value = null) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                clearInterval(poller);
                this.off('presenceUpdate', onPresence);
                resolve(value);
            };
            const onPresence = (_, presence) => {
                if (presence?.userId !== this.user?.id) return;
                lastCandidate = { source: 'gateway-event', presence };
                if (matcher(presence)) finish(lastCandidate);
            };
            const poll = () => {
                const candidate = this.selfPresenceCandidates()
                    .find(item => (item.presence?.lastModified || 0) >= startedAt - 1000);
                if (!candidate) return;
                lastCandidate = candidate;
                if (matcher(candidate.presence)) finish(candidate);
            };
            const timer = setTimeout(() => finish(lastCandidate), timeoutMs);
            const poller = setInterval(poll, 500);
            this.on('presenceUpdate', onPresence);
            poll();
        });
    }

    verifyPresenceState({ watchUrl, platform, activityType, activityName, expectSpotify, status }, presence = this.presence) {
        const activities = presence?.activities || [];
        const currentStatus = presence?.status || 'offline';
        const visibleStatus = ['online', 'idle', 'dnd'].includes(currentStatus);
        const expectedType = activityType || 'STREAMING';
        const targetActivity = activities.find(activity => {
            const typeMatches = this.activityType(activity) === expectedType;
            const urlMatches = !watchUrl || activity.url === watchUrl;
            const nameMatches = expectedType === 'STREAMING' || !activityName || activity.name === activityName;
            return typeMatches && urlMatches && nameMatches;
        });
        const hasActivity = !!targetActivity;
        const hasSpotify = !expectSpotify || activities.some(activity =>
            activity.id === 'spotify:1' ||
            (activity.name === 'Spotify' && this.activityType(activity) === 'LISTENING')
        );
        const statusMatches = !status || currentStatus === status;

        return {
            ok: visibleStatus && hasActivity && hasSpotify && statusMatches,
            currentStatus,
            visibleStatus,
            hasActivity,
            hasSpotify,
            statusMatches,
            activities: this.compactActivities(activities),
        };
    }

    logPresenceResult(expected, result, source) {
        const missing = [];
        if (!result.visibleStatus) missing.push(`visible status (${result.currentStatus})`);
        if (!result.statusMatches) missing.push(`expected status ${expected.status}`);
        if (!result.hasActivity) missing.push(`${expected.activityType || 'STREAMING'} activity`);
        if (!result.hasSpotify) missing.push('spotify activity');

        if (result.ok) {
            const name = expected.activityName || expected.platform || expected.activityType || 'activity';
            console.log(`[Verify] Activity confirmed (${expected.activityType || 'STREAMING'}: ${name}, ${result.currentStatus})`.green);
            if (expected.expectSpotify) console.log(`[Verify] Spotify confirmed`.green);
        } else {
            console.log(`[Verify] Presence mismatch (${source}): ${missing.join(', ') || 'unknown'} | activities=${JSON.stringify(result.activities)}`.yellow);
        }
    }

    async sendPresenceAndVerify({ status, activities, expected, reason = 'presence', timeoutMs = 9000 }) {
        const echoPromise = this.waitForSelfPresenceEcho(
            timeoutMs,
            presence => this.verifyPresenceState(expected, presence).ok,
        );
        this.user?.setPresence({ status, activities });
        this._lastPresenceTs = Date.now();

        const echoed = await echoPromise;
        const source = echoed?.source || 'local-cache';
        const presence = echoed?.presence || this.presence;
        const result = this.verifyPresenceState(expected, presence);
        result.source = source;
        result.external = !!echoed;

        if (!echoed) {
            this.warnOnce(
                'no-presence-echo',
                `[Verify] No gateway echo received; using local presence cache for diagnostics`.yellow,
            );
            result.externalMissing = true;
            if (result.ok && expected.requireGatewayEcho !== true) {
                console.log(`[Verify] Local cache matched; continuing without gateway echo`.gray);
            }
            if (expected.requireGatewayEcho === true) {
                result.ok = false;
            }
        }

        this.logPresenceResult(expected, result, source);
        if (result.ok) {
            this.clearRateLimit();
            if (this._pendingSpotifyRotation) {
                console.log(`[ROT:spotify]`);
                this._pendingSpotifyRotation = false;
            }
        } else {
            console.log(`[VERIFY:failed:${reason}]`.yellow);
        }

        this._lastPresenceStatus = status;
        this.emitPresenceSnapshot(reason, presence);
        return result;
    }

    scheduleStreaming(delayMs) {
        this.setManagedTimeout('_streamingTimer', async () => {
            try {
                await this.streaming();
            } catch (e) {
                console.log(`[Streaming] Cycle failed: ${e.message}`.red);
                if (e.stack) console.log(`[Streaming:stack] ${e.stack}`.red);
                this.scheduleStreaming(30000);
            }
        }, delayMs);
    }

    setManagedTimeout(key, callback, delayMs) {
        if (this[key]) {
            clearTimeout(this[key]);
            this.intervals.delete(this[key]);
        }
        const timer = setTimeout(async () => {
            this.intervals.delete(timer);
            this[key] = null;
            await callback();
        }, Math.max(1000, delayMs));
        this[key] = timer;
        this.intervals.add(timer);
        return timer;
    }

    clearManagedTimeout(key) {
        if (!this[key]) return;
        clearTimeout(this[key]);
        this.intervals.delete(this[key]);
        this[key] = null;
    }

    reloadConfigFromDisk() {
        const nextConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        this.config = nextConfig;
        this._warnedOnce.clear();
        return nextConfig;
    }

    normalizeRotationIndexes() {
        const cfg = this.config.config || {};
        const opts = cfg.options || {};
        const normalize = (key, list) => {
            const length = Array.isArray(list) ? list.length : 0;
            this.index[key] = length ? (this.index[key] || 0) % length : 0;
        };

        normalize('url', opts["watch-url"] || cfg["watch-url"]);
        normalize('text_1', cfg["text-1"]);
        normalize('text_2', cfg["text-2"]);
        normalize('text_3', cfg["text-3"]);
        normalize('text_4', cfg["text-4"]);
        normalize('bm', cfg.bigimg);
        normalize('sm', cfg.smallimg);
        normalize('cs', this.customStatusMessages(cfg.customStatus));
    }

    async refreshFromDashboard(reason = "dashboard") {
        this.reloadConfigFromDisk();
        this.normalizeRotationIndexes();
        this.clearManagedTimeout('_streamingTimer');
        this.clearManagedTimeout('_customStatusTimer');
        this.clearManagedTimeout('_spotifyTimer');
        this._lastCoreActivities = [];
        this._lastExpectedPresence = null;
        console.log(`[Dashboard] Refreshing presence from latest config (${reason})`.cyan);
        await this.streaming();
    }

    preflight({ applicationId, watchUrl, platform, config, spCfg, activityType, status, opts = {} }) {
        const streamMode = activityType === 'STREAMING';
        const customMessages = this.customStatusMessages(config.customStatus) || [];
        const customInterval = Number(config.customStatus?.intervalSec) || 0;
        const setupDelay = Number(this.config.setup?.delay) || MIN_STREAM_ROTATION_SEC;
        const checks = [
            {
                name: 'applicationId',
                ok: /^[0-9]{17,20}$/.test(String(applicationId || '')),
                reason: `expected 17-20 digit Discord application id, got "${applicationId || 'empty'}"`,
            },
            {
                name: 'presenceStatus',
                ok: VALID_PRESENCE_STATUSES.has(status),
                reason: `expected online/idle/dnd, got "${status || 'empty'}"`,
            },
            {
                name: 'streamUrl',
                ok: !streamMode || (!!watchUrl && this.getExternal.isValidURL(watchUrl)),
                reason: `STREAMING requires a valid Twitch/YouTube URL`,
            },
            {
                name: 'platform',
                ok: !streamMode || !!platform,
                reason: `Discord STREAMING accepts Twitch or YouTube only`,
            },
            {
                name: 'rotationDelay',
                ok: setupDelay >= MIN_STREAM_ROTATION_SEC && setupDelay <= MAX_ROTATION_SEC,
                reason: `stream rotation delay must be ${MIN_STREAM_ROTATION_SEC}-${MAX_ROTATION_SEC}s`,
            },
            {
                name: 'customStatus',
                ok: !config.customStatus?.enabled ||
                    (customMessages.length > 0 && (!customInterval || customInterval >= MIN_CUSTOM_STATUS_SEC)),
                reason: `custom status needs at least one message and interval >= ${MIN_CUSTOM_STATUS_SEC}s`,
            },
            {
                name: 'spotifyConfig',
                ok: !spCfg?.enabled || !!this.spotifyTracks(spCfg).length,
                reason: `Spotify is enabled but no usable tracks were configured`,
            },
        ];
        const failed = checks.filter(check => !check.ok);
        if (failed.length) {
            console.log(`[Preflight] Failed: ${failed.map(check => `${check.name}(${check.reason})`).join('; ')}`.yellow);
        } else {
            const customInfo = config.customStatus?.enabled
                ? `${customMessages.length}/${Math.max(customInterval || MIN_CUSTOM_STATUS_SEC, MIN_CUSTOM_STATUS_SEC)}s`
                : 'off';
            const gatewayEcho = opts.requireGatewayEcho === true ? 'required' : 'soft';
            console.log(`[Preflight] OK - app=${applicationId} type=${activityType} status=${status} platform=${platform || 'n/a'} customStatus=${customInfo} spotify=${spCfg?.enabled && this.spotifyTracks(spCfg).length ? 'on' : 'off'} gatewayEcho=${gatewayEcho}`.gray);
        }
        return !failed.length;
    }

    safeText(label, text) {
        try {
            return this.SPT(text);
        } catch (e) {
            console.log(`[Step:${label}] Template failed - using raw text: ${e.message}`.yellow);
            return String(text || '').replace(/\{[^}]{1,80}\}/g, '').trim();
        }
    }

    safeApply(label, callback) {
        try {
            callback();
            return true;
        } catch (e) {
            console.log(`[Step:${label}] Skipped: ${e.message}`.yellow);
            return false;
        }
    }

    spotifyTracks(spCfg = {}) {
        const rawTracks = Array.isArray(spCfg.tracks) && spCfg.tracks.length
            ? spCfg.tracks
            : [{
                song: spCfg.song,
                artist: spCfg.artist,
                duration: spCfg.duration,
                albumArtUrl: spCfg.albumArtUrl,
                albumArtId: spCfg.albumArtId,
                songId: spCfg.songId,
                albumId: spCfg.albumId,
                artistIds: spCfg.artistIds,
            }];

        return rawTracks.map(track => ({
            song: String(track?.song || '').trim(),
            artist: String(track?.artist || '').trim(),
            duration: Math.max(Number(track?.duration) || 210, 10),
            albumArtUrl: String(track?.albumArtUrl || '').trim(),
            albumArtId: String(track?.albumArtId || '').trim(),
            songId: String(track?.songId || '').trim(),
            albumId: String(track?.albumId || '').trim(),
            artistIds: track?.artistIds || '',
        })).filter(track => track.song || track.artist);
    }

    activeSpotifyTrack(spCfg = {}) {
        const tracks = this.spotifyTracks(spCfg);
        if (!spCfg?.enabled || !tracks.length) return null;

        const durations = tracks.map(track => track.duration * 1000);
        const totalMs = durations.reduce((sum, value) => sum + value, 0);
        if (!totalMs) return null;

        const now = Date.now();
        const elapsed = Math.max(0, now - this._spotifyStartedAt);
        const cycleElapsed = elapsed % totalMs;
        const cycleStart = now - cycleElapsed;
        let cursor = 0;

        for (let i = 0; i < tracks.length; i++) {
            const next = cursor + durations[i];
            if (cycleElapsed < next || i === tracks.length - 1) {
                return {
                    track: tracks[i],
                    index: i,
                    total: tracks.length,
                    startTs: cycleStart + cursor,
                    endTs: cycleStart + next,
                    nextInMs: Math.max(1000, cycleStart + next - now),
                };
            }
            cursor = next;
        }

        return null;
    }

    // ── Build SpotifyRPC activity ─────────────────────────────────────
    async buildSpotify(spCfg, applicationId) {
        try {
            const active = this.activeSpotifyTrack(spCfg);
            if (!active) return null;

            const { track, startTs, endTs, index, total } = active;
            const artistText = track.artist || 'Unknown Artist';
            const trackKey = `${index}:${track.song || ''}:${artistText}:${track.albumArtUrl || track.albumArtId || ''}`;
            const artistIds = Array.isArray(track.artistIds)
                ? track.artistIds
                : String(track.artistIds || '')
                    .split(',')
                    .map(x => x.trim())
                    .filter(Boolean);
            const finalArtistIds = artistIds.length
                ? artistIds
                : artistText.split(/\s*(?:,|&|\/|\+)\s*/).filter(Boolean).map(name => this.spotifyId(name, 'artist'));

            const rpc = new SpotifyRPC(this)
                .setDetails(track.song   || 'Unknown Song')
                .setState(artistText)
                .setAssetsLargeText('Spotify')
                .setAssetsSmallText('Spotify')
                .setStartTimestamp(startTs)
                .setEndTimestamp(endTs)
                .setSongId(track.songId || this.spotifyId(`${track.song}:${artistText}`, 'track'))
                .setAlbumId(track.albumId || this.spotifyId(`${track.song}:${artistText}`, 'album'))
                .setArtistIds(finalArtistIds);

            const image = await this.resolveSpotifyImage(track, applicationId);
            if (image) rpc.setAssetsLargeImage(image);

            if (trackKey !== this._lastSpotifyTrackKey) {
                if (this._lastSpotifyTrackKey !== null && total > 1) this._pendingSpotifyRotation = true;
                this._lastSpotifyTrackKey = trackKey;
                this._lastSpotifyTrackIndex = index;
                console.log(`[Spotify] Track ${index + 1}/${total} - "${track.song || 'Unknown Song'}" by ${artistText}`.cyan);
            }
            return rpc;
        } catch (e) {
            console.log(`[Spotify] Failed to build SpotifyRPC: ${e.message}`.yellow);
            return null;
        }
    }

    getStreamingPlatform(url) {
        if (!this.getExternal.isValidURL(url)) return null;
        const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
        if (host === 'twitch.tv' || host.endsWith('.twitch.tv')) return 'Twitch';
        if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return 'YouTube';
        return null;
    }

    normalizeStreamingUrl(url) {
        if (!this.getExternal.isValidURL(url)) return null;
        const parsed = new URL(url);
        const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
        parsed.protocol = 'https:';
        parsed.hash = '';

        if (host === 'twitch.tv' || host.endsWith('.twitch.tv')) {
            return `https://twitch.tv${parsed.pathname}${parsed.search}`;
        }

        if (host === 'youtu.be') {
            const videoId = parsed.pathname.split('/').filter(Boolean)[0];
            return videoId ? `https://youtube.com/watch?v=${encodeURIComponent(videoId)}` : null;
        }

        if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
            return `https://youtube.com${parsed.pathname}${parsed.search}`;
        }

        return null;
    }

    customStatusMessages(customStatus) {
        if (!customStatus?.enabled) return null;
        const legacy = (customStatus.text || customStatus.emoji)
            ? [{ text: customStatus.text || '', emoji: customStatus.emoji || '' }]
            : [];
        const messages = Array.isArray(customStatus.messages) && customStatus.messages.length
            ? customStatus.messages
            : legacy;
        const valid = messages
            .map(item => typeof item === 'string'
                ? { text: item, emoji: '' }
                : { text: item?.text || '', emoji: item?.emoji || '' })
            .filter(item => item.text || item.emoji);
        return valid;
    }

    customStatusIntervalMs(customStatus) {
        const rawSec = Number(customStatus?.intervalSec) || 300;
        const boundedSec = Math.min(Math.max(rawSec, MIN_CUSTOM_STATUS_SEC), MAX_ROTATION_SEC);
        if (rawSec < MIN_CUSTOM_STATUS_SEC) {
            this.warnOnce(
                `custom-status-interval:${rawSec}`,
                `[CustomStatus] intervalSec=${rawSec} is too low; using ${MIN_CUSTOM_STATUS_SEC}s minimum`.yellow,
            );
        }
        return boundedSec * 1000;
    }

    currentCustomStatus(customStatus, { advance = false, rotateByTime = true } = {}) {
        const valid = this.customStatusMessages(customStatus);
        if (!valid?.length) return null;

        const intervalMs = this.customStatusIntervalMs(customStatus);
        if (!this._lastCustomStatusRotation) this._lastCustomStatusRotation = Date.now();
        if ((advance || (rotateByTime && Date.now() - this._lastCustomStatusRotation >= intervalMs)) && valid.length > 1) {
            this.index.cs = (this.index.cs + 1) % valid.length;
            this._lastCustomStatusRotation = Date.now();
            this._pendingCustomStatusRotated = true;
        }
        return valid[this.index.cs % valid.length];
    }

    resolveCustomStatusEmoji(emoji) {
        const raw = String(emoji || '').trim();
        if (!raw) return null;
        const custom = raw.match(/^<(?:(a):)?([^:]{2,32}):(\d{17,20})>$/);
        if (custom) {
            return { animated: !!custom[1], name: custom[2], id: custom[3] };
        }
        if (/^\d{17,20}$/.test(raw)) return { id: raw };
        return raw;
    }

    customStatusEmojiAllowed(emoji) {
        if (!emoji || typeof emoji === 'string') return true;
        if (!emoji.id) return true;
        return Number(this.user?.premiumType || 0) > 0;
    }

    customStatusKey(row, emoji) {
        return JSON.stringify({
            text: row?.text || '',
            emoji: typeof emoji === 'string' ? emoji : (emoji?.id || emoji?.name || ''),
        });
    }

    describeCustomStatusEmoji(emoji) {
        if (!emoji) return 'none';
        if (typeof emoji === 'string') return emoji;
        return emoji.id
            ? `${emoji.name || 'unknown'}:${emoji.id}${emoji.animated ? ':animated' : ''}`
            : (emoji.name || 'unknown');
    }

    customStatusApplyReason(activity, applied = {}, textOk, emojiOk) {
        if (!textOk) return `Discord returned text="${applied.text || ''}"`;
        if (emojiOk) return 'ok';
        const expected = activity.emoji;
        if (!expected) return 'ok';
        if (expected.id && Number(this.user?.premiumType || 0) <= 0) {
            return 'custom server emojis in custom status require Nitro or Nitro Basic';
        }
        if (expected.id && !applied.emoji_id) {
            return 'Discord rejected the custom emoji; check Nitro and that this account can use that server emoji';
        }
        if (expected.id && applied.emoji_id !== expected.id) {
            return `Discord returned emoji_id=${applied.emoji_id || 'none'}`;
        }
        if (!expected.id && applied.emoji_name !== expected.name) {
            return `Discord returned emoji_name=${applied.emoji_name || 'none'}`;
        }
        return 'unknown custom status mismatch';
    }

    buildCustomStatusActivity(customStatus, options = {}) {
        const row = this.currentCustomStatus(customStatus, options);
        if (!row) return null;

        try {
            const cs = new CustomStatus(this, { name: 'Custom Status' });
            if (row.text) cs.setState(this.safeText('customStatus', row.text));
            const emoji = this.resolveCustomStatusEmoji(row.emoji);
            if (emoji && this.customStatusEmojiAllowed(emoji)) {
                cs.setEmoji(emoji);
            } else if (emoji?.id) {
                this.warnOnce(
                    `custom-emoji-no-nitro:${emoji.id}`,
                    `[CustomStatus] Emoji "${emoji.name || emoji.id}" skipped: custom server emojis require Nitro or Nitro Basic`.yellow,
                );
            }
            return cs;
        } catch (e) {
            console.log(`[CustomStatus] Skipped: ${e.message}`.yellow);
            return null;
        }
    }

    async applyAccountCustomStatus(customStatus, options = {}) {
        const activity = this.buildCustomStatusActivity(customStatus, options);
        if (!activity) {
            if (customStatus && customStatus.enabled === false && this._lastCustomStatusKey !== '') {
                try {
                    if (this.settings?.setCustomStatus) await this.settings.setCustomStatus();
                    this._lastCustomStatusKey = '';
                } catch (e) {
                    console.log(`[CustomStatus] Clear failed: ${e.message}`.yellow);
                }
            }
            return null;
        }

        try {
            const key = JSON.stringify({ state: activity.state || '', emoji: activity.emoji || null });
            if (this.settings?.setCustomStatus && key !== this._lastCustomStatusKey) {
                await this.settings.setCustomStatus(activity);
                const applied = this.settings?.customStatus || {};
                const textOk = (applied.text || '') === (activity.state || '');
                const emojiOk = !activity.emoji ||
                    (activity.emoji.id ? applied.emoji_id === activity.emoji.id : applied.emoji_name === activity.emoji.name);
                if (!textOk || !emojiOk) {
                    const reason = this.customStatusApplyReason(activity, applied, textOk, emojiOk);
                    console.log(`[CustomStatus] Apply check failed: text=${textOk ? 'ok' : 'mismatch'} emoji=${emojiOk ? 'ok' : 'mismatch'} expectedEmoji=${this.describeCustomStatusEmoji(activity.emoji)} appliedEmoji=${applied.emoji_id || applied.emoji_name || 'none'} reason=${reason}`.yellow);
                } else {
                    console.log(`[CustomStatus] Applied: ${activity.state || '(emoji only)'} emoji=${this.describeCustomStatusEmoji(activity.emoji)}`.gray);
                }
                this._lastCustomStatusKey = key;
            }
            if (this._pendingCustomStatusRotated) {
                console.log(`[ROT:customStatus]`);
                this._pendingCustomStatusRotated = false;
            }
            return activity;
        } catch (e) {
            console.log(`[CustomStatus] Settings apply failed: ${e.message}`.yellow);
            return activity;
        }
    }

    scheduleCustomStatusTick(customStatus) {
        this.clearManagedTimeout('_customStatusTimer');
        const messages = this.customStatusMessages(customStatus);
        if (!messages?.length || messages.length < 2 || !this._lastCoreActivities.length) return;

        const intervalMs = this.customStatusIntervalMs(customStatus);
        const elapsed = this._lastCustomStatusRotation ? Date.now() - this._lastCustomStatusRotation : 0;
        const waitMs = Math.max(5000, intervalMs - elapsed);
        console.log(`[CustomStatus] Next rotation in ${Math.round(waitMs / 1000)}s`.gray);

        this.setManagedTimeout('_customStatusTimer', async () => {
            try {
                await this.refreshLivePresence('customStatus', { advanceCustom: true });
            } catch (e) {
                console.log(`[CustomStatus] Refresh failed: ${e.message}`.yellow);
            }
        }, waitMs);
    }

    scheduleSpotifyTick(spCfg) {
        this.clearManagedTimeout('_spotifyTimer');
        const active = this.activeSpotifyTrack(spCfg);
        if (!active || !this._lastCoreActivities.length) return;
        console.log(`[Spotify] Next rotation/progress refresh in ${Math.round(active.nextInMs / 1000)}s`.gray);

        this.setManagedTimeout('_spotifyTimer', async () => {
            try {
                await this.refreshLivePresence('spotify');
            } catch (e) {
                console.log(`[Spotify] Refresh failed: ${e.message}`.yellow);
            }
        }, active.nextInMs + 750);
    }

    async refreshLivePresence(reason, { advanceCustom = false } = {}) {
        const config = this.config.config || {};
        const opts = config.options || {};
        if (!this._lastCoreActivities.length) return;

        const activities = [];
        const customActivity = await this.applyAccountCustomStatus(config.customStatus, {
            advance: advanceCustom,
            rotateByTime: !advanceCustom,
        });
        if (customActivity) activities.push(customActivity);

        activities.push(...this._lastCoreActivities);

        const spotifyActivity = await this.buildSpotify(config.spotify, this._lastApplicationId || '1109522937989562409');
        if (spotifyActivity) activities.push(spotifyActivity);

        const status = this.streamingStatus(opts);
        const expected = {
            ...(this._lastExpectedPresence || {}),
            expectSpotify: !!(config.spotify?.enabled && this.spotifyTracks(config.spotify).length),
            status,
        };
        const result = await this.sendPresenceAndVerify({
            status,
            activities,
            expected,
            reason,
            timeoutMs: 8000,
        });
        if (!result.ok) {
            console.log(`[Presence] Refresh "${reason}" was not confirmed; retrying full streaming cycle in 30s`.yellow);
            this.scheduleStreaming(30000);
            return;
        }
        this.scheduleCustomStatusTick(config.customStatus);
        this.scheduleSpotifyTick(config.spotify);
    }

    emitPresenceSnapshot(reason = 'presence', presence = this.presence) {
        try {
            const snapshot = {
                reason,
                status: presence?.status || this._lastPresenceStatus || 'online',
                updatedAt: new Date().toISOString(),
                activities: (presence?.activities || []).map(activity => ({
                    name: activity.name || '',
                    type: this.activityType(activity),
                    url: activity.url || null,
                    details: activity.details || '',
                    state: activity.state || '',
                    emoji: activity.emoji || null,
                    timestamps: activity.timestamps || null,
                    applicationId: activity.applicationId || null,
                    assets: {
                        largeImage: activity.assets?.largeImage || null,
                        smallImage: activity.assets?.smallImage || null,
                        largeText: activity.assets?.largeText || '',
                        smallText: activity.assets?.smallText || '',
                        largeImageUrl: activity.assets?.largeImageURL?.({ size: 256 }) || null,
                        smallImageUrl: activity.assets?.smallImageURL?.({ size: 128 }) || null,
                    },
                })),
            };
            const encoded = Buffer.from(JSON.stringify(snapshot), 'utf8').toString('base64');
            console.log(`[PRESENCE:${encoded}]`);
        } catch (e) {
            console.log(`[PresenceSnapshot] Failed: ${e.message}`.yellow);
        }
    }

    async streaming() {
        const { setup, config } = this.config;
        const opts = config.options || {};

        const humanMode = opts.humanMode !== false; // default ON

        // ── Rate-limit cooldown check ────────────────────────────────
        if (Date.now() < this._rlCooldownUntil) {
            const remaining = this._rlCooldownUntil - Date.now();
            const mins = (remaining / 60000).toFixed(1);
            console.log(`[RL429-WAIT] ${mins}min remaining - skipping presence cycle`.yellow);
            this.scheduleStreaming(Math.min(remaining + 2000, 60000));
            return;
        }

        // ── Resolve Application ID ──────────────────────────────────────
        // Priority: config → auto-detect from Developer Portal → hardcoded fallback
        let applicationId = opts.botid?.trim();
        if (!applicationId) {
            if (!this._detectedAppId) {
                this._detectedAppId = await this.autoDetectAppId();
            }
            applicationId = this._detectedAppId || '1109522937989562409';
        }

        // ── Safe minimum delay ──────────────────────────────────────
        // Discord clients are rate-limited, so dashboard rotations never run below 5 minutes.
        const configuredDelay = Math.min(
            Math.max((setup?.delay || MIN_STREAM_ROTATION_SEC) * 1000, MIN_STREAM_ROTATION_SEC * 1000),
            MAX_ROTATION_SEC * 1000,
        );
        const nextStatus = this.streamingStatus(opts);

        // ── Resolve streaming URL ──────────────────────────────────
        // STREAMING keeps the purple stream badge and Discord's built-in Watch URL.
        const activityType = this.activityMode(opts);
        const urlList = opts["watch-url"] || config["watch-url"] || [];
        const rawWatchUrl = urlList[this.index.url];
        let watchUrl = activityType === 'STREAMING' ? this.normalizeStreamingUrl(rawWatchUrl) : null;

        if (activityType === 'STREAMING' && (!watchUrl || !this.getExternal.isValidURL(watchUrl))) {
            console.log(`[!] No valid streaming URL - retry in 30s`);
            this.scheduleStreaming(30000);
            return;
        }
        if (watchUrl && rawWatchUrl !== watchUrl) {
            console.log(`[Streaming] Normalized watch URL: ${watchUrl}`.gray);
        }

        // ── Platform detection ──────────────────────────────────────
        const platform = watchUrl ? this.getStreamingPlatform(watchUrl) : null;
        if (activityType === 'STREAMING' && !platform) {
            console.log(`[!] Discord STREAMING only supports Twitch/YouTube URLs - retry in 30s`.yellow);
            this.scheduleStreaming(30000);
            return;
        }
        const spCfg = config.spotify;
        if (!this.preflight({ applicationId, watchUrl, platform, config, spCfg, activityType, status: nextStatus, opts })) {
            this.scheduleStreaming(30000);
            return;
        }

        // ── Build RichPresence ──────────────────────────────────────
        const text1 = config["text-1"]?.[this.index.text_1] ?? null;
        const detailText = text1 ? this.safeText('details', text1) : '';
        const rawActivityName = opts['activity-name'] || opts.activityName || detailText || 'Live';
        const activityName = this.safeText('activityName', rawActivityName).slice(0, 128).trim() || 'Live';

        const text2 = config["text-2"]?.[this.index.text_2] ?? null;
        const stateText = text2 ? this.safeText('state', text2) : '';

        const text3 = config["text-3"]?.[this.index.text_3] ?? null;
        const largeText = text3 ? this.safeText('largeText', text3) : '';

        let smallText = '';
        if (config["text-4"]?.length) {
            const text4 = config["text-4"][this.index.text_4];
            if (text4) smallText = this.safeText('smallText', text4);
        }

        // Images
        let resolvedImages = { bigImage: null, smallImage: null };
        if (config.bigimg?.length || config.smallimg?.length) {
            const bigImg  = config.bigimg?.[this.index.bm];
            const smallImg = config.smallimg?.[this.index.sm];
            resolvedImages = await this.getImage(bigImg, smallImg, applicationId);
        }

        const applySharedFields = (presence) => {
            if (detailText || presence.type === 'STREAMING' || presence.type === 1) {
                this.safeApply('details', () => presence.setDetails(detailText || activityName));
            }
            if (stateText) this.safeApply('state', () => presence.setState(stateText));
            if (largeText) this.safeApply('largeText', () => presence.setAssetsLargeText(largeText));
            if (smallText) this.safeApply('smallText', () => presence.setAssetsSmallText(smallText));
            if (resolvedImages.bigImage) presence.setAssetsLargeImage(resolvedImages.bigImage);
            if (resolvedImages.smallImage) presence.setAssetsSmallImage(resolvedImages.smallImage);
            return presence;
        };

        const streamingPresence = applySharedFields(new RichPresence(this)
            .setApplicationId(applicationId)
            .setType(activityType)
            .setName(activityName));

        if (activityType === 'STREAMING') streamingPresence.setURL(watchUrl);

        // Discord's member-list status can be forced to use Details instead of Name.
        streamingPresence.status_display_type = 2;

        const coreActivities = [streamingPresence];

        // ── Build activities array ──────────────────────────────────
        const activities = [];

        // Custom Status alongside streaming (if enabled)
        const customStatusActivity = await this.applyAccountCustomStatus(config.customStatus);
        if (customStatusActivity) activities.push(customStatusActivity);

        activities.push(...coreActivities);
        this._lastCoreActivities = coreActivities;
        this._lastApplicationId = applicationId;

        // ── Add Spotify activity (runs alongside streaming) ─────────
        if (spCfg?.enabled && this.spotifyTracks(spCfg).length) {
            const spotifyActivity = await this.buildSpotify(spCfg, applicationId);
            if (spotifyActivity) {
                activities.push(spotifyActivity);
            }
        }

        // ── Push presence ───────────────────────────────────────────
        try {
            const expectedPresence = {
                watchUrl,
                platform,
                activityType,
                activityName,
                expectSpotify: !!(spCfg?.enabled && this.spotifyTracks(spCfg).length),
                status: nextStatus,
                requireGatewayEcho: opts.requireGatewayEcho === true,
            };
            this._lastExpectedPresence = expectedPresence;

            let verifyResult = await this.sendPresenceAndVerify({
                status: nextStatus,
                activities,
                expected: expectedPresence,
                reason: 'streaming',
                timeoutMs: 9000,
            });

            if (!verifyResult.ok) {
                console.log(`[Verify] Re-sending presence once`.yellow);
                await this.humanSleep(3000);
                verifyResult = await this.sendPresenceAndVerify({
                    status: nextStatus,
                    activities,
                    expected: expectedPresence,
                    reason: 'streaming-retry',
                    timeoutMs: 9000,
                });
            }

            if (!verifyResult.ok) {
                console.log(`[Verify] Failed - streaming/status was not confirmed; retrying in 30s`.red);
                this.scheduleStreaming(30000);
                return;
            }

            this.scheduleCustomStatusTick(config.customStatus);
            this.scheduleSpotifyTick(spCfg);
        } catch (presenceErr) {
            // Gateway errors (including 429 rejection) land here
            const msg = presenceErr?.message || '';
            if (msg.includes('429') || msg.toLowerCase().includes('rate limit')) {
                const retryAfter = parseInt(presenceErr?.retryAfter || '0') * 1000;
                this.handleRateLimit(retryAfter);
            } else {
                console.log(`[Presence] Error: ${msg}`.red);
            }
            this.scheduleStreaming(30000);
            return;
        }

        this.lib.count++;
        this.lib.countParty++;

        // ── Advance rotation indices ────────────────────────────────
        const adv = (cur, arr) => (arr?.length ? (cur + 1) % arr.length : 0);
        const rotate = (key, arr, metric) => {
            const old = this.index[key] || 0;
            const next = adv(old, arr);
            this.index[key] = next;
            if (arr?.length > 1 && next !== old && metric) console.log(`[ROT:${metric}]`);
        };

        rotate('url', urlList, 'url');
        rotate('text_0', config["text-1"]);
        rotate('text_1', config["text-1"], 'text1');
        rotate('text_2', config["text-2"], 'text2');
        rotate('text_3', config["text-3"], 'text3');
        rotate('text_4', config["text-4"], 'text4');

        const oldBm = this.index.bm || 0;
        const oldSm = this.index.sm || 0;
        this.index.bm = adv(oldBm, config.bigimg);
        this.index.sm = adv(oldSm, config.smallimg);
        if ((config.bigimg?.length > 1 && this.index.bm !== oldBm) ||
            (config.smallimg?.length > 1 && this.index.sm !== oldSm)) {
            console.log(`[ROT:images]`);
        }

        // ── Schedule next cycle ─────────────────────────────────────
        const nextDelay = Math.max(
            MIN_STREAM_ROTATION_SEC * 1000,
            humanMode ? this.jitter(configuredDelay) : configuredDelay,
        );

        if (humanMode) {
            const rng = Math.random();
            const sessionAge = Date.now() - this._sessionStart;

            // ── Session break: after max session duration, stay visible but idle ──
            // Streaming presence should not be paired with invisible status.
            if (sessionAge > this._maxSessionMs) {
                const breakMin = this.rand(8, 30);
                console.log(`[Human] Session pacing pause ${breakMin}min`.gray);
                this.setManagedTimeout('_streamingTimer', async () => {
                    try {
                        await this.humanSleep(breakMin * 60 * 1000, 0.2);
                        await this.humanSleep(this.rand(5000, 15000));
                        // Reset session clock and max duration
                        this._sessionStart   = Date.now();
                        this._maxSessionMs   = this.rand(180, 600) * 60 * 1000;
                    } catch {}
                    this.streaming().catch(e => {
                        console.log(`[Streaming] Resume failed: ${e.message}`.red);
                        this.scheduleStreaming(30000);
                    });
                }, this.rand(1000, 4000));
                return;
            }

            // ── Long idle (AFK) — 5% chance — 3–8 min ─────────────
            if (rng < 0.05) {
                const idleSec = this.rand(
                    opts.idleMinSec ?? 180,
                    opts.idleMaxSec ?? 480
                );
                console.log(`[Human] Quiet pause ${(idleSec/60).toFixed(1)}min`.gray);
                this.setManagedTimeout('_streamingTimer', async () => {
                    try {
                        await this.humanSleep(this.rand(1500, 5000));
                        await this.humanSleep(idleSec * 1000, 0.18);
                        await this.humanSleep(this.rand(2000, 7000));
                    } catch {}
                    this.streaming().catch(e => {
                        console.log(`[Streaming] Resume failed: ${e.message}`.red);
                        this.scheduleStreaming(30000);
                    });
                }, this.rand(1000, 4000));
                return;
            }

            // ── Micro-pause — 8% chance — 15–50 s ─────────────────
            // Simulates a human briefly tabbing out / checking phone
            if (rng < 0.13) {
                const pauseSec = this.rand(15, 50);
                console.log(`[Human] Micro-pause ${pauseSec}s`.gray);
                this.setManagedTimeout('_streamingTimer', async () => {
                    try {
                        await this.humanSleep(pauseSec * 1000, 0.12);
                    } catch {}
                    this.streaming().catch(e => {
                        console.log(`[Streaming] Resume failed: ${e.message}`.red);
                        this.scheduleStreaming(30000);
                    });
                }, this.rand(500, 2000));
                return;
            }

            // ── DND burst — 2% chance — simulate do-not-disturb ────
            if (rng < 0.15) {
                const dndSec = this.rand(120, 600);
                console.log(`[Human] Focus pause ${(dndSec/60).toFixed(1)}min`.gray);
                this.setManagedTimeout('_streamingTimer', async () => {
                    try {
                        await this.humanSleep(dndSec * 1000, 0.15);
                        await this.humanSleep(this.rand(3000, 9000));
                    } catch {}
                    this.streaming().catch(e => {
                        console.log(`[Streaming] Resume failed: ${e.message}`.red);
                        this.scheduleStreaming(30000);
                    });
                }, this.rand(2000, 5000));
                return;
            }
        }

        this.scheduleStreaming(nextDelay);
    }

    startInterval(callback, interval) {
        const id = setInterval(callback, interval);
        this.intervals.add(id);
        return id;
    }

    stopAllIntervals() {
        for (let id of this.intervals) clearInterval(id);
        this.intervals.clear();
    }

    maskToken(token) {
        const parts = token.split('.');
        if (parts.length < 2) return token;
        return `${parts[0]}.##########`;
    }

    async getImage(bigImg, smallImg, applicationId) {
        const [bigImage, smallImage] = await Promise.all([
            this.safeText('largeImage', bigImg),
            this.safeText('smallImage', smallImg),
        ]);
        const images = await this.getExternal.get(bigImage, smallImage, applicationId);
        const finalBigImage = images.bigImage ?? this.cacheImage.get(bigImg);
        const finalSmallImage = images.smallImage ?? this.cacheImage.get(smallImg);

        if (images.bigImage) this.cacheImage.set(bigImg, images.bigImage);
        if (images.smallImage) this.cacheImage.set(smallImg, images.smallImage);

        return { bigImage: finalBigImage, smallImage: finalSmallImage };
    }

    SPT(text) {
        if (!text) return text || null;
    
        const { weather, sys, emoji, textFont, lib } = this;
        const zone = weather.timezone && moment.tz.zone(weather.timezone)
            ? weather.timezone
            : (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
        const currentMoment = moment().locale('th').tz(zone);
        const safeValue = (fn, fallback = '') => {
            try {
                const value = fn();
                return value ?? fallback;
            } catch {
                return fallback;
            }
        };
    
        const variables = {
            // Time
            'hour:1': currentMoment.format('HH'),
            'hour:2': currentMoment.format('hh'),
            'min:1': currentMoment.format('mm'),
            'min:2': currentMoment.format('mm A'),
    
            // Thai Date
            'th=date': currentMoment.format('D'),
            'th=week:1': currentMoment.format('ddd'),
            'th=week:2': currentMoment.format('dddd'),
            'th=month:1': currentMoment.format('M'),
            'th=month:2': currentMoment.format('MMM'),
            'th=month:3': currentMoment.format('MMMM'),
            'th=year:1': (parseInt(currentMoment.format('YYYY')) + 543).toString().slice(-2),
            'th=year:2': (parseInt(currentMoment.format('YYYY')) + 543).toString(),
    
            // English Date
            'en=date': currentMoment.locale('en').format('Do'),
            'en=week:1': currentMoment.locale('en').format('ddd'),
            'en=week:2': currentMoment.locale('en').format('dddd'),
            'en=month:1': currentMoment.locale('en').format('M'),
            'en=month:2': currentMoment.locale('en').format('MMM'),
            'en=month:3': currentMoment.locale('en').format('MMMM'),
            'en=year:1': currentMoment.locale('en').format('YY'),
            'en=year:2': currentMoment.locale('en').format('YYYY'),
    
            // Weather
            'city': weather.city,
            'region': weather.region,
            'country': weather.country,
            'temp:c': weather.temp_c,
            'temp:f': weather.temp_f,
            'wind:kph': weather.wind_kph,
            'wind:mph': weather.wind_mph,
            'wind:degree': weather.wind_degree,
            'wind:dir': weather.wind_dir,
            'pressure:mb': weather.pressure_mb,
            'pressure:in': weather.pressure_in,
            'precip:mm': weather.precip_mm,
            'precip:in': weather.precip_in,
            'gust:kph': weather.gust_kph,
            'gust:mph': weather.gust_mph,
            'feelslike:c': weather.feelslike_c,
            'feelslike:f': weather.feelslike_f,
            'windchill:c': weather.windchill_c,
            'windchill:f': weather.windchill_f,
            'heatindex:c': weather.heatindex_c,
            'heatindex:f': weather.heatindex_f,
            'dewpoint:c': weather.dewpoint_c,
            'dewpoint:f': weather.dewpoint_f,
            'vis:km': weather.vis_km,
            'vis:mi': weather.vis_miles,
            'humidity': weather.humidity,
            'cloud': weather.cloud,
            'uv': weather.uv,
            'co': weather.co,
            'no2': weather.no2,
            'o3': weather.o3,
            'so2': weather.so2,
            'pm2.5': weather.pm2_5,
            'pm10': weather.pm10,
    
            // System
            'ping': Math.round(this.ws.ping),
            'patch': lib.v.patch,
            'cpu:name': sys.cpuname,
            'cpu:cores': sys.cpucores,
            'cpu:speed': sys.cpuspeed,
            'cpu:usage': sys.cpu,
            'ram:usage': sys.ram,
            'uptime:days': Math.trunc(this.uptime / 86400000),
            'uptime:hours': Math.trunc(this.uptime / 3600000 % 24),
            'uptime:minutes': Math.trunc(this.uptime / 60000 % 60),
            'uptime:seconds': Math.trunc(this.uptime / 1000 % 60),
    
            // User
            'user:name': this.user?.username,
            'user:icon': safeValue(() => this.user?.displayAvatarURL({ format: 'png', size: 256 })),
            'user:banner': safeValue(() => this.user?.bannerURL({ format: 'png', size: 512 })),
            'guild=members': (guildId) => this.guilds.cache.get(guildId)?.memberCount,
            'guild=name': (guildId) => this.guilds.cache.get(guildId)?.name,
            'guild=icon': (guildId) => this.guilds.cache.get(guildId)?.iconURL(),
    
            'emoji:random': () => emoji.random(),
            'emoji:time': emoji.getTime(currentMoment.format('HH')),
            'emoji:clock': () => emoji.getClock(currentMoment.format('HH')),
    
            'random': (text) => {
                const options = text.split(',').map(t => t.trim());
                return options[Math.floor(Math.random() * options.length)];
            }
        };

        const processFont = (fontNum, content) => {
            const processedContent = content.replace(/\{([^{}]+)\}/g, (_, key) => variables[key] || key);
            return textFont[`getFont${fontNum}`]?.(processedContent) || processedContent;
        };

        const processText = (input) => {
            return input.replace(/\{NF(\d)\((.*?)\)\}/g, (_, num, content) => {
                return processFont(num, content);
            }).replace(/\{([^{}]+)\}/g, (_, key) => variables[key] || key);
        };

        let result = text;
        let prev;
        do {
            prev = result;
            result = processText(prev);
        } while (result !== prev);

        return result;
    }
    log() {
        console.log(`[+] READY : [${this.user.tag}]`.green);
    }

    async start() {
        try {
            const opts = this.config.config?.options || {};
            const humanMode = opts.humanMode !== false;

            await this.sys.update();

            // ── Human startup: login ────────────────────────────────
            console.log(`[~] Connecting [fp:${this._fp.client_version}] - ${this.maskToken(this.TOKEN)}`.cyan);
            await this.login(this.TOKEN);

            // ── Stagger delay (original multi-token spacing) ────────
            const stagger = this.targetTime - Date.now();
            if (stagger > 0) await this.humanSleep(stagger);

            if (humanMode) {
                const configuredStatus = this.streamingStatus(opts);
                // ── Phase 1: App open delay ─────────────────────────
                // A human opens Discord, it takes a few seconds to load
                const openDelay = this.rand(4000, 14000);
                console.log(`[Human] App open delay ${(openDelay/1000).toFixed(1)}s`.gray);
                await this.humanSleep(openDelay);

                // ── Phase 2: Come online ────────────────────────────
                await this.user?.setStatus(configuredStatus);
                console.log(`[Human] Status -> ${configuredStatus}`.gray);

                // ── Phase 3: "Reading messages" pause ──────────────
                // Simulate scrolling through DMs / channels
                const readDelay = this.rand(5000, 20000);
                console.log(`[Human] Reading feed ${(readDelay/1000).toFixed(1)}s`.gray);
                await this.humanSleep(readDelay, 0.1);

                // ── Phase 4: Rare startup idle peek (5%) ───────────
                // Maybe the user got distracted before going live
                if (configuredStatus === 'online' && Math.random() < 0.05) {
                    const idlePeek = this.rand(20000, 90000);
                    console.log(`[Human] Pre-stream idle ${(idlePeek/1000).toFixed(0)}s`.gray);
                    await this.user?.setStatus('idle');
                    await this.humanSleep(idlePeek, 0.12);
                    await this.user?.setStatus(configuredStatus);
                    await this.humanSleep(this.rand(3000, 10000));
                }

                // ── Phase 5: Navigate to the stream section ─────────
                // Simulate time to click into activity settings
                await this.humanSleep(this.rand(2000, 6000), 0.1);
                console.log(`[Human] Launching Discord activity...`.gray);
            }

            this.lib.timestamp = Date.now();
            const updateInterval = humanMode
                ? this.jitter(1000 * this.config.setup.delay)
                : 1000 * this.config.setup.delay;

            this.startInterval(() => this.sys.update(), updateInterval);
            try {
                await this.streaming();
            } catch (streamErr) {
                console.log(`[Streaming] First cycle failed: ${streamErr.message}`.red);
                if (streamErr.stack) console.log(`[Streaming:stack] ${streamErr.stack}`.red);
                this.scheduleStreaming(30000);
            }
            this.log();
            return { success: true };
        } catch (error) {
            this.destroy();
            const errorMessage = error.message.toUpperCase().replace(/\./g, '');
            console.log(`[-] ${this.maskToken(this.TOKEN)} : ${errorMessage}`.red);
            if (error.stack) {
                console.log(`[Stack] ${error.stack}`.red);
            }
            return { success: false };
        }
    }

    end() {
        this.stopAllIntervals();
        this.destroy();
    }
}

(async () => {
    const normalizeUsers = (rawUsers) => {
        const list = Array.isArray(rawUsers) ? rawUsers : [rawUsers];
        return list
            .filter(user => user && typeof user === "object")
            .map(user => ({
                ...user,
                tk: Array.isArray(user.tk) ? user.tk : (user.tk ? [user.tk] : []),
            }));
    };

    const users = normalizeUsers(require("./setup/starter"));
    const envToken = process.env.TOKEN;
    const totalTokens = envToken
        ? 1
        : users.reduce((count, user) => count + user.tk.length, 0);

    const info = {
        name: "STREAMING",
        version: "2.1.555ccc",
        update: "2025-02-2 7:59AM",
        author: "Ahmed",
        wait: Date.now() + 1000 * users.length
    };
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    console.clear();
    console.log(`[+] ${info.name} ${info.version} - ${info.update}`.blue);
    console.log(`[+] Author: ${info.author}`.blue);
    console.log(`[+] Tokens configured: ${totalTokens}`.blue);
    console.log("[+] Starting...".green);

    const work = new Map();
    setupDashboardControlChannel();

    if (envToken) {
        console.log("[+] Using token from process.env.TOKEN".yellow);
        const clientConfig = users[0]?.config || require("./setup/config.json");
        const client = new ModClient(envToken, clientConfig, info);
        const result = await client.start();
        if (result.success) {
            work.set(`ID:${client.user.id}`, client);
            dashboardClients.add(client);
        }
    } else {
        for (const user of users) {
            for (const token of user.tk) {
                const client = new ModClient(token, user.config, info);
                const result = await client.start();
                if (result.success) {
                    work.set(`ID:${client.user.id}`, client);
                    dashboardClients.add(client);
                }
            }
        }
    }

    console.log(`[+] Ahmed: ${work.size}/${totalTokens} account(s) online`.magenta);
    if (pendingDashboardRefresh && work.size) {
        pendingDashboardRefresh = false;
        refreshDashboardClients("queued-dashboard").catch(e => {
            console.log(`[Dashboard] Queued refresh failed: ${e.message}`.red);
        });
    }

    if (!work.size) {
        console.log('');
        console.log("[-] Closing...".red);
        setTimeout(() => process.exit(), 3000);
    }
})();
