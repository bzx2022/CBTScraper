const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const CONFIG_PATH = path.join(__dirname, 'config.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let sessionToken = '';
let torrentApiKey = '';

const WATCHLIST_PATH = path.join(__dirname, 'watchlist.json');
const TORRENT_DIR = path.join(__dirname, 'torrents');
let watchlist = [];

function loadWatchlist() {
    try {
        if (fs.existsSync(WATCHLIST_PATH)) {
            watchlist = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf8'));
            if (!Array.isArray(watchlist)) watchlist = [];
        }
        if (!fs.existsSync(TORRENT_DIR)) fs.mkdirSync(TORRENT_DIR, { recursive: true });
    } catch (err) {
        console.error('Failed to load watchlist:', err.message);
        watchlist = [];
    }
}

function saveWatchlist() {
    try {
        fs.writeFileSync(WATCHLIST_PATH, JSON.stringify(watchlist, null, 2), 'utf8');
    } catch (err) {
        console.error('Failed to save watchlist:', err.message);
    }
}

// Parse "Show.Name.2024.S02E04.1080p..." -> { seriesKey, displayName, season, episode }
function parseRelease(releaseName) {
    if (!releaseName) return null;
    const m = releaseName.match(/[._-]S(\d{1,2})E(\d{1,3})/i);
    if (!m) return null;
    const season = parseInt(m[1], 10);
    const episode = parseInt(m[2], 10);
    let prefix = releaseName.slice(0, m.index);
    prefix = prefix.replace(/[._]+/g, ' ').replace(/-+/g, ' ').trim();
    prefix = prefix.replace(/\b(19|20)\d{2}\b/g, '').replace(/\s{2,}/g, ' ').trim();
    if (!prefix) return null;
    return { seriesKey: prefix.toLowerCase(), displayName: prefix, season, episode };
}

function isNewer(aSeason, aEp, bSeason, bEp) {
    if (aSeason !== bSeason) return aSeason > bSeason;
    return aEp > bEp;
}

function releaseTag(season, episode) {
    return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

function isProperRelease(title) {
    return /\b(PROPER|REPACK)\b/i.test(title || '');
}

// True if this exact episode was already downloaded, unless the candidate is
// a PROPER/REPACK upgrade we haven't grabbed yet. Prevents re-downloading
// the same S/E on every scrape while still allowing proper upgrades.
function alreadyDownloaded(entry, season, episode, title) {
    const tag = releaseTag(season, episode);
    const prior = (entry.downloadedReleases || []).filter(r => r.tag === tag);
    if (prior.length === 0) return false;
    const proper = isProperRelease(title);
    if (proper && !prior.some(r => r.proper)) return false;
    return true;
}

function recordDownload(entry, season, episode, title) {
    entry.downloadedReleases = entry.downloadedReleases || [];
    entry.downloadedReleases.push({
        tag: releaseTag(season, episode),
        title,
        proper: isProperRelease(title),
        downloadedAt: new Date().toISOString()
    });
}

function buildAuthHeaders() {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*'
    };
    if (sessionToken) {
        if (sessionToken.toLowerCase().startsWith('bearer ')) headers['authorization'] = sessionToken;
        else if (sessionToken.includes('.')) headers['authorization'] = `Bearer ${sessionToken}`;
        else headers['cookie'] = sessionToken;
    }
    return headers;
}

async function downloadTorrentFile(torrentId, releaseName) {
    const cleanKey = (torrentApiKey || '').replace(/^key=/, '');
    const url = `https://milkie.cc/api/v1/torrents/${torrentId}/torrent${cleanKey ? `?key=${cleanKey}` : ''}`;
    const res = await fetch(url, { headers: buildAuthHeaders() });
    if (!res.ok) throw new Error(`Torrent download failed (id ${torrentId}): status ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const safe = (releaseName || torrentId).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 150) + '.torrent';
    const dest = path.join(TORRENT_DIR, safe);
    fs.writeFileSync(dest, buf);
    return dest;
}

// One-time migration for entries flagged before the download log existed:
// treat the last successfully downloaded release as already-downloaded so it
// is not grabbed once more just to seed the log.
function seedDownloadLog(entry) {
    if ((entry.downloadedReleases || []).length > 0) return false;
    if (entry.downloadError || !entry.downloadedFile || !entry.latest || !entry.latest.title) return false;
    recordDownload(entry, entry.latest.season, entry.latest.episode, entry.latest.title);
    return true;
}

// Compare scraped TV items against watchlist; flag + auto-download newer episodes
async function checkWatchlist(tvItems) {
    let changed = false;
    for (const entry of watchlist) {
        if (seedDownloadLog(entry)) changed = true;
        const candidates = [];
        for (const item of tvItems) {
            const p = parseRelease(item.title);
            if (p && p.seriesKey === entry.seriesKey && isNewer(p.season, p.episode, entry.season, entry.episode)) {
                candidates.push({ parsed: p, item });
            }
        }
        // Drop episodes already downloaded (same S/E), except PROPER/REPACK upgrades.
        const fresh = candidates.filter(c => !alreadyDownloaded(entry, c.parsed.season, c.parsed.episode, c.item.title));
        if (fresh.length > 0) {
            fresh.sort((a, b) => (a.parsed.season - b.parsed.season) || (a.parsed.episode - b.parsed.episode));
            const best = fresh[fresh.length - 1];
            entry.hasNew = true;
            entry.newDetectedAt = new Date().toISOString();
            entry.latest = {
                season: best.parsed.season,
                episode: best.parsed.episode,
                title: best.item.title,
                torrentId: best.item.torrentId,
                downloadUrl: best.item.downloadUrl
            };
            try {
                entry.downloadedFile = await downloadTorrentFile(best.item.torrentId, best.item.title);
                entry.downloadError = null;
                recordDownload(entry, best.parsed.season, best.parsed.episode, best.item.title);
            } catch (err) {
                entry.downloadError = err.message;
            }
            changed = true;
        }
    }
    if (changed) saveWatchlist();
}

let omdbApiKey = '';

// Weekly metadata cache: key -> { rating, genres, imdbID, imdbUrl, fetchedAt }
const META_CACHE_PATH = path.join(__dirname, 'ratings-cache.json');
const META_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let metaCache = {};

function loadMetaCache() {
    try {
        if (fs.existsSync(META_CACHE_PATH)) {
            const parsed = JSON.parse(fs.readFileSync(META_CACHE_PATH, 'utf8'));
            if (parsed && typeof parsed === 'object') metaCache = parsed;
        }
    } catch (err) {
        console.error('Failed to load ratings cache:', err.message);
        metaCache = {};
    }
}

function saveMetaCache() {
    try {
        fs.writeFileSync(META_CACHE_PATH, JSON.stringify(metaCache, null, 2), 'utf8');
    } catch (err) {
        console.error('Failed to save ratings cache:', err.message);
    }
}

// Parse "Movie.Name.2024.1080p.WEB.H264-GROUP" -> { query, year }
function parseMovieTitle(releaseName) {
    if (!releaseName) return null;
    const yearMatch = releaseName.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? yearMatch[0] : null;
    // Title is everything before the year (or before the first quality tag).
    let head = year ? releaseName.slice(0, yearMatch.index) : releaseName.split(/[._-](1080p|2160p|720p|480p|WEB|BluRay|HDTV|HDCAM|HC|HDRip|BRRip)/i)[0];
    head = head.replace(/[._]+/g, ' ').replace(/-+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!head) return null;
    return { query: head, year };
}

function metaCacheKey(kind, name, year) {
    return `${kind}|${name.toLowerCase()}|${year || ''}`;
}

async function fetchOmdb(query, year, type) {
    const params = new URLSearchParams({ apikey: omdbApiKey, t: query, type });
    if (year) params.append('y', year);
    // OMDb is HTTP-friendly and keyless-safe; short timeout via AbortController.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
        const res = await fetch(`https://www.omdbapi.com/?${params.toString()}`, {
            headers: { Accept: 'application/json' },
            signal: ctrl.signal
        });
        if (!res.ok) throw new Error(`OMDb status ${res.status}`);
        const data = await res.json();
        if (!data || data.Response !== 'True') throw new Error(data && data.Error ? data.Error : 'Not found');
        const genres = data.Genre && data.Genre !== 'N/A'
            ? data.Genre.split(',').map(g => g.trim()).filter(Boolean)
            : [];
        return {
            rating: data.imdbRating && data.imdbRating !== 'N/A' ? data.imdbRating : null,
            genres,
            imdbID: data.imdbID || null,
            imdbUrl: data.imdbID ? `https://www.imdb.com/title/${data.imdbID}/` : null
        };
    } finally {
        clearTimeout(timer);
    }
}

