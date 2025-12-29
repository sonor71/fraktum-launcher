// main.js — Fraktum Launcher (prod-ready + автообновления)
// --------------------------------------------------------
// Что умеет:
// - Загружает локальный index.html и assets/
// - IPC: select-exe, get-exe, run-game, save-upload, save-download,
//        open-external, get-platform, app-version,
//        update:check, update:status (event), update:progress (event),
//        update:quitAndInstall
// - Auto Update: electron-updater + GitHub Releases
// - Не навязывает COOP/COEP (чтобы не ломались картинки с Supabase)

const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// [ADD] ПРОФИЛИ ДОЛЖНЫ ИДТИ ДО userData
// Позволяет запускать лаунчер с разными профилями: --profile=test
const profileArg = (process.argv.find(a => a.startsWith('--profile=')) || '').split('=')[1];
if (profileArg) {
  const base = path.join(app.getPath('appData'), 'Fraktum Launcher');
  app.setPath('userData', path.join(base, profileArg));
}

// === автообновления и логирование (с подстраховкой)
let log;
try {
  log = require('electron-log');
  log.initialize?.();
} catch (_e) {
  // Фоллбек, если electron-log не установлен
  log = {
    info: console.log.bind(console, '[INFO]'),
    warn: console.warn.bind(console, '[WARN]'),
    error: console.error.bind(console, '[ERROR]'),
    debug: console.debug.bind(console, '[DEBUG]'),
    logger: { transports: { file: { level: 'info' } } }
  };
}

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.logger = log;
  autoUpdater.logger.transports.file.level = 'info';

  // [ADD] Явно логируем источник обновлений
  log.info('[Updater] electron-updater initialized');
} catch (_e) {
  // electron-updater отсутствует — работаем без автообновлений
  log.warn('[Updater] electron-updater not found — auto-update disabled.');
}

// ----------- ПЛАТФОРМА -----------
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// ----------- ГЛОБАЛ -----------
let mainWin;

// где хранить конфиги/сейвы пользователя
const userDir = app.getPath('userData');
const cfgFile = path.join(userDir, 'config.json');
const savesDir = path.join(userDir, 'saves');

// простые утилы для json
const readJSON = (file, def = {}) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; } };
const writeJSON = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); };

// конфиг лаунчера (путь к exe и т.п.)
const getCfg = () => readJSON(cfgFile, { exePath: null });
const setCfg = (patch) => writeJSON(cfgFile, { ...getCfg(), ...patch });

// ДО объявлений userDir/cfgFile:
const profArg = (process.argv.find(a => a.startsWith('--profile=')) || '').split('=')[1];
if (profArg) {
  const base = path.join(app.getPath('appData'), 'Fraktum Launcher');
  app.setPath('userData', path.join(base, profArg));
}

// ----------- ОДНОЭКЗЕМПЛЯРНОСТЬ -----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });
}

// ----------- ОКНО -----------
function createWindow() {
  mainWin = new BrowserWindow({
    width: 1180,
    height: 740,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0a0f1b',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      devTools: true,
    },
  });

  // Открывать внешние ссылки в браузере
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', (e, url) => {
    // Только наш локальный файл
    if (!url.startsWith('file://')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // ЗАГРУЖАЕМ локальный index.html
  const indexPath = path.join(__dirname, 'index.html');
  mainWin.loadFile(indexPath);

  mainWin.once('ready-to-show', () => mainWin.show());

  // Автопроверка обновлений только в собранной версии и если модуль есть
  if (app.isPackaged && autoUpdater) {
    setupAutoUpdate();
    // Первичная проверка
    safeCheckForUpdates();
  } else if (app.isPackaged && !autoUpdater) {
    log.info('[Updater] Skipped: updater module missing.');
  }
  // mainWin.webContents.openDevTools({ mode: 'detach' }); // при необходимости
}

// ----------- СЕССИЯ / БЕЗОПАСНОСТЬ -----------
// ВАЖНО: Не включаем COEP/COOP, чтобы не ломать загрузку аватаров с Supabase.
// CSP задаётся в index.html.
function hardenSession() {
  const ses = session.defaultSession;
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {};
    callback({ responseHeaders: headers });
  });
}

// ----------- AUTO UPDATE -----------
function setupAutoUpdate() {
  if (!autoUpdater) return; // защита

  // Параметры поведения
  autoUpdater.autoDownload = true;           // как нашли — качаем
  autoUpdater.autoInstallOnAppQuit = true;   // ставим при выходе из приложения

  // События updater'а
  autoUpdater.on('checking-for-update', () => {
    log.info('[Updater] Checking for update…');
    sendToRenderer('update:status', 'checking');
  });

  autoUpdater.on('update-available', (info) => {
    log.info('[Updater] Update available', info);
    sendToRenderer('update:status', 'available', info?.version || null);
  });

  autoUpdater.on('update-not-available', (info) => {
    log.info('[Updater] No updates', info);
    sendToRenderer('update:status', 'none');
  });

  autoUpdater.on('error', (err) => {
    log.error('[Updater] Error:', err);
    sendToRenderer('update:status', 'error', String(err));
  });

  autoUpdater.on('download-progress', (p) => {
    sendToRenderer('update:progress', {
      percent: Math.round(p.percent || 0),
      transferred: p.transferred || 0,
      total: p.total || 0
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('[Updater] Update downloaded', info);
    sendToRenderer('update:status', 'downloaded', info?.version || null);

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
      log.error('[Updater] showMessageBoxSync failed', e);
    }
  });
}

async function safeCheckForUpdates() {
  if (!autoUpdater) return; // защита
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    log.error('[Updater] checkForUpdates failed', e);
    sendToRenderer('update:status', 'error', String(e));
  }
}

