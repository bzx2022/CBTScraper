// Milkie Watchlist RSS Bridge for uTorrent 2.2.1
// ---------------------------------------------------------------------------
// Plain-HTTP local service (http://127.0.0.1:8080) that:
//   1. Polls milkie.cc TV listings independently of the SPA, compares them
//      against watchlist.json, and downloads new episodes as .torrent files
//      into ../torrents.
//   2. Watches ../torrents with chokidar and tracks each file in a tiny
//      lowdb database with states: 'pending' -> 'served' -> 'downloaded'.
//   3. Serves /feed.xml (RSS 2.0, download URL in <link>, fully escaped)
//      containing only 'pending'/'served' items for legacy uTorrent.
//   4. Serves /download/:filename; on successful transfer completion the
//      file is moved to ../torrents_archive so it never reappears in the feed.
//
// Lifecycle: chokidar 'add' => 'pending' | GET /feed.xml => 'served'
//            GET /download/:filename finishes => 'downloaded' + archive move.
// ---------------------------------------------------------------------------

const express = require('express');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const HOST = '127.0.0.1';
const PORT = process.env.RSS_PORT || 8080;
const BASE_URL = `http://${HOST}:${PORT}`;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '', 10) || 15 * 60 * 1000;

// Absolute folders shared with the SPA (service runs from rss-bridge/).
const ROOT_DIR = path.resolve(__dirname, '..');
const TORRENT_DIR = path.join(ROOT_DIR, 'torrents');
const ARCHIVE_DIR = path.join(ROOT_DIR, 'torrents_archive');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');
const WATCHLIST_PATH = path.join(ROOT_DIR, 'watchlist.json');
const DB_PATH = path.join(__dirname, 'db.json');

for (const dir of [TORRENT_DIR, ARCHIVE_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// --- Tiny file database (lowdb 1.0.0) --------------------------------------
// Record: { filename, title, size, addedAt, servedAt, downloadedAt, status }
const adapter = new FileSync(DB_PATH);
const db = low(adapter);
db.defaults({ torrents: [] }).write();

const findEntry = (filename) => db.get('torrents').find({ filename }).value();

// --- XML escaping (uTorrent 2.2.1 parser is brittle: escape & < > " ') ------
function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// --- Release-name parsing (mirrors SPA server.js) ---------------------------
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

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`[bridge] Failed to read ${path.basename(p)}: ${err.message}`);
    return fallback;
  }
}

function authHeaders(sessionToken) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
  };
  if (sessionToken) {
    if (sessionToken.toLowerCase().startsWith('bearer ')) headers.authorization = sessionToken;
    else if (sessionToken.includes('.')) headers.authorization = `Bearer ${sessionToken}`;
    else headers.cookie = sessionToken;
  }
  return headers;
}

// --- Watchlist poller (independent of the SPA web server) -------------------
let polling = false;