// Resolve metadata for one item, using the weekly cache. Never throws.
async function resolveMeta(kind, name, year) {
    const key = metaCacheKey(kind, name, year);
    const cached = metaCache[key];
    if (cached && (Date.now() - (cached.fetchedAt || 0)) < META_CACHE_TTL_MS) {
        return cached;
    }
    if (!omdbApiKey) return cached || null;
    try {
        const fresh = await fetchOmdb(name, year, kind === 'series' ? 'series' : 'movie');
        metaCache[key] = { ...fresh, fetchedAt: Date.now() };
        saveMetaCache();
        return metaCache[key];
    } catch (err) {
        console.error(`Metadata lookup failed [${kind}] "${name}": ${err.message}`);
        return cached || null;
    }
}

// Enrich already-sliced top items with rating/genres (concurrency-limited).
async function enrichWithMeta(items, kind) {
    const CONCURRENCY = 4;
    const queue = items.slice();
    async function worker() {
        while (queue.length > 0) {
            const item = queue.shift();
            let name = null;
            let year = null;
            if (kind === 'series') {
                const p = parseRelease(item.title);
                if (p) name = p.displayName;
            } else {
                const p = parseMovieTitle(item.title);
                if (p) {
                    name = p.query;
                    year = p.year;
                }
            }
            item.meta = name ? await resolveMeta(kind, name, year) : null;
            // Gentle pacing so we stay far under OMDb's free quota.
            await new Promise(r => setTimeout(r, 250));
        }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
    return items;
}

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
            const cfg = JSON.parse(raw);
            if (cfg.sessionToken) sessionToken = cfg.sessionToken;
            if (cfg.torrentApiKey) torrentApiKey = cfg.torrentApiKey;
            if (cfg.omdbApiKey) omdbApiKey = cfg.omdbApiKey;
            console.log(`Loaded saved config (token: ${sessionToken ? 'yes' : 'no'}, apiKey: ${torrentApiKey ? 'yes' : 'no'}, omdb: ${omdbApiKey ? 'yes' : 'no'})`);
        }
    } catch (err) {
        console.error('Failed to load config.json:', err.message);
    }
}

