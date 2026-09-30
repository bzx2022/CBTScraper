# CBTScraper — Milkie.cc Torrent Scraper SPA + uTorrent RSS Bridge

A local-only web app that scrapes the latest TV and movie listings from
**milkie.cc**, shows the 20 most-downloaded releases of the last 7 days in a
dark-themed UI, and tracks a personal TV **watchlist** with automatic
`.torrent` downloads. A companion background service exposes new watchlist
episodes as a legacy-compatible RSS feed for **uTorrent 2.2.1**.

## Features

- **Top-20 listings** — TV Shows and Movies from the last 7 days, sorted by
  download count, each in its own scrollable box (single-line rows with size,
  seeders/leechers, age, and direct `.torrent` download button).
- **IMDb ratings & genres** — every listing is enriched via the OMDb API
  (rating links straight to the IMDb title page). Results are cached locally
  for 7 days (`ratings-cache.json`) to stay far under the free quota.
- **Watchlist** — add any TV listing with the `+` button. S/E is parsed from
  the release name; when a newer episode appears in a scrape the entry shows
  a **"New Episode Found"** badge and the `.torrent` is auto-downloaded to
  `torrents/`. Entries can be marked watched or removed.
- **Raw error log** — a terminal-style box at the bottom shows full
  stack traces for local debugging.
- **Credential persistence** — auth token, torrent API key, and OMDb key are
  saved to `config.json` (auto-created) and browser `localStorage`, so they
  survive restarts and reloads.
- **RSS bridge (`rss-bridge/`)** — standalone service for uTorrent 2.2.1:
  polls the watchlist independently of the SPA, serves a strict RSS 2.0 feed
  over plain HTTP with the download URL in `<link>`, and archives each file
  to `torrents_archive/` after uTorrent fetches it (pending → served →
  downloaded, never re-served).

## Prerequisites

- Node.js 18+ and npm
- A milkie.cc account (for the JWT bearer token + torrent API key)
- A free OMDb API key from [omdbapi.com](https://www.omdbapi.com/) (for ratings)

## SPA setup

```powershell
cd "<folder-where-you-put-the-app>"
npm install
npm start        # or double-click StartCBTScraper.bat, which also opens the browser
```

Open `http://localhost:3000`, then click the gear icon (top bar) and open each section:

| Button              | Value to paste |
|---------------------|----------------|
| Set Token           | `authorization: Bearer …` header from milkie.cc DevTools → Network (JWT only, or the full `Bearer …` string) |
| Set Torrent API Key | Your milkie API key (bare key, or the full `…/torrent?key=…` URL — the `key=` value is extracted automatically) |
| Set OMDb Key        | Your OMDb key (bare key, or a full `omdbapi.com/…&apikey=…` sample URL) |

Then click **Fetch Listings**. Keys persist in `config.json` and
`localStorage`.

> Local-only app: `config.json`, `watchlist.json`, `ratings-cache.json`,
> `torrents/` and `torrents_archive/` are git-ignored and never committed.

## RSS bridge setup (uTorrent 2.2.1)

The bridge runs independently of the SPA on plain HTTP
(`http://127.0.0.1:8080`, required — uTorrent 2.2.1 cannot do modern TLS).

```powershell
cd "<app-folder>\rss-bridge"
npm install
node server.js        # foreground test run
```

Endpoints: `/feed.xml` (RSS feed), `/download/:filename` (file delivery),
`/api/status`, `POST /api/poll` (trigger an immediate watchlist check).

**Install as a Windows Service** (elevated PowerShell):

Run `Install.ps1` once from the app folder (right-click → Run with PowerShell).
It checks for Node.js (offers to install it), installs missing/outdated
dependencies for both projects, and offers to install + start the service:

```powershell
.\Install.ps1            # prompted install
.\Install.ps1 -Yes       # accept every prompt
.\Install.ps1 -Mode Uninstall   # remove the Windows Service
```

Double-click `RestartRSSBridge.bat` (in the app folder) any time to restart the service.

Add `http://127.0.0.1:8080/feed.xml` as an RSS feed in uTorrent 2.2.1.
To remove the service: `node uninstall-service.js` from an elevated prompt.

## Project layout

```
server.js              SPA backend (scrape proxy, enrichment, watchlist API)
public/index.html      SPA frontend (dark UI, modals, error log)
config.json            Local secrets (git-ignored, auto-created)
watchlist.json         Watchlist state (git-ignored)
ratings-cache.json     7-day OMDb cache (git-ignored)
torrents/              Downloaded .torrent files (git-ignored)
rss-bridge/
  server.js            RSS bridge service (watcher, feed, archive, poller)
  install-service.js   Windows Service installer (node-windows)
  uninstall-service.js Windows Service remover
  db.json              Feed state DB (git-ignored)
```

## API reference (SPA backend, `http://localhost:3000`)

| Method | Route                  | Purpose |
|--------|------------------------|---------|
| GET    | `/api/scrape`          | Top-20 TV + movies (with `meta`), watchlist check + auto-download |
| GET    | `/api/watchlist`       | Current watchlist |
| POST   | `/api/watchlist`       | Add show (`{ title, torrentId }`) |
| DELETE | `/api/watchlist/:id`   | Remove entry |
| POST   | `/api/watchlist/:id/ack` | Mark latest episode watched |
| POST   | `/api/set-cookie`      | Save auth token |
| POST   | `/api/set-apikey`      | Save torrent API key |
| POST   | `/api/set-omdbkey`     | Save OMDb key |
| GET    | `/api/config`          | Saved credential status |
