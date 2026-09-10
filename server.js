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

// Compare scraped TV items against watchlist; flag + auto-download newer episodes
async function checkWatchlist(tvItems) {
    let changed = false;
    for (const entry of watchlist) {
        const candidates = [];
        for (const item of tvItems) {
            const p = parseRelease(item.title);
            if (p && p.seriesKey === entry.seriesKey && isNewer(p.season, p.episode, entry.season, entry.episode)) {
                candidates.push({ parsed: p, item });
            }
        }
        if (candidates.length > 0) {
            candidates.sort((a, b) => (a.parsed.season - b.parsed.season) || (a.parsed.episode - b.parsed.episode));
            const best = candidates[candidates.length - 1];
            entry.hasNew = true;
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
            } catch (err) {
                entry.downloadError = err.message;
            }
            changed = true;
        }
    }
    if (changed) saveWatchlist();
}

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
            const cfg = JSON.parse(raw);
            if (cfg.sessionToken) sessionToken = cfg.sessionToken;
            if (cfg.torrentApiKey) torrentApiKey = cfg.torrentApiKey;
            console.log(`Loaded saved config (token: ${sessionToken ? 'yes' : 'no'}, apiKey: ${torrentApiKey ? 'yes' : 'no'})`);
        }
    } catch (err) {
        console.error('Failed to load config.json:', err.message);
    }
}

function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify({ sessionToken, torrentApiKey }, null, 2), 'utf8');
    } catch (err) {
        console.error('Failed to save config.json:', err.message);
    }
}

loadConfig();
loadWatchlist();

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

            const title = t.releaseName || t.title || t.name || 'Unknown';
            const releaser = t.group || '';
            const fullTitle = releaser && !title.includes(releaser) ? `${title}-${releaser}` : title;

            if (createdAtTime >= sevenDaysAgo || !createdAtStr) {
                let dlUrl = t.id ? `https://milkie.cc/api/v1/torrents/${t.id}/torrent` : '';
                if (torrentApiKey && dlUrl) {
                    const cleanKey = torrentApiKey.replace(/^key=/, '');
                    dlUrl += `?key=${cleanKey}`;
                }

                items.push({
                    title: fullTitle,
                    torrentId: t.id || null,
                    href: t.slug ? `/browse/${t.slug}` : (t.id ? `/browse/${t.id}` : '#'),
                    downloadUrl: dlUrl,
                    createdAt: createdAtStr,
                    createdAtTime,
                    size: t.size ? (typeof t.size === 'number' ? `${(t.size / (1024*1024*1024)).toFixed(2)} GiB` : t.size) : 'N/A',
                    downloaded: t.downloaded || t.completed || t.times_completed || 0,
                    seeders: t.seeders || t.seed || 0,
                    leechers: t.leechers || t.leech || 0
                });
            }
        }
    }

    // Sort by amount downloaded descending, pick top 20
    items.sort((a, b) => b.downloaded - a.downloaded);
    return items.slice(0, 20);
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

// API endpoint to retrieve saved credentials (local-only app)
app.get('/api/config', (req, res) => {
    res.json({ success: true, token: sessionToken, apiKey: torrentApiKey });
});

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
        downloadError: null
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