function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify({ sessionToken, torrentApiKey, omdbApiKey }, null, 2), 'utf8');
    } catch (err) {
        console.error('Failed to save config.json:', err.message);
    }
}

loadConfig();
loadWatchlist();
loadMetaCache();

// Scrape function for category (1 = Movies, 2 = TV Shows)
async function scrapeCategory(categoryId) {
    const items = [];
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

    for (let pi = 0; pi < 2; pi++) {
        const apiUrl = `https://milkie.cc/api/v1/torrents?oby=created_at&odir=desc&categories=${categoryId}&pi=${pi}&ps=100`;
        
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*'
        };

        if (sessionToken) {
            if (sessionToken.toLowerCase().startsWith('bearer ')) {
                headers['authorization'] = sessionToken;
            } else if (sessionToken.includes('.')) {
                headers['authorization'] = `Bearer ${sessionToken}`;
            } else {
                headers['cookie'] = sessionToken;
            }
        }

        const res = await fetch(apiUrl, { headers });

        if (!res.ok) {
            throw new Error(`Failed to fetch API torrents category ${categoryId} pi ${pi}: status ${res.status} - ${await res.text()}`);
        }

        const data = await res.json();
        const list = Array.isArray(data) ? data : (data.torrents || data.data || data.results || data.items || []);

        for (const t of list) {
            const createdAtStr = t.createdAt || t.created_at || t.date || '';
            const createdAtTime = createdAtStr ? new Date(createdAtStr).getTime() : Date.now();

            if (createdAtTime >= sevenDaysAgo || !createdAtStr) {
                items.push(buildTorrentItem(t));
            }
        }
    }

    // Sort by amount downloaded descending, pick top 20, then enrich with ratings.
    items.sort((a, b) => b.downloaded - a.downloaded);
    const top = items.slice(0, 20);
    await enrichWithMeta(top, categoryId === 2 ? 'series' : 'movie');
    return top;
}