async function pollWatchlistOnce() {
  if (polling) return;
  polling = true;
  try {
    const cfg = readJsonSafe(CONFIG_PATH, {});
    const sessionToken = cfg.sessionToken || '';
    const torrentApiKey = (cfg.torrentApiKey || '').replace(/^key=/, '');
    const watchlist = readJsonSafe(WATCHLIST_PATH, []);
    if (!Array.isArray(watchlist) || watchlist.length === 0) return;
    if (!sessionToken) {
      console.log('[bridge] Skipping poll: no auth token in config.json yet.');
      return;
    }

    // Fetch latest TV listings (2 pages x 100, mirrors SPA scrape).
    const tvItems = [];
    for (let pi = 0; pi < 2; pi++) {
      const url = `https://milkie.cc/api/v1/torrents?oby=created_at&odir=desc&categories=2&pi=${pi}&ps=100`;
      const res = await fetch(url, { headers: authHeaders(sessionToken) });
      if (!res.ok) throw new Error(`TV fetch failed pi=${pi}: status ${res.status}`);
      const data = await res.json();
      const list = Array.isArray(data) ? data : data.torrents || data.data || data.results || data.items || [];
      tvItems.push(...list);
    }

    let watchlistChanged = false;
    for (const entry of watchlist) {
      if (!entry || !entry.seriesKey) continue;
      let best = null;
      for (const t of tvItems) {
        const title = t.releaseName || t.title || t.name;
        const p = parseRelease(title);
        if (p && p.seriesKey === entry.seriesKey && isNewer(p.season, p.episode, entry.season, entry.episode)) {
          if (!best || isNewer(p.season, p.episode, best.parsed.season, best.parsed.episode)) {
            best = { parsed: p, raw: t, title };
          }
        }
      }
      if (!best) continue;
      // Anti-loop: skip if this exact release already sits in torrents/ or archive/.
      const safeName = `${best.title.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 150)}.torrent`;
      if (fs.existsSync(path.join(TORRENT_DIR, safeName)) || fs.existsSync(path.join(ARCHIVE_DIR, safeName))) {
        continue;
      }
      // Download the .torrent bytes via the milkie API and drop into torrents/.
      // chokidar picks the new file up and marks it 'pending' for the RSS feed.
      const dlUrl = `https://milkie.cc/api/v1/torrents/${best.raw.id}/torrent${torrentApiKey ? `?key=${torrentApiKey}` : ''}`;
      const dlRes = await fetch(dlUrl, { headers: authHeaders(sessionToken) });
      if (!dlRes.ok) {
        console.error(`[bridge] Torrent download failed for ${best.title}: status ${dlRes.status}`);
        continue;
      }
      fs.writeFileSync(path.join(TORRENT_DIR, safeName), Buffer.from(await dlRes.arrayBuffer()));
      console.log(`[bridge] New episode for "${entry.displayName}": ${best.title} -> torrents/${safeName}`);

      // Mirror the SPA flag so the SPA UI shows "New Episode Found" too.
      entry.hasNew = true;
      entry.latest = {
        season: best.parsed.season,
        episode: best.parsed.episode,
        title: best.title,
        torrentId: best.raw.id,
        downloadUrl: dlUrl,
      };
      entry.downloadedFile = path.join(TORRENT_DIR, safeName);
      entry.downloadError = null;
      watchlistChanged = true;
    }
    if (watchlistChanged) {
      fs.writeFileSync(WATCHLIST_PATH, JSON.stringify(watchlist, null, 2), 'utf8');
    }
  } catch (err) {
    console.error(`[bridge] Watchlist poll failed: ${err.message}`);
  } finally {
    polling = false;
  }
}

// --- Folder watcher: ../torrents -> 'pending' -------------------------------
const watcher = chokidar.watch(TORRENT_DIR, {
  ignored: /(^|[/\\])\../, // dotfiles
  persistent: true,
  ignoreInitial: false, // pick up files already on disk at startup
  awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 100 },
  depth: 0,
});

watcher.on('add', (filePath) => {
  if (path.extname(filePath).toLowerCase() !== '.torrent') return;
  const filename = path.basename(filePath);
  const existing = findEntry(filename);
  if (existing && existing.status !== 'downloaded') return; // already tracked
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch (_) {
    return; // file vanished mid-event
  }
  if (existing && existing.status === 'downloaded') {
    // Manual re-drop of an archived file: re-queue it as pending.
    db.get('torrents').find({ filename }).assign({ status: 'pending', title: filename, size, addedAt: new Date().toISOString(), servedAt: null, downloadedAt: null }).write();
  } else {
    db.get('torrents').push({ filename, title: filename, size, addedAt: new Date().toISOString(), servedAt: null, downloadedAt: null, status: 'pending' }).write();
  }
  console.log(`[bridge] Tracked new torrent as 'pending': ${filename}`);
});

watcher.on('unlink', (filePath) => {
  const filename = path.basename(filePath);
  const entry = findEntry(filename);
  // Our own archive move marks the row 'downloaded' BEFORE renaming, so an
  // unlink for a 'downloaded' row is expected — keep it as history.
  if (entry && entry.status !== 'downloaded') {
    db.get('torrents').remove({ filename }).write();
    console.log(`[bridge] Untracked removed file: ${filename}`);
  }
});

// --- Express app (plain HTTP for legacy uTorrent TLS stack) -----------------
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.type('text/plain').send('Milkie RSS bridge running. Feed: /feed.xml');
});

