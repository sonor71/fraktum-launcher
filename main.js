// main.js — Fraktum Launcher
// Clean Electron main process: window, IPC, local saves, game launch, downloads, auto-update.

const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { spawn } = require('child_process');

// Russia/unstable-provider hardening: Electron/Chromium can break on HTTP/2/QUIC
// with Cloudflare/GitHub/Supabase routes. Node HTTPS still uses HTTP/1.1.
try {
  app.commandLine.appendSwitch('disable-http2');
  app.commandLine.appendSwitch('disable-quic');
} catch (_e) {}


// Profiles must be configured before reading app.getPath('userData').
const profileArg = (process.argv.find((a) => a.startsWith('--profile=')) || '').split('=')[1];
if (profileArg) {
  const safeProfile = String(profileArg).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'default';
  const base = path.join(app.getPath('appData'), 'Fraktum Launcher');
  app.setPath('userData', path.join(base, safeProfile));
}

let log;
try {
  log = require('electron-log');
  log.initialize?.();
} catch (_e) {
  log = {
    info: console.log.bind(console, '[INFO]'),
    warn: console.warn.bind(console, '[WARN]'),
    error: console.error.bind(console, '[ERROR]'),
    debug: console.debug.bind(console, '[DEBUG]'),
    transports: { file: { level: 'info' } },
  };
}

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.logger = log;
  if (autoUpdater.logger?.transports?.file) autoUpdater.logger.transports.file.level = 'info';
  log.info('[Updater] electron-updater initialized');
} catch (e) {
  log.warn('[Updater] electron-updater unavailable:', String(e?.message || e));
}

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
let mainWin = null;
let extractZip = null;
try {
  extractZip = require('extract-zip');
} catch (_e) {
  extractZip = null;
}

const userDir = app.getPath('userData');
const cfgFile = path.join(userDir, 'config.json');
const savesDir = path.join(userDir, 'saves');
const gamesDir = path.join(userDir, 'games');

const CARD_GAME_OWNER = 'sonor71';
const CARD_GAME_REPO = 'fraktum-tcg';
const CARD_GAME_RELEASE_ENDPOINT = `https://api.github.com/repos/${CARD_GAME_OWNER}/${CARD_GAME_REPO}/releases/latest`;
const CARD_GAME_ASSET_RE = /^fraktum-game-v[0-9][a-zA-Z0-9._-]*\.zip$/i;
const cardGameDir = path.join(gamesDir, 'fraktum-card-game');
const cardGameZip = path.join(cardGameDir, 'fraktum-game.zip');
const cardGameExtractDir = path.join(cardGameDir, 'current');
let cardGameServer = null;
let cardGameServerUrl = null;

// Reusable HTTPS agent. GitHub/Supabase downloads are noticeably slower when
// every request opens a fresh TLS connection, especially through VPN.
const downloadAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 8,
  maxFreeSockets: 4,
  timeout: 300000,
});

function readJSON(file, def = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) {
    return def;
  }
}

function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function getCfg() {
  return readJSON(cfgFile, { exePath: null });
}

function setCfg(patch) {
  writeJSON(cfgFile, { ...getCfg(), ...patch });
}

const launcherCfgCandidates = [
  path.join(app.getPath('userData'), 'launcher.config.json'),
  path.join(path.dirname(process.execPath), 'launcher.config.json'),
  path.join(__dirname, 'launcher.config.json'),
];

const launcherCfgFile = launcherCfgCandidates[0];

function getLauncherConfig() {
  for (const file of launcherCfgCandidates) {
    const fileCfg = readJSON(file, null);
    if (fileCfg && typeof fileCfg === 'object') return fileCfg;
  }
  return {};
}