// Map one raw milkie torrent object to the SPA item shape (shared by scrape + search).
function buildTorrentItem(t) {
    const title = t.releaseName || t.title || t.name || 'Unknown';
    const releaser = t.group || '';
    const fullTitle = releaser && !title.includes(releaser) ? `${title}-${releaser}` : title;
    const createdAtStr = t.createdAt || t.created_at || t.date || '';

    let dlUrl = t.id ? `https://milkie.cc/api/v1/torrents/${t.id}/torrent` : '';
    if (torrentApiKey && dlUrl) {
        const cleanKey = torrentApiKey.replace(/^key=/, '');
        dlUrl += `?key=${cleanKey}`;
    }

    return {
        title: fullTitle,
        torrentId: t.id || null,
        category: t.category || null,
        href: t.slug ? `/browse/${t.slug}` : (t.id ? `/browse/${t.id}` : '#'),
        downloadUrl: dlUrl,
        createdAt: createdAtStr,
        createdAtTime: createdAtStr ? new Date(createdAtStr).getTime() : Date.now(),
        size: t.size ? (typeof t.size === 'number' ? `${(t.size / (1024*1024*1024)).toFixed(2)} GiB` : t.size) : 'N/A',
        downloaded: t.downloaded || t.completed || t.times_completed || 0,
        seeders: t.seeders || t.seed || 0,
        leechers: t.leechers || t.leech || 0,
        meta: null
    };
}

// API endpoint to set manual token (auto-saved to config.json)
app.post('/api/set-cookie', (req, res) => {
    const { cookie } = req.body;
    if (cookie) {
        sessionToken = cookie;
        saveConfig();
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false, error: 'Token string is required' });
    }
});

// API endpoint to set torrent API key (auto-saved to config.json)
app.post('/api/set-apikey', (req, res) => {
    const { apiKey } = req.body;
    if (apiKey) {
        torrentApiKey = apiKey;
        saveConfig();
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false, error: 'API key string is required' });
    }
});

// API endpoint to set OMDb API key (auto-saved to config.json)
// Extract a bare key from raw input (accepts a pasted OMDb sample URL too).
function normalizeOmdbKey(input) {
    const s = String(input || '').trim();
    if (!s) return '';
    const m = s.match(/[?&]apikey=([^&\s]+)/i);
    if (m) return m[1].trim();
    return s;
}

app.post('/api/set-omdbkey', (req, res) => {
    const omdbKey = normalizeOmdbKey(req.body && req.body.omdbKey);
    if (omdbKey) {
        omdbApiKey = omdbKey;
        saveConfig();
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false, error: 'OMDb key string is required' });
    }
});

// API endpoint to retrieve saved credentials (local-only app)
app.get('/api/config', (req, res) => {
    res.json({ success: true, token: sessionToken, apiKey: torrentApiKey, omdbKey: omdbApiKey });
});

// Auto-updater endpoints (GitHub Releases).
const updater = require('./updater');

