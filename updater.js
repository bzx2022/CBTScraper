// CBTScraper auto-updater — checks GitHub Releases, downloads and installs updates.
// Local-only design: files are swapped in place (user data is never touched),
// then the user restarts the SPA + bridge service to load the new code.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const REPO = 'bzx2022/CBTScraper';
const ROOT_DIR = __dirname;
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;

// Never overwritten by an update: secrets, personal state, caches,
// downloads, dependencies, VCS metadata, service binaries, past packages.
const PRESERVED_TOP_LEVEL = new Set([
    'config.json', 'watchlist.json', 'ratings-cache.json',
    'torrents', 'torrents_archive', 'node_modules', '.git',
    'dist', 'update-backup', '*.log'
]);
const PRESERVED_SUFFIXES = [
    'rss-bridge/db.json', 'rss-bridge/daemon', 'rss-bridge/node_modules'
];

function localVersion() {
    try {
        return require(path.join(ROOT_DIR, 'package.json')).version || '0.0.0';
    } catch (_) {
        return '0.0.0';
    }
}

// -1 if a<b, 0 if equal, 1 if a>b. Handles "1.0.0" and "v1.0.0".
function compareVersions(a, b) {
    const norm = (v) => String(v || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
    const pa = norm(a);
    const pb = norm(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0;
        const y = pb[i] || 0;
        if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
}

async function checkForUpdate() {
    const current = localVersion();
    const res = await fetch(API_LATEST, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CBTScraper-updater' }
    });
    if (res.status === 404) {
        return { current, latest: null, available: false, message: 'No releases published yet.' };
    }
    if (!res.ok) throw new Error(`Release check failed: status ${res.status}`);
    const rel = await res.json();
    const latest = (rel.tag_name || '').replace(/^v/i, '');
    const available = compareVersions(current, latest) < 0;
    return {
        current,
        latest,
        available,
        url: rel.html_url || null,
        publishedAt: rel.published_at || null,
        notes: (rel.body || '').slice(0, 2000)
    };
}

function isPreserved(relativeName) {
    const parts = relativeName.split('/');
    if (PRESERVED_TOP_LEVEL.has(parts[0])) return true;
    const normalized = relativeName.replace(/\\/g, '/');
    return PRESERVED_SUFFIXES.some((s) => normalized === s || normalized.startsWith(s + '/'));
}

async function downloadAndApply() {
    const info = await checkForUpdate();
    if (!info.available) return { ...info, updated: false };

    // Fetch full release to locate the zip asset.
    const res = await fetch(API_LATEST, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CBTScraper-updater' }
    });
    const rel = await res.json();
    const asset = (rel.assets || []).find((a) => /\.zip$/i.test(a.name || ''));
    if (!asset || !asset.browser_download_url) {
        throw new Error('Latest release has no .zip asset to install.');
    }

    const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cbtscraper-update-'));
    const zipPath = path.join(tmpDir, asset.name);
    const dl = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'CBTScraper-updater' } });
    if (!dl.ok) throw new Error(`Asset download failed: status ${dl.status}`);
    fs.writeFileSync(zipPath, Buffer.from(await dl.arrayBuffer()));

    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    if (!entries.some((e) => e.entryName === 'package.json' || e.entryName.endsWith('/package.json'))) {
        throw new Error('Downloaded asset failed verification (no package.json inside).');
    }

    // Strip a single top-level folder if the zip was packed with one.
    const roots = new Set(entries.map((e) => e.entryName.split('/')[0]));
    const stripPrefix = roots.size === 1 && ![...roots][0].includes('.') ? [...roots][0] + '/' : '';

    const backupDir = path.join(ROOT_DIR, 'update-backup', new Date().toISOString().replace(/[:.]/g, '-'));
    let installed = 0;
    let packageJsonChanged = false;
    for (const entry of entries) {
        let rel = entry.entryName;
        if (stripPrefix && rel.startsWith(stripPrefix)) rel = rel.slice(stripPrefix.length);
        if (!rel || isPreserved(rel)) continue;
        const dest = path.join(ROOT_DIR, rel);
        if (fs.existsSync(dest)) {
            const backupPath = path.join(backupDir, rel);
            fs.mkdirSync(path.dirname(backupPath), { recursive: true });
            fs.copyFileSync(dest, backupPath);
        } else {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
        }
        fs.writeFileSync(dest, entry.getData());
        installed++;
        if (rel === 'package.json' || rel === 'rss-bridge/package.json') packageJsonChanged = true;
    }

    if (packageJsonChanged) {
        execSync('npm install', { cwd: ROOT_DIR, stdio: 'inherit', shell: true });
        execSync('npm install', { cwd: path.join(ROOT_DIR, 'rss-bridge'), stdio: 'inherit', shell: true });
    }

    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }

    return {
        ...info,
        updated: true,
        installedFiles: installed,
        backupDir,
        needsRestart: [
            'SPA: stop it (Ctrl+C) and re-run start.ps1 / StartCBTScraper.bat',
            'RSS bridge: double-click RestartRSSBridge.bat'
        ]
    };
}

module.exports = { localVersion, compareVersions, checkForUpdate, downloadAndApply };
