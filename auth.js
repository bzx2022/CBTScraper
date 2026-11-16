// Shared milkie.cc session helpers — used by the SPA and the RSS bridge.
// The site issues 60-day JWTs and renews them itself once fewer than 30 days
// remain, via POST /api/v1/auth/sessions/refresh with the current token.

const fs = require('fs');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFRESH_URL = 'https://milkie.cc/api/v1/auth/sessions/refresh';
const SESSION_URL = 'https://milkie.cc/api/v1/auth';
const REFRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function stripBearer(token) {
    return String(token || '').replace(/^Bearer\s+/i, '').trim();
}

function decodeJwtPayload(token) {
    const raw = stripBearer(token);
    const parts = raw.split('.');
    if (parts.length !== 3) return null;
    try {
        const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        const data = JSON.parse(json);
        return data && typeof data === 'object' ? data : null;
    } catch (_) {
        return null;
    }
}

// { hasToken, isJwt, expiresAt (ms), daysLeft, expired, needsRefresh }
function tokenStatus(token) {
    const raw = stripBearer(token);
    if (!raw) return { hasToken: false, isJwt: false, expiresAt: null, daysLeft: null, expired: false, needsRefresh: false };
    const payload = decodeJwtPayload(raw);
    if (!payload || !payload.exp) {
        return { hasToken: true, isJwt: false, expiresAt: null, daysLeft: null, expired: false, needsRefresh: false };
    }
    const expiresAt = payload.exp * 1000;
    const daysLeft = (expiresAt - Date.now()) / (24 * 60 * 60 * 1000);
    return {
        hasToken: true,
        isJwt: true,
        expiresAt,
        daysLeft,
        expired: daysLeft <= 0,
        needsRefresh: daysLeft > 0 && (expiresAt - Date.now()) < REFRESH_WINDOW_MS
    };
}

function readConfig(configPath) {
    try {
        if (fs.existsSync(configPath)) {
            const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (parsed && typeof parsed === 'object') return parsed;
        }
    } catch (err) {
        console.error(`[auth] Could not read ${path.basename(configPath)}: ${err.message}`);
    }
    return {};
}

// Merge-write so the SPA and bridge never clobber each other's fields.
function updateConfig(configPath, patch) {
    const merged = { ...readConfig(configPath), ...patch };
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf8');
    return merged;
}

async function requestRefresh(token) {
    const res = await fetch(REFRESH_URL, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${stripBearer(token)}`,
            accept: 'application/json',
            'user-agent': USER_AGENT
        }
    });
    // milkie answers 304 while the session is still outside its 30-day
    // rotation window: there is simply nothing new to hand back.
    if (res.status === 304) return null;
    if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        throw new Error(`refresh failed (${res.status})${detail ? ': ' + detail : ''}`);
    }
    const data = await res.json().catch(() => null);
    const fresh = data && (data.token || (data.data && data.data.token));
    if (!fresh) throw new Error('refresh returned no token');
    return fresh;
}

async function validateToken(token) {
    const res = await fetch(SESSION_URL, {
        headers: {
            authorization: `Bearer ${stripBearer(token)}`,
            accept: 'application/json',
            'user-agent': USER_AGENT
        }
    });
    if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 200);
        throw new Error(`session rejected (${res.status})${detail ? ': ' + detail : ''}`);
    }
    const data = await res.json().catch(() => null);
    return data || {};
}

function createAuthManager({ configPath, getToken, setToken, log = console }) {
    let inFlight = null;

    function status() {
        return tokenStatus(getToken());
    }

    async function refreshNow(force = false) {
        if (inFlight) return inFlight;
        inFlight = (async () => {
            // The other process may have renewed already — adopt its token first.
            const disk = readConfig(configPath);
            if (disk.sessionToken && disk.sessionToken !== getToken()) setToken(disk.sessionToken);

            const token = getToken();
            if (!token) throw new Error('no auth token saved');
            const current = tokenStatus(token);
            if (!current.isJwt) throw new Error('saved credential is not a JWT; automatic renewal is unavailable');
            if (!force && !current.needsRefresh) return { refreshed: false, ...current };

            const fresh = await requestRefresh(token);
            if (!fresh) {
                // Still outside milkie's rotation window (HTTP 304).
                log.log('[auth] Session still fresh; milkie has no replacement token yet.');
                return { refreshed: false, ...tokenStatus(token) };
            }
            setToken(fresh);
            updateConfig(configPath, {
                sessionToken: fresh,
                tokenRefreshedAt: new Date().toISOString()
            });
            const next = tokenStatus(fresh);
            log.log(`[auth] Token renewed; expires ${new Date(next.expiresAt).toISOString()} (${next.daysLeft.toFixed(1)} days).`);
            return { refreshed: true, ...next };
        })().finally(() => { inFlight = null; });
        return inFlight;
    }

    async function ensureFresh() {
        try {
            const current = status();
            if (!current.hasToken) return;
            if (!current.isJwt) return;
            if (current.expired) {
                log.warn('[auth] Saved token has expired — paste a new one in Settings.');
                return;
            }
            if (current.needsRefresh) await refreshNow(false);
        } catch (err) {
            log.warn(`[auth] Automatic renewal failed: ${err.message}`);
        }
    }

    return { status, refreshNow, ensureFresh };
}

module.exports = {
    REFRESH_WINDOW_MS,
    stripBearer,
    decodeJwtPayload,
    tokenStatus,
    readConfig,
    updateConfig,
    requestRefresh,
    validateToken,
    createAuthManager
};