function getCardGameConfig() {
  const cfg = getLauncherConfig().cardGame || {};
  return {
    owner: String(cfg.githubOwner || process.env.FRAKTUM_CARD_GAME_GITHUB_OWNER || CARD_GAME_OWNER).trim(),
    repo: String(cfg.githubRepo || process.env.FRAKTUM_CARD_GAME_GITHUB_REPO || CARD_GAME_REPO).trim(),
    releaseEndpoint: String(cfg.releaseEndpoint || process.env.FRAKTUM_CARD_GAME_RELEASE_ENDPOINT || '').trim(),
    releaseTag: String(cfg.releaseTag || process.env.FRAKTUM_CARD_GAME_RELEASE_TAG || '').trim(),
    directZipUrl: String(cfg.directZipUrl || process.env.FRAKTUM_CARD_GAME_ZIP_URL || '').trim(),
    directZipVersion: String(cfg.directZipVersion || process.env.FRAKTUM_CARD_GAME_ZIP_VERSION || 'manual').trim(),
    assetRegex: String(cfg.assetRegex || '^fraktum-game-v[0-9][a-zA-Z0-9._-]*\\.zip$').trim(),
    githubToken: String(cfg.githubToken || process.env.FRAKTUM_GITHUB_TOKEN || process.env.GH_TOKEN || '').trim(),
    // Prefer GitHub's browser_download_url because it redirects to a fast signed CDN URL.
    // The API asset URL is kept as a fallback for private repos.
    useApiAssetDownload: Boolean(cfg.useApiAssetDownload),
    downloadTimeoutMs: Math.max(30000, Number(cfg.downloadTimeoutMs || 300000)),
  };
}

function makeGitHubError(error, cfg) {
  const status = Number(error?.statusCode || 0);
  if (status === 404) {
    return new Error(
      `GitHub Release не найден для ${cfg.owner}/${cfg.repo}. ` +
      `Проверь token для private repo и точный tag в launcher.config.json -> cardGame.releaseTag. ` +
      `Для твоего релиза нужен releaseTag: "game-v0.1.0". ` +
      `Можно обойти это через launcher.config.json -> cardGame.directZipUrl.`
    );
  }
  return error;
}

function safeBasename(value, fallback = 'file') {
  return String(value || fallback).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || fallback;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWin) return;
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.focus();
  });
}


function injectMouseSafetyCss() { 
    const currentUrl = mainWin?.webContents?.getURL?.() || '';
  if (!currentUrl.startsWith('file://') || currentUrl.includes('/games/fraktum-card-game/')) {
    return;
  }

  // дальше старый код функции
  if (!mainWin || mainWin.isDestroyed()) return;

  // Emergency Electron UI fix:
  // If any page inside the launcher/game is accidentally marked as a draggable
  // region or has pointer-events disabled at the root, mouse clicks can stop
  // working while Tab/Enter still works. This restores mouse input for both the
  // launcher UI and the downloaded React game.
  const css = `
    html, body, #root, #app, .app, main,
    .shell, .fraktumShell, .demo-page, .profilePage, .playRoot,
    .matchPage, .matchArenaShell, .matchArenaFrame, .matchBoardPanel,
    .matchPlayerHandZone, .playerHandFan, .playerHandCard,
    .marketRoot, .deckRoot, .hubRoot, .collectionRoot {
      pointer-events: auto !important;
      -webkit-app-region: no-drag !important;
    }

    button, input, textarea, select, option, a, label, summary,
    [role="button"], [role="tab"], [role="link"], [tabindex], [onclick],
    [data-clickable], [data-slot-index], [data-card-id], [data-card-base-id],
    .clickable, .btn, .button, .nav-item, .tab, .card,
    .auth-card, .game-card, .profile-card, .friend-card, .menu-button,
    .launcher-button, .primary-button, .secondary-button,
    .playActionBtn, .matchGoldButton, .matchGhostButton, .matchBackButton,
    .matchCardView, .marketInventoryCard, .deckCard, .deckSlot {
      pointer-events: auto !important;
      -webkit-app-region: no-drag !important;
    }

    .titlebar, .window-drag, .drag-region, [data-drag-region="true"] {
      -webkit-app-region: drag;
    }

    .titlebar button, .window-drag button, .drag-region button,
    [data-drag-region="true"] button {
      -webkit-app-region: no-drag !important;
    }
  `;

  mainWin.webContents.insertCSS(css).catch((e) => {
    log.warn('[UI] mouse safety CSS inject failed:', String(e?.message || e));
  });

  mainWin.webContents.executeJavaScript(`
    try {
      document.documentElement.style.pointerEvents = 'auto';
      document.body.style.pointerEvents = 'auto';
      document.querySelectorAll('[inert]').forEach((el) => el.removeAttribute('inert'));
      window.dispatchEvent(new CustomEvent('fraktum:launcher-mouse-ready'));
    } catch (_) {}
  `, true).catch(() => {});
}

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1280,
    height: 780,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0a0f1b',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: !app.isPackaged,
    },
  });

  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWin.webContents.on('will-navigate', (event, url) => {
    const isLauncherFile = url.startsWith('file://');
    const isLocalGame = /^http:\/\/(127\.0\.0\.1|localhost):\d+\//i.test(url);
    if (!isLauncherFile && !isLocalGame) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  mainWin.on('closed', () => {
    mainWin = null;
  });

  mainWin.webContents.on('dom-ready', injectMouseSafetyCss);

  mainWin.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '').toLowerCase();
    if (input.type !== 'keyDown') return;
    if (key === 'f12' || ((input.control || input.meta) && input.shift && key === 'i')) {
      event.preventDefault();
      mainWin.webContents.toggleDevTools();
    }
    if ((input.control || input.meta) && key === 'r') {
      event.preventDefault();
      mainWin.reload();
    }
  });

  mainWin.loadFile(path.join(__dirname, 'index.html'));
  mainWin.once('ready-to-show', () => {
    try {
      mainWin.setIgnoreMouseEvents(false);
      mainWin.setFocusable(true);
      mainWin.focus();
    } catch (_e) {}
    mainWin?.show();
  });

  if (app.isPackaged && autoUpdater) {
    setupAutoUpdate();
    safeCheckForUpdates();
  }
}

