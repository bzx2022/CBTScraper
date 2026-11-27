// Shared download history for the SPA and the RSS bridge.
// ---------------------------------------------------------------------------
// Every release this app downloads is recorded here, whether it was grabbed by
// the watchlist poller, a bulk "download all", an episode backfill, or a
// manual click on a Download button. Both processes read the same file so the
// "Downloaded" pills stay accurate after a restart and regardless of which
// process performed the download.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const MAX_RECORDS = 3000;

function normalizeTitle(title) {
    return String(title || '')
        .replace(/\.torrent$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function createDownloadHistory(filePath) {
    let records = [];
    let byId = new Map();
    let byTitle = new Map();
    let lastMtime = -1;

    function fileMtime() {
        try { return fs.statSync(filePath).mtimeMs; } catch (_) { return 0; }
    }

    function index() {
        byId = new Map();
        byTitle = new Map();
        for (const r of records) {
            if (r.torrentId) byId.set(String(r.torrentId), r);
            const key = normalizeTitle(r.title);
            if (key) byTitle.set(key, r);
        }
    }

    function load() {
        let list = [];
        try {
            if (fs.existsSync(filePath)) {
                const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                if (Array.isArray(raw)) list = raw;
                else if (raw && Array.isArray(raw.records)) list = raw.records;
            }
        } catch (err) {
            console.error(`Download history: failed to read ${path.basename(filePath)}: ${err.message}`);
            list = [];
        }
        records = list.filter((r) => r && (r.torrentId || r.title));
        if (records.length > MAX_RECORDS) records = records.slice(-MAX_RECORDS);
        lastMtime = fileMtime();
        index();
    }

    function save() {
        try {
            if (records.length > MAX_RECORDS) records = records.slice(-MAX_RECORDS);
            fs.writeFileSync(filePath, JSON.stringify({ version: 1, records }, null, 2), 'utf8');
            lastMtime = fileMtime();
        } catch (err) {
            console.error(`Download history: failed to write ${path.basename(filePath)}: ${err.message}`);
        }
    }

    // Adds without touching disk; callers decide when to save.
    function add(rec) {
        if (!rec || (!rec.torrentId && !rec.title)) return false;
        const torrentId = rec.torrentId ? String(rec.torrentId) : '';
        const title = String(rec.title || '');
        const titleKey = normalizeTitle(title);
        if (torrentId && byId.has(torrentId)) return false;
        if (titleKey && byTitle.has(titleKey)) return false;
        const entry = {
            torrentId: torrentId || null,
            title,
            kind: rec.kind || 'other',
            source: rec.source || 'manual',
            season: rec.season != null ? rec.season : null,
            episode: rec.episode != null ? rec.episode : null,
            resolution: rec.resolution || null,
            at: rec.at || new Date().toISOString()
        };
        records.push(entry);
        if (torrentId) byId.set(torrentId, entry);
        if (titleKey) byTitle.set(titleKey, entry);
        return true;
    }

    // Re-read first so the SPA and bridge never overwrite each other's records.
    function record(rec) {
        load();
        if (!add(rec)) return false;
        save();
        return true;
    }

    function recordMany(list) {
        load();
        let changed = false;
        for (const rec of (list || [])) {
            if (add(rec)) changed = true;
        }
        if (changed) save();
        return changed;
    }

    function refresh() {
        const mtime = fileMtime();
        if (mtime !== lastMtime) load();
    }

    function check(torrentId, title) {
        if (torrentId && byId.has(String(torrentId))) return true;
        const key = normalizeTitle(title);
        return !!(key && byTitle.has(key));
    }

    function has(torrentId, title) {
        if (check(torrentId, title)) return true;
        // The other process may have written a record since our last read.
        refresh();
        return check(torrentId, title);
    }

    // Seed older watchlist downloads that predate the history file.
    function seedFromWatchlist(watchlist) {
        const seed = [];
        for (const entry of (watchlist || [])) {
            for (const r of (entry.downloadedReleases || [])) {
                if (r && r.title) {
                    seed.push({
                        torrentId: r.torrentId || null,
                        title: r.title,
                        kind: 'tv',
                        source: 'watchlist',
                        season: r.season != null ? r.season : null,
                        episode: r.episode != null ? r.episode : null,
                        resolution: r.resolution || null,
                        at: r.downloadedAt || null
                    });
                }
            }
        }
        return recordMany(seed);
    }

    load();
    return { record, recordMany, has, refresh, seedFromWatchlist, records: () => records.slice() };
}

module.exports = { createDownloadHistory, normalizeTitle };