function sendToRenderer(channel, ...args) {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send(channel, ...args);
  }
}

// ----------- IPC: мост для фронта -----------
function setupIpc() {
  // выбрать EXE (или бинарь на mac/linux)
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

  // получить текущее EXE из конфига
  ipcMain.handle('get-exe', async () => {
    const { exePath } = getCfg();
    if (!exePath) return null;
    return { path: exePath, name: path.basename(exePath) };
  });

  // запуск игры
  ipcMain.handle('run-game', async (_evt, { gameId, args = [] } = {}) => {
    const { exePath } = getCfg();
    if (!exePath) throw new Error('EXE не выбран');

    return new Promise((resolve, reject) => {
      try {
        const child = spawn(exePath, args, {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.on('error', reject);
        child.unref();
        resolve({ ok: true, launched: true, gameId });
      } catch (e) {
        reject(e);
      }
    });
  });

  // принять сейв
  ipcMain.handle('save-upload', async (_evt, { slot, name, data }) => {
    if (!slot) return { ok: false, reason: 'no-slot' };
    fs.mkdirSync(savesDir, { recursive: true });
    const dst = path.join(savesDir, `${slot}.zip`);
    try {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      fs.writeFileSync(dst, buf);
      return { ok: true, file: dst, name: name || path.basename(dst) };
    } catch (e) {
      return { ok: false, reason: 'write-failed', error: String(e) };
    }
  });

  // скачать сейв
  ipcMain.handle('save-download', async (_evt, { slot }) => {
    const src = path.join(savesDir, `${slot}.zip`);
    if (!fs.existsSync(src)) return { ok: false, reason: 'empty' };
    const { canceled, filePath } = await dialog.showSaveDialog(mainWin, {
      title: `Сохранить ${slot}.zip`,
      defaultPath: `${slot}.zip`,
    });
    if (canceled || !filePath) return { ok: false, reason: 'cancel' };
    try {
      fs.copyFileSync(src, filePath);
      return { ok: true, filePath };
    } catch (e) {
      return { ok: false, reason: 'copy-failed', error: String(e) };
    }
  });

  // открыть внешнюю ссылку
  ipcMain.handle('open-external', async (_evt, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });

  // платформа
  ipcMain.handle('get-platform', () => process.platform);

  // версия приложения для UI
  ipcMain.handle('app-version', () => app.getVersion());

  // ручная проверка обновлений из UI
  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) {
      return { ok: false, dev: true, message: 'Auto-update доступен только в собранной версии.' };
    }
    if (!autoUpdater) {
      return { ok: false, message: 'Модуль автообновлений отсутствует.' };
    }
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (e) {
      log.error('[Updater] manual check failed', e);
      return { ok: false, error: String(e) };
    }
  });

  // немедленная установка (если уже скачано)
  ipcMain.handle('update:quitAndInstall', () => {
    if (!app.isPackaged) return { ok: false, dev: true };
    if (!autoUpdater) return { ok: false, message: 'Модуль автообновлений отсутствует.' };
    try {
      autoUpdater.quitAndInstall();
      return { ok: true };
    } catch (e) {
      log.error('[Updater] quitAndInstall failed', e);
      return { ok: false, error: String(e) };
    }
  });
}

const { ipcMain, app } = require('electron');
const https = require('https');
const fs = require('fs');
const path = require('path');

ipcMain.handle('download-novel', async (_evt, { signedUrl, version }) => {
  const gamesDir = path.join(app.getPath('userData'), 'games', 'novel', version || 'latest');
  fs.mkdirSync(gamesDir, { recursive: true });
  const dst = path.join(gamesDir, 'FraktumNovel-win.zip');

  await new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dst);
    https.get(signedUrl, res => {
      if (res.statusCode !== 200) {
        reject(new Error('HTTP ' + res.statusCode)); return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });

  return { ok: true, zip: dst, dir: gamesDir };
});

// ----------- ЖИЗНЕННЫЙ ЦИКЛ -----------
app.setAppUserModelId('com.fraktum.launcher'); // для Win уведомлений/таскбара

app.whenReady().then(() => {
  fs.mkdirSync(savesDir, { recursive: true });
  hardenSession();
  setupIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});
