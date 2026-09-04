const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let sessionToken = '';
let torrentApiKey = '';

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

// API endpoint to set manual token
app.post('/api/set-cookie', (req, res) => {
    const { cookie } = req.body;
    if (cookie) {
        sessionToken = cookie;
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false, error: 'Token string is required' });
    }
});

// API endpoint to set torrent API key
app.post('/api/set-apikey', (req, res) => {
    const { apiKey } = req.body;
    if (apiKey) {
        torrentApiKey = apiKey;
        res.json({ success: true });
    } else {
        res.status(400).json({ success: false, error: 'API key string is required' });
    }
});

app.get('/api/scrape', async (req, res) => {
    try {
        const [tvShows, movies] = await Promise.all([
            scrapeCategory(2),
            scrapeCategory(1)
        ]);

        res.json({
            success: true,
            tvShows,
            movies
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