function hardenSession() {
  const ses = session.defaultSession;

  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {};
    headers['X-Content-Type-Options'] = ['nosniff'];
    callback({ responseHeaders: headers });
  });

  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = new Set(['clipboard-read']);
    callback(allowed.has(permission));
  });
}

function setupAutoUpdate() {
  if (!autoUpdater) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.removeAllListeners();

  autoUpdater.on('checking-for-update', () => {
    log.info('[Updater] checking');
    sendToRenderer('update:status', { state: 'checking' });
  });

  autoUpdater.on('update-downloaded', (info) => {
  log.info('[Updater] downloaded', info);
  sendToRenderer('update:status', { state: 'downloaded', version: info?.version || null });

  try {
    const res = dialog.showMessageBoxSync(mainWin, {
      type: 'question',
      buttons: ['Перезапустить сейчас', 'Позже'],
      defaultId: 0,
      cancelId: 1,
      message: `Доступна новая версия ${info?.version || ''}. Установить сейчас?`
    });

    if (res === 0) {
      autoUpdater.quitAndInstall();
    }
  } catch (e) {
    log.error('[Updater] update dialog failed', e);
  }
});

  autoUpdater.on('update-not-available', () => {
    log.info('[Updater] none');
    sendToRenderer('update:status', { state: 'none' });
  });

  autoUpdater.on('download-progress', (p) => {
    sendToRenderer('update:progress', {
      percent: Math.round(p.percent || 0),
      transferred: p.transferred || 0,
      total: p.total || 0,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('[Updater] downloaded', info);
    sendToRenderer('update:status', { state: 'downloaded', version: info?.version || null });
  });

  autoUpdater.on('error', (err) => {
    log.error('[Updater] error', err);
    sendToRenderer('update:status', { state: 'error', error: String(err?.message || err) });
  });
}

async function safeCheckForUpdates() {
  if (!autoUpdater) return { ok: false, reason: 'updater-disabled' };
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (e) {
    log.error('[Updater] check failed', e);
    sendToRenderer('update:status', { state: 'error', error: String(e?.message || e) });
    return { ok: false, error: String(e?.message || e) };
  }
}

function sendToRenderer(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
}

function httpsGet(url, { headers = {}, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.get(target, {
      agent: downloadAgent,
      highWaterMark: 1024 * 1024,
      headers: {
        'User-Agent': 'FraktumLauncher/1.1.7',
        Accept: 'application/vnd.github+json, application/json, */*',
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => resolve(res));

    req.on('timeout', () => {
      req.destroy(new Error(`Request timeout: ${url}`));
    });
    req.on('error', reject);
  });
}

async function fetchJson(url, { headers = {} } = {}) {
  const res = await httpsGet(url, { headers });
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    return fetchJson(res.headers.location, { headers });
  }
  const chunks = [];
  for await (const chunk of res) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  if (res.statusCode !== 200) {
    const err = new Error(`GitHub API failed: HTTP ${res.statusCode} ${body.slice(0, 300)}`);
    err.statusCode = res.statusCode;
    err.body = body;
    err.url = url;
    throw err;
  }
  return JSON.parse(body);
}

function downloadToFile(url, destination, { onProgress, headers = {}, redirectCount = 0, timeoutMs = 300000, expectedTotal = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (!/^https:\/\//i.test(url)) {
      reject(new Error('Only HTTPS downloads are allowed'));
      return;
    }
    if (redirectCount > 8) {
      reject(new Error('Download failed: too many redirects'));
      return;
    }

    const target = new URL(url);
    const requestHeaders = {
      'User-Agent': 'FraktumLauncher/1.1.7',
      Accept: 'application/octet-stream, application/json, */*',
      ...headers,
    };

    const req = https.get(target, {
      agent: downloadAgent,
      highWaterMark: 1024 * 1024,
      headers: requestHeaders,
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).toString();
        const nextHost = new URL(nextUrl).hostname;
        const currentHost = target.hostname;
        const nextHeaders = { ...headers };

        // GitHub private release assets usually redirect to a signed CDN URL.
        // The signed URL already contains access data. Authorization on the CDN
        // host can slow down or break the download on some VPN/proxy routes.
        if (nextHost !== currentHost) {
          delete nextHeaders.Authorization;
          delete nextHeaders.authorization;
          if (nextHeaders.Accept === 'application/octet-stream') delete nextHeaders.Accept;
        }

        downloadToFile(nextUrl, destination, {
          onProgress,
          headers: nextHeaders,
          redirectCount: redirectCount + 1,
          timeoutMs,
          expectedTotal,
        }).then(resolve, reject);
        return;
      }

      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 300);
          const extra = res.statusCode === 404 && /github\.com/i.test(url)
            ? ' Для private GitHub Release нужна авторизация: проверь githubToken или используй API asset download.'
            : '';
          reject(new Error(`Download failed: HTTP ${res.statusCode} ${body}${extra}`));
        });
        return;
      }

      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const tmpDestination = `${destination}.part`;
      fs.rmSync(tmpDestination, { force: true });
      fs.rmSync(destination, { force: true });

      const file = fs.createWriteStream(tmpDestination, { highWaterMark: 1024 * 1024 });
      const headerTotal = Number(res.headers['content-length'] || 0);
      const total = headerTotal > 0 ? headerTotal : Number(expectedTotal || 0);
      let transferred = 0;
      let lastProgressAt = 0;
      let lastPercent = -1;

      const emitProgress = (force = false) => {
        if (typeof onProgress !== 'function') return;
        const now = Date.now();
        const percent = total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0;
        // IPC spam is a real slowdown in Electron. Send progress no more than
        // ~8 times per second, plus every percent change and final 100%.
        if (!force && percent === lastPercent && now - lastProgressAt < 125) return;
        lastProgressAt = now;
        lastPercent = percent;
        onProgress({ transferred, total, percent });
      };

      res.on('data', (chunk) => {
        transferred += chunk.length;
        emitProgress(false);
      });

      res.on('error', (err) => {
        file.destroy();
        fs.rm(tmpDestination, { force: true }, () => {});
        reject(err);
      });

      file.on('error', (err) => {
        res.destroy();
        fs.rm(tmpDestination, { force: true }, () => {});
        reject(err);
      });

      file.on('finish', () => {
        file.close((err) => {
          if (err) {
            fs.rm(tmpDestination, { force: true }, () => {});
            reject(err);
            return;
          }
          try {
            fs.renameSync(tmpDestination, destination);
            transferred = Math.max(transferred, fs.statSync(destination).size);
            emitProgress(true);
            resolve({ ok: true, path: destination, bytes: transferred });
          } catch (renameError) {
            fs.rm(tmpDestination, { force: true }, () => {});
            reject(renameError);
          }
        });
      });

      res.pipe(file);
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Download timeout: ${url}`));
    });
    req.on('error', reject);
  });
}

function runPowershell(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', command, ...args], {
      windowsHide: true,
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`PowerShell failed with exit code ${code}`));
    });
  });
}

async function extractZipFile(zipPath, destination) {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });

  if (extractZip) {
    await extractZip(zipPath, { dir: destination });
    return true;
  }

  if (!isWin) throw new Error('extract-zip is not installed and PowerShell fallback is Windows-only');
  await runPowershell('Expand-Archive', ['-LiteralPath', zipPath, '-DestinationPath', destination, '-Force']);
  return true;
}

async function getLatestCardGameRelease() {
  const cfg = getCardGameConfig();

  // Fast manual mode: paste a direct ZIP URL into launcher.config.json.
  // ZIP must contain built web files with index.html at archive root.
  // Private GitHub release links return 404 unless the token is passed.
  if (cfg.directZipUrl) {
    const directHeaders = {};
    if (cfg.githubToken && /github\.com/i.test(cfg.directZipUrl)) {
      directHeaders.Authorization = `Bearer ${cfg.githubToken}`;
      directHeaders.Accept = 'application/octet-stream';
    }

    return {
      tag: cfg.directZipVersion || cfg.releaseTag || 'manual',
      name: path.basename(new URL(cfg.directZipUrl).pathname) || 'fraktum-game.zip',
      url: cfg.directZipUrl,
      fallbackUrl: '',
      downloadHeaders: directHeaders,
      fallbackHeaders: directHeaders,
      size: 0,
      publishedAt: null,
      source: 'directZipUrl',
      privateDownload: Boolean(cfg.githubToken),
    };
  }

  const endpoint = cfg.releaseEndpoint || (cfg.releaseTag
    ? `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/releases/tags/${encodeURIComponent(cfg.releaseTag)}`
    : `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/releases/latest`);
  const headers = {};
  if (cfg.githubToken) headers.Authorization = `Bearer ${cfg.githubToken}`;

  let release;
  try {
    release = await fetchJson(endpoint, { headers });
  } catch (error) {
    throw makeGitHubError(error, cfg);
  }

  const assets = Array.isArray(release.assets) ? release.assets : [];
  let assetRegex;
  try {
    assetRegex = new RegExp(cfg.assetRegex, 'i');
  } catch (_e) {
    assetRegex = CARD_GAME_ASSET_RE;
  }

  const asset = assets.find((a) => assetRegex.test(String(a.name || '')))
    || assets.find((a) => /fraktum.*game.*\.zip$/i.test(String(a.name || '')))
    || assets.find((a) => /\.zip$/i.test(String(a.name || '')));

  if (!asset?.browser_download_url) {
    throw new Error(
      `В Release ${cfg.owner}/${cfg.repo} нет ZIP-ассета карточной игры. ` +
      `Загрузи в GitHub Release архив, где index.html лежит в корне, ` +
      `или пропиши прямую ссылку на ZIP в launcher.config.json -> cardGame.directZipUrl.`
    );
  }

  const downloadHeaders = {};
  if (cfg.githubToken) {
    downloadHeaders.Authorization = `Bearer ${cfg.githubToken}`;
    downloadHeaders.Accept = 'application/octet-stream';
  }

  const primaryUrl = String((cfg.useApiAssetDownload && cfg.githubToken && asset.url)
    ? asset.url
    : asset.browser_download_url);
  const fallbackUrl = String((cfg.githubToken && asset.url && primaryUrl !== asset.url) ? asset.url : '');

  return {
    tag: String(release.tag_name || 'unknown'),
    name: String(asset.name || 'fraktum-game.zip'),
    url: primaryUrl,
    fallbackUrl,
    downloadHeaders,
    fallbackHeaders: downloadHeaders,
    size: Number(asset.size || 0),
    publishedAt: release.published_at || null,
    source: endpoint,
    privateDownload: Boolean(cfg.githubToken),
  };
}

function getCardGameStatusSync() {
  const cfg = getCfg();
  const indexFile = path.join(cardGameExtractDir, 'index.html');
  return {
    installed: fs.existsSync(indexFile),
    version: cfg.cardGameVersion || null,
    asset: cfg.cardGameAsset || null,
    installedAt: cfg.cardGameInstalledAt || null,
    dir: cardGameExtractDir,
    url: cardGameServerUrl,
  };
}

async function getCardGameStatus({ checkLatest = false } = {}) {
  const local = getCardGameStatusSync();
  if (!checkLatest) {
    return {
      ...local,
      latestVersion: null,
      latestAsset: null,
      latestSize: 0,
      updateAvailable: false,
      needsInstall: !local.installed,
    };
  }

  try {
    const latest = await getLatestCardGameRelease();
    const updateAvailable = !local.installed || !local.version || local.version !== latest.tag;
    return {
      ...local,
      latestVersion: latest.tag,
      latestAsset: latest.name,
      latestSize: latest.size,
      latestPublishedAt: latest.publishedAt,
      updateAvailable,
      needsInstall: !local.installed,
    };
  } catch (error) {
    return {
      ...local,
      latestVersion: null,
      latestAsset: null,
      latestSize: 0,
      updateAvailable: false,
      needsInstall: !local.installed,
      latestError: String(error?.message || error),
    };
  }
}

async function installOrUpdateCardGame({ force = false } = {}) {
  fs.mkdirSync(cardGameDir, { recursive: true });
  sendToRenderer('game:status', { state: 'checking', gameId: 'cards' });

  const latest = await getLatestCardGameRelease();
  const current = getCardGameStatusSync();
  if (!force && current.installed && current.version === latest.tag) {
    sendToRenderer('game:status', { state: 'ready', gameId: 'cards', version: latest.tag, cached: true });
    return { ok: true, version: latest.tag, cached: true, dir: cardGameExtractDir };
  }

  sendToRenderer('game:status', { state: 'downloading', gameId: 'cards', version: latest.tag, asset: latest.name });
  try {
    await downloadToFile(latest.url, cardGameZip, {
      headers: latest.downloadHeaders || {},
      timeoutMs: getCardGameConfig().downloadTimeoutMs,
      expectedTotal: latest.size || 0,
      onProgress: (progress) => sendToRenderer('game:progress', { gameId: 'cards', ...progress }),
    });
  } catch (primaryError) {
    if (!latest.fallbackUrl) throw primaryError;
    log.warn('[Game] primary release download failed, trying API asset fallback:', String(primaryError?.message || primaryError));
    sendToRenderer('game:status', { state: 'downloading', gameId: 'cards', version: latest.tag, asset: latest.name, fallback: true });
    await downloadToFile(latest.fallbackUrl, cardGameZip, {
      headers: latest.fallbackHeaders || latest.downloadHeaders || {},
      timeoutMs: getCardGameConfig().downloadTimeoutMs,
      expectedTotal: latest.size || 0,
      onProgress: (progress) => sendToRenderer('game:progress', { gameId: 'cards', ...progress }),
    });
  }

  if (!fs.existsSync(cardGameZip)) {
    throw new Error(`ZIP was not saved after download: ${cardGameZip}`);
  }
  const downloadedSize = fs.statSync(cardGameZip).size;
  if (downloadedSize < 1024) {
    throw new Error(`Downloaded ZIP is too small (${downloadedSize} bytes). Check GitHub token, release asset and network.`);
  }

  sendToRenderer('game:status', { state: 'extracting', gameId: 'cards', version: latest.tag });
  await extractZipFile(cardGameZip, cardGameExtractDir);

  const indexFile = path.join(cardGameExtractDir, 'index.html');
  if (!fs.existsSync(indexFile)) {
    throw new Error('Downloaded game archive does not contain index.html at root');
  }

  setCfg({ cardGameVersion: latest.tag, cardGameAsset: latest.name, cardGameInstalledAt: new Date().toISOString() });
  sendToRenderer('game:status', { state: 'ready', gameId: 'cards', version: latest.tag, cached: false });
  return { ok: true, version: latest.tag, cached: false, dir: cardGameExtractDir };
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm',
};

function serveStaticFile(rootDir, req, res) {
  try {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    let pathname = decodeURIComponent(requestUrl.pathname || '/');
    if (pathname === '/') pathname = '/index.html';

    const root = path.resolve(rootDir);
    let filePath = path.resolve(path.join(root, pathname));
    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // SPA/HashRouter fallback. This also keeps direct route reloads safe.
      filePath = path.join(root, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(error?.message || error));
  }
}

function startCardGameServer() {
  if (cardGameServer && cardGameServerUrl) return Promise.resolve(cardGameServerUrl);

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => serveStaticFile(cardGameExtractDir, req, res));
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      cardGameServer = server;
      cardGameServerUrl = `http://127.0.0.1:${address.port}/`;
      log.info('[Cards] local server started:', cardGameServerUrl);
      resolve(cardGameServerUrl);
    });
  });
}

