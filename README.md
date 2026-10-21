# CBTScraper — Milkie.cc Torrent Scraper SPA + uTorrent RSS Bridge

A local-only web app that scrapes the latest TV and movie listings from
**milkie.cc**, shows the 20 most-downloaded releases of the last 7 days plus
everything from the last 48 hours in a dark-themed UI, and tracks a personal TV
**watchlist** with automatic `.torrent` downloads. Movies can be expanded into
every available release of the same title. A companion background service
exposes new watchlist episodes as a legacy-compatible RSS feed for
**uTorrent 2.2.1**.

## Features

- **Top-20 listings** — TV Shows and Movies from the last 7 days, sorted by
  download count, each in its own scrollable box (single-line rows with size,
  seeders/leechers, age, and direct `.torrent` download button).
- **Latest (48h) listings** — TV and movie releases from the last 48 hours,
  paged 100 at a time. TV rows can be added to the watchlist or expanded into
  the show's full episode list; movie rows show the IMDb rating/genre line.
- **All releases of a movie** — the list button on any movie row opens every
  available release of that title (any resolution, source, or release group),
  newest first, each with its own download button.
- **IMDb ratings & genres** — listings are enriched via the OMDb API (rating
  links straight to the IMDb title page). Ratings are cached for 7 days and
  "no rating" results for 24 hours (OMDb lags IMDb on new releases), so missing
  ratings fill in the next day instead of a week later.
- **Watchlist** — add any TV listing with the `+` button. S/E is parsed from
  the release name; when a newer episode appears in a scrape the entry shows
  a **"New Episode Found"** badge and the `.torrent` is auto-downloaded to
  `torrents/`. Each entry has a per-show **preferred resolution**
  (720p/1080p/2160p, default 1080p) with a 24-hour fallback when the preferred
  resolution never appears, plus a per-show **PROPER/REPACK** auto-download
  toggle. Repeat releases of an episode you already downloaded are skipped.
- **Auto-updater** — checks GitHub Releases at startup and daily; Settings →
  Updates installs a newer release in place (user data is preserved) and then
  asks for a restart.
- **Responsive layout** — boxes and modals widen automatically on smaller
  screens, and secondary columns collapse so release titles are not truncated.
- **Raw error log** — a terminal-style box in Settings shows full stack traces
  for local debugging.
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

| Settings section    | Value to paste |
|---------------------|----------------|
| Auth Token          | `authorization: Bearer …` header from milkie.cc DevTools → Network (JWT only, or the full `Bearer …` string) |
| Torrent API Key     | Your milkie API key (bare key, or the full `…/torrent?key=…` URL — the `key=` value is extracted automatically) |
| OMDb Key            | Your OMDb key (bare key, or a full `omdbapi.com/…&apikey=…` sample URL) |

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

## Updating

The app checks GitHub Releases on startup (plus once a day) and logs when a
newer version exists. In the SPA: **gear icon → Updates → Check now**, then
**Download & Install**. The updater downloads the release zip, backs up every
file it replaces into `update-backup/<timestamp>/`, skips all personal state
(secrets, watchlist, caches, torrents, `node_modules`, service files), and runs
`npm install` if dependencies changed. Afterwards restart both processes —
`StartCBTScraper.bat` for the SPA and `RestartRSSBridge.bat` for the service.

## Project layout

```
server.js              SPA backend (scrape proxy, enrichment, watchlist API)
updater.js             GitHub Releases updater (check / download / apply)
public/index.html      SPA frontend (dark UI, modals, error log)
config.json            Local secrets (git-ignored, auto-created)
watchlist.json         Watchlist state (git-ignored)
ratings-cache.json     OMDb metadata cache (git-ignored)
torrents/              Downloaded .torrent files (git-ignored)
torrents_archive/      Torrents already served to uTorrent (git-ignored)
Install.ps1            One-shot installer (deps + Windows Service)
start.ps1              Starts the SPA (installs deps if needed)
StartCBTScraper.bat    Convenience launcher for start.ps1
RestartRSSBridge.bat   Restarts the bridge service (self-elevating)
package-release.ps1    Builds dist/CBTScraper-<version>.zip
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
| GET    | `/api/latest`          | Latest 48h releases, 100/page (`?category=1\|2&pi=N`); movies include `meta` |
| GET    | `/api/search`          | Full-text milkie search (`?query=…`) |
| GET    | `/api/show`            | All episodes of a series, 50/page (`?name=…&pi=N`) |
| GET    | `/api/movie`           | All releases of a movie, 50/page (`?name=…&year=…&pi=N`) |
| GET    | `/api/watchlist`       | Current watchlist |
| POST   | `/api/watchlist`       | Add show (`{ title, torrentId }`) |
| POST   | `/api/watchlist/:id`   | Update entry prefs (`{ resolution, autoProper }`) |
| DELETE | `/api/watchlist/:id`   | Remove entry |
| POST   | `/api/watchlist/:id/ack` | Mark latest episode watched |
| POST   | `/api/set-cookie`      | Save auth token |
| POST   | `/api/set-apikey`      | Save torrent API key |
| POST   | `/api/set-omdbkey`     | Save OMDb key |
| GET    | `/api/config`          | Saved credential status |
| GET    | `/api/update/check`    | Compare local version with the latest GitHub release |
| POST   | `/api/update/apply`    | Download and install the latest release |