app.get('/api/update/check', async (req, res) => {
    try {
        res.json({ success: true, ...(await updater.checkForUpdate()) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/update/apply', async (req, res) => {
    try {
        res.json({ success: true, ...(await updater.downloadAndApply()) });
    } catch (err) {
        console.error('Update failed:', err);
        res.status(500).json({ success: false, error: err.stack || err.message });
    }
});

// Check for updates on boot and daily; result is surfaced via /api/update/check.
async function pollForUpdates() {
    try {
        const info = await updater.checkForUpdate();
        if (info.available) {
            console.log(`Update available: v${info.current} -> v${info.latest} (${info.url})`);
        }
    } catch (err) {
        console.error('Update check failed:', err.message);
    }
}
setTimeout(pollForUpdates, 30 * 1000);
setInterval(pollForUpdates, 24 * 60 * 60 * 1000);

// Watchlist endpoints
app.get('/api/watchlist', (req, res) => {
    res.json({ success: true, watchlist });
});

app.post('/api/watchlist', (req, res) => {
    const { title, torrentId } = req.body;
    if (!title) return res.status(400).json({ success: false, error: 'title is required' });
    const parsed = parseRelease(title);
    if (!parsed) return res.status(400).json({ success: false, error: 'Could not parse season/episode from title (expected SxxEyy)' });
    if (watchlist.some(e => e.seriesKey === parsed.seriesKey)) {
        return res.status(409).json({ success: false, error: 'Show is already in watchlist' });
    }
    const entry = {
        id: Date.now().toString(),
        seriesKey: parsed.seriesKey,
        displayName: parsed.displayName,
        season: parsed.season,
        episode: parsed.episode,
        torrentId: torrentId || null,
        addedAt: new Date().toISOString(),
        hasNew: false,
        latest: null,
        downloadedFile: null,
        downloadError: null,
        downloadedReleases: []
    };
    watchlist.push(entry);
    saveWatchlist();
    res.json({ success: true, entry });
});

app.delete('/api/watchlist/:id', (req, res) => {
    const before = watchlist.length;
    watchlist = watchlist.filter(e => e.id !== req.params.id);
    if (watchlist.length === before) return res.status(404).json({ success: false, error: 'Entry not found' });
    saveWatchlist();
    res.json({ success: true });
});

app.post('/api/watchlist/:id/ack', (req, res) => {
    const entry = watchlist.find(e => e.id === req.params.id);
    if (!entry) return res.status(404).json({ success: false, error: 'Entry not found' });
    if (entry.latest) {
        entry.season = entry.latest.season;
        entry.episode = entry.latest.episode;
        entry.torrentId = entry.latest.torrentId;
    }
    entry.hasNew = false;
    entry.latest = null;
    saveWatchlist();
    res.json({ success: true, entry });
});

// Milkie full-text search proxy: GET /api/search?query=president+curtis
app.get('/api/search', async (req, res) => {
    try {
        const query = String(req.query.query || '').trim();
        if (!query) return res.status(400).json({ success: false, error: 'query parameter is required' });

        const apiUrl = `https://milkie.cc/api/v1/torrents?query=${encodeURIComponent(query)}&oby=created_at&odir=desc&pi=0&ps=100`;
        const apiRes = await fetch(apiUrl, { headers: buildAuthHeaders() });
        if (!apiRes.ok) {
            throw new Error(`Search failed: status ${apiRes.status} - ${await apiRes.text()}`);
        }
        const data = await apiRes.json();
        const list = Array.isArray(data) ? data : (data.torrents || data.data || data.results || data.items || []);
        res.json({
            success: true,
            hits: data.hits != null ? data.hits : list.length,
            results: list.slice(0, 100).map(buildTorrentItem)
        });
    } catch (err) {
        console.error('Search error:', err);
        res.status(500).json({ success: false, error: err.stack || err.message });
    }
});

// Latest-torrents cache: key "category|pi" -> { fetchedAt, payload }.
// 15-minute TTL so paging back and forth never re-hits milkie.cc.
const latestCache = new Map();
const LATEST_TTL_MS = 15 * 60 * 1000;
const LATEST_WINDOW_MS = 48 * 60 * 60 * 1000;

// Latest torrents from the last 48h, 100 per page: GET /api/latest?category=2&pi=0
app.get('/api/latest', async (req, res) => {
    try {
        const category = req.query.category === '1' ? 1 : 2;
        const pi = Math.max(0, parseInt(req.query.pi || '0', 10) || 0);
        const key = `${category}|${pi}`;
        const now = Date.now();

        const cached = latestCache.get(key);
        if (cached && (now - cached.fetchedAt) < LATEST_TTL_MS) {
            return res.json({ ...cached.payload, cached: true });
        }

        const apiUrl = `https://milkie.cc/api/v1/torrents?oby=created_at&odir=desc&categories=${category}&pi=${pi}&ps=100`;
        const apiRes = await fetch(apiUrl, { headers: buildAuthHeaders() });
        if (!apiRes.ok) {
            throw new Error(`Latest fetch failed cat=${category} pi=${pi}: status ${apiRes.status} - ${await apiRes.text()}`);
        }
        const data = await apiRes.json();
        const list = Array.isArray(data) ? data : (data.torrents || data.data || data.results || data.items || []);
        const cutoff = now - LATEST_WINDOW_MS;
        const results = list.map(buildTorrentItem).filter(item => item.createdAtTime >= cutoff);

        const payload = { success: true, category, pi, count: results.length, results };
        latestCache.set(key, { fetchedAt: now, payload });
        res.json({ ...payload, cached: false });
    } catch (err) {
        console.error('Latest error:', err);
        res.status(500).json({ success: false, error: err.stack || err.message });
    }
});

// Per-series episode cache: name -> { fetchedAt, items } (full date-sorted list).
const showCache = new Map();
const SHOW_TTL_MS = 15 * 60 * 1000;
const SHOW_PAGE_SIZE = 50;

// All released episodes for one show, newest first: GET /api/show?name=President Curtis&pi=0
app.get('/api/show', async (req, res) => {
    try {
        const rawName = String(req.query.name || '').trim();
        const pi = Math.max(0, parseInt(req.query.pi || '0', 10) || 0);
        if (!rawName) return res.status(400).json({ success: false, error: 'name parameter is required' });
        const key = rawName.toLowerCase();
        const now = Date.now();

        let items = null;
        const cached = showCache.get(key);
        if (cached && (now - cached.fetchedAt) < SHOW_TTL_MS) {
            items = cached.items;
        } else {
            // Pull milkie search pages (100 each, cap 5) then keep exact series matches.
            const all = [];
            for (let spi = 0; spi < 5; spi++) {
                const apiUrl = `https://milkie.cc/api/v1/torrents?query=${encodeURIComponent(rawName)}&oby=created_at&odir=desc&pi=${spi}&ps=100`;
                const apiRes = await fetch(apiUrl, { headers: buildAuthHeaders() });
                if (!apiRes.ok) {
                    throw new Error(`Show fetch failed "${rawName}" pi=${spi}: status ${apiRes.status} - ${await apiRes.text()}`);
                }
                const data = await apiRes.json();
                const list = Array.isArray(data) ? data : (data.torrents || data.data || data.results || data.items || []);
                all.push(...list);
                if (list.length < 100) break;
            }
            items = all
                .map(buildTorrentItem)
                .filter(item => {
                    const p = parseRelease(item.title);
                    return p && p.seriesKey === key;
                })
                .sort((a, b) => b.createdAtTime - a.createdAtTime);
            showCache.set(key, { fetchedAt: now, items });
        }

        const pages = Math.max(1, Math.ceil(items.length / SHOW_PAGE_SIZE));
        const page = Math.min(pi, pages - 1);
        res.json({
            success: true,
            name: rawName,
            total: items.length,
            page,
            pages,
            cached: !!cached && (now - cached.fetchedAt) < SHOW_TTL_MS,
            results: items.slice(page * SHOW_PAGE_SIZE, page * SHOW_PAGE_SIZE + SHOW_PAGE_SIZE)
        });
    } catch (err) {
        console.error('Show error:', err);
        res.status(500).json({ success: false, error: err.stack || err.message });
    }
});

app.get('/api/scrape', async (req, res) => {
    try {
        const [tvShows, movies] = await Promise.all([
            scrapeCategory(2),
            scrapeCategory(1)
        ]);

        await checkWatchlist(tvShows);

        res.json({
            success: true,
            tvShows,
            movies,
            watchlist
        });
    } catch (err) {
        console.error('Scrape error:', err);
        res.status(500).json({
            success: false,
            error: err.stack || err.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`Milkie Scraper SPA running at http://localhost:${PORT}`);
});