async function getLauncherSupabaseSessionForGame() {
  if (!mainWin || mainWin.isDestroyed()) return null;

  try {
    // Executed while the launcher page is still loaded. It can read the
    // launcher Supabase session before we navigate the same BrowserWindow to
    // the downloaded game URL.
    const session = await mainWin.webContents.executeJavaScript(`
      (async () => {
        try {
          const raw = await window.sb?.getSession?.();
          if (!raw || !raw.access_token || !raw.refresh_token) return null;
          return {
            access_token: raw.access_token,
            refresh_token: raw.refresh_token,
            expires_at: raw.expires_at || null,
            token_type: raw.token_type || 'bearer',
            user: raw.user || null
          };
        } catch (_e) {
          return null;
        }
      })()
    `, true);

    return session && session.access_token && session.refresh_token ? session : null;
  } catch (error) {
    log.warn('[Auth] launcher session handoff failed:', String(error?.message || error));
    return null;
  }
}

function encodeSessionForGame(session) {
  if (!session || !session.access_token || !session.refresh_token) return '';
  try {
    return Buffer.from(JSON.stringify({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at || null,
      token_type: session.token_type || 'bearer',
      user: session.user || null,
    }), 'utf8').toString('base64url');
  } catch (_e) {
    return '';
  }
}