// RSS 2.0 feed with the direct file URL in <link> (uTorrent 2.2.1 ignores
// <enclosure>). Only 'pending' + 'served' rows are listed; archived
// ('downloaded') rows never reappear. Reading the feed flips 'pending' rows
// to 'served' (transition #2 in the lifecycle).
app.get('/feed.xml', (req, res) => {
  const items = db.get('torrents').filter((t) => t.status === 'pending' || t.status === 'served').sortBy('addedAt').reverse().value();
  const now = new Date().toUTCString();
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n<channel>\n`;
  xml += `<title>${escapeXml('Milkie Watchlist')}</title>\n`;
  xml += `<link>${escapeXml(BASE_URL + '/')}</link>\n`;
  xml += `<description>${escapeXml('New watchlist episodes for uTorrent 2.2.1')}</description>\n`;
  xml += `<lastBuildDate>${escapeXml(now)}</lastBuildDate>\n`;
  for (const it of items) {
    const absUrl = `${BASE_URL}/download/${encodeURIComponent(it.filename)}`;
    const pubDate = it.addedAt ? new Date(it.addedAt).toUTCString() : now;
    xml += `<item>\n`;
    xml += `<title>${escapeXml(it.title || it.filename)}</title>\n`;
    xml += `<link>${escapeXml(absUrl)}</link>\n`;
    xml += `<guid>${escapeXml(absUrl)}</guid>\n`;
    xml += `<pubDate>${escapeXml(pubDate)}</pubDate>\n`;
    xml += `<description>${escapeXml(it.filename)}</description>\n`;
    xml += `</item>\n`;
  }
  xml += `</channel>\n</rss>\n`;

  // pending -> served: uTorrent has now been served this item.
  const stamp = new Date().toISOString();
  for (const it of items) {
    if (it.status === 'pending') {
      db.get('torrents').find({ filename: it.filename }).assign({ status: 'served', servedAt: stamp }).write();
    }
  }
  res.type('application/rss+xml; charset=UTF-8').send(xml);
});

// File delivery. Streams the .torrent over HTTP; ONLY when the response
// finishes without error does the row flip to 'downloaded' and the file move
// to ../torrents_archive (transition #3). Aborted transfers stay 'served' so
// they keep appearing in the feed and can be retried.
app.get('/download/:filename', (req, res) => {
  const filename = path.basename(decodeURIComponent(req.params.filename || ''));
  if (!filename || path.extname(filename).toLowerCase() !== '.torrent' || filename.includes('..')) {
    return res.status(400).type('text/plain').send('Invalid filename');
  }
  const entry = findEntry(filename);
  if (!entry) return res.status(404).type('text/plain').send('Unknown torrent');
  const filePath = path.join(TORRENT_DIR, filename);
  if (!fs.existsSync(filePath)) {
    if (fs.existsSync(path.join(ARCHIVE_DIR, filename))) {
      return res.status(410).type('text/plain').send('Already downloaded and archived');
    }
    return res.status(404).type('text/plain').send('File not found');
  }

  // If uTorrent grabs the file without ever reading the feed, catch up.
  if (entry.status === 'pending') {
    db.get('torrents').find({ filename }).assign({ status: 'served', servedAt: new Date().toISOString() }).write();
  }

  res.setHeader('Content-Type', 'application/x-bittorrent');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/"/g, '')}"`);
  try {
    res.setHeader('Content-Length', String(fs.statSync(filePath).size));
  } catch (_) {
    // fall through; stream will 404 below if the file vanished
  }
  const stream = fs.createReadStream(filePath);
  stream.on('error', (err) => {
    console.error(`[bridge] Stream error for ${filename}: ${err.message}`);
    if (!res.headersSent) res.status(500).type('text/plain').send('Read failed');
    else res.destroy();
  });
  // 'finish' fires only after the full body reached the client: archive now.
  res.on('finish', () => {
    try {
      db.get('torrents').find({ filename }).assign({ status: 'downloaded', downloadedAt: new Date().toISOString() }).write();
      let dest = path.join(ARCHIVE_DIR, filename);
      if (fs.existsSync(dest)) {
        const ext = path.extname(filename);
        const base = path.basename(filename, ext);
        dest = path.join(ARCHIVE_DIR, `${base}_${Date.now()}${ext}`);
      }
      fs.renameSync(filePath, dest);
      console.log(`[bridge] '${filename}' downloaded by client -> 'downloaded', archived.`);
    } catch (err) {
      console.error(`[bridge] Archive failed for ${filename}: ${err.message}`);
    }
  });
  stream.pipe(res);
});

// Small operational helpers (not required by uTorrent).
app.get('/api/status', (req, res) => {
  const rows = db.get('torrents').value();
  res.json({
    success: true,
    baseUrl: BASE_URL,
    counts: {
      pending: rows.filter((r) => r.status === 'pending').length,
      served: rows.filter((r) => r.status === 'served').length,
      downloaded: rows.filter((r) => r.status === 'downloaded').length,
    },
    torrents: rows,
  });
});

app.post('/api/poll', async (req, res) => {
  pollWatchlistOnce();
  res.json({ success: true, message: 'Watchlist poll triggered' });
});

app.listen(PORT, HOST, () => {
  console.log(`[bridge] RSS bridge listening on ${BASE_URL} (plain HTTP for uTorrent 2.2.1)`);
  console.log(`[bridge] Watching: ${TORRENT_DIR} | Archive: ${ARCHIVE_DIR}`);
  // First poll shortly after boot, then on the interval.
  setTimeout(pollWatchlistOnce, 10 * 1000);
  setInterval(pollWatchlistOnce, POLL_INTERVAL_MS);
});