function appendGameLaunchParams(baseUrl, { session, source = 'launcher' } = {}) {
  const url = new URL(baseUrl);
  url.searchParams.set('fraktumSource', source);

  const encodedSession = encodeSessionForGame(session);
  if (encodedSession) url.searchParams.set('fraktumSession', encodedSession);

  // HashRouter still starts at /, but query params remain readable by the game.
  if (!url.hash) url.hash = '#/';
  return url.toString();
}

function waitForGameDomReady() {
  if (!mainWin || mainWin.isDestroyed()) return Promise.resolve();

  return new Promise((resolve) => {
    const done = () => {
      try {
        mainWin.setIgnoreMouseEvents(false);
        mainWin.setFocusable(true);
        mainWin.focus();
      } catch (_e) {}
      injectMouseSafetyCss();
      resolve();
    };

    mainWin.webContents.once('dom-ready', done);
    setTimeout(done, 1600);
  });
}

async function openCardGame({ forceUpdate = false } = {}) {
  const install = await installOrUpdateCardGame({ force: forceUpdate });
  const url = await startCardGameServer();
  const launcherSession = await getLauncherSupabaseSessionForGame();
  const launchUrl = appendGameLaunchParams(url, { session: launcherSession, source: 'launcher' });

  sendToRenderer('game:status', { state: 'launching', gameId: 'cards', version: install.version, url });
  try { mainWin.webContents.closeDevTools(); } catch (_e) {}
  await mainWin.loadURL(launchUrl);
  await waitForGameDomReady();
  return { ok: true, launched: true, gameId: 'cards', url, version: install.version, authHandoff: Boolean(launcherSession) };
}

function setupIpc() {
  ipcMain.handle('select-exe', async () => {
    const filters = isWin
      ? [{ name: 'Executable', extensions: ['exe'] }]
      : [{ name: 'Executable', extensions: ['*'] }];

    const { canceled, filePaths } = await dialog.showOpenDialog(mainWin, {
      title: 'Выбери исполняемый файл игры',
      properties: ['openFile'],
      filters,
    });

    if (canceled || !filePaths?.[0]) return null;
    const exePath = filePaths[0];
    setCfg({ exePath });
    return { path: exePath, name: path.basename(exePath) };
  });

  ipcMain.handle('get-exe', async () => {
    const { exePath } = getCfg();
    if (!exePath) return null;
    return { path: exePath, name: path.basename(exePath), exists: fs.existsSync(exePath) };
  });

  ipcMain.handle('run-game', async (_evt, { gameId, args = [], forceUpdate = false } = {}) => {
    const normalizedGameId = String(gameId || '').toLowerCase();
    if (normalizedGameId === 'cards' || normalizedGameId === 'card' || normalizedGameId === 'fraktum-tcg') {
      return openCardGame({ forceUpdate: Boolean(forceUpdate) });
    }

    const { exePath } = getCfg();
    if (!exePath) throw new Error('EXE не выбран');
    if (!fs.existsSync(exePath)) throw new Error('EXE не найден');

    const safeArgs = Array.isArray(args) ? args.map(String).slice(0, 20) : [];
    const child = spawn(exePath, safeArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: path.dirname(exePath),
    });

    child.on('error', (err) => log.error('[Game] launch error', err));
    child.unref();
    return { ok: true, launched: true, gameId: gameId || null };
  });

  ipcMain.handle('save-upload', async (_evt, { slot, name, data }) => {
    const safeSlot = safeBasename(slot, 'slot');
    fs.mkdirSync(savesDir, { recursive: true });
    const dst = path.join(savesDir, `${safeSlot}.zip`);

    try {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.byteLength > 50 * 1024 * 1024) throw new Error('Save file is too large');
      fs.writeFileSync(dst, buf);
      return { ok: true, file: dst, name: name || path.basename(dst) };
    } catch (e) {
      return { ok: false, reason: 'write-failed', error: String(e?.message || e) };
    }
  });

  ipcMain.handle('save-download', async (_evt, { slot }) => {
    const safeSlot = safeBasename(slot, 'slot');
    const src = path.join(savesDir, `${safeSlot}.zip`);
    if (!fs.existsSync(src)) return { ok: false, reason: 'empty' };

    const { canceled, filePath } = await dialog.showSaveDialog(mainWin, {
      title: `Сохранить ${safeSlot}.zip`,
      defaultPath: `${safeSlot}.zip`,
    });

    if (canceled || !filePath) return { ok: false, reason: 'cancel' };

    try {
      fs.copyFileSync(src, filePath);
      return { ok: true, filePath };
    } catch (e) {
      return { ok: false, reason: 'copy-failed', error: String(e?.message || e) };
    }
  });

  ipcMain.handle('download-novel', async (_evt, { signedUrl, version, fileName } = {}) => {
    if (!signedUrl) throw new Error('Нет ссылки на сборку');
    const safeVersion = safeBasename(version || 'latest', 'latest');
    const safeFile = safeBasename(fileName || 'FraktumNovel-win.zip', 'FraktumNovel-win.zip');
    const dir = path.join(gamesDir, 'novel', safeVersion);
    fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(dir, safeFile);
    await downloadToFile(String(signedUrl), zip);
    return { ok: true, zip, dir };
  });

  ipcMain.handle('card-game:status', async (_evt, payload = {}) => getCardGameStatus({ checkLatest: Boolean(payload?.checkLatest) }));

  ipcMain.handle('card-game:install', async (_evt, { force = false } = {}) => {
    try {
      return await installOrUpdateCardGame({ force: Boolean(force) });
    } catch (e) {
      log.error('[Cards] install failed', e);
      sendToRenderer('game:status', { state: 'error', gameId: 'cards', error: String(e?.message || e) });
      return { ok: false, error: String(e?.message || e) };
    }
  });

  ipcMain.handle('card-game:open', async (_evt, { forceUpdate = false } = {}) => {
    try {
      return await openCardGame({ forceUpdate: Boolean(forceUpdate) });
    } catch (e) {
      log.error('[Cards] launch failed', e);
      sendToRenderer('game:status', { state: 'error', gameId: 'cards', error: String(e?.message || e) });
      return { ok: false, error: String(e?.message || e) };
    }
  });

  ipcMain.handle('open-external', async (_evt, url) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle('get-platform', () => process.platform);
  ipcMain.handle('app-version', () => app.getVersion());
  ipcMain.handle('launcher-config-path', () => launcherCfgFile);
  ipcMain.handle('launcher-config', () => getLauncherConfig());
  ipcMain.handle('user-data-path', () => app.getPath('userData'));

  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) return { ok: false, dev: true, message: 'Auto-update доступен только в собранной версии.' };
    return safeCheckForUpdates();
  });

  ipcMain.handle('update:quitAndInstall', () => {
    if (!app.isPackaged) return { ok: false, dev: true };
    if (!autoUpdater) return { ok: false, message: 'Модуль автообновлений отсутствует.' };
    try {
      autoUpdater.quitAndInstall();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });
}

app.setAppUserModelId('com.fraktum.launcher');

app.whenReady().then(() => {
  fs.mkdirSync(savesDir, { recursive: true });
  fs.mkdirSync(gamesDir, { recursive: true });
  hardenSession();
  setupIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (cardGameServer) {
    try { cardGameServer.close(); } catch (_e) {}
    cardGameServer = null;
    cardGameServerUrl = null;
  }
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
