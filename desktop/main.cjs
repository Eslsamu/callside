const {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  session,
  dialog,
  safeStorage,
} = require('electron');
const { createKeyStore } = require('./key-store.cjs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const smokeTest = process.argv.includes('--smoke-test');
if (smokeTest && process.platform === 'darwin') {
  app.setActivationPolicy('prohibited');
  app.dock?.hide();
}

// Keeps Wayland portal identity stable. Packaging must use this same desktop file name.
if (process.platform === 'linux') app.setDesktopName('org.callside.app.desktop');
// Electron 40 needs the portal flag on some Wayland desktops. Harmless where not supported.
app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');
// Native macOS picking can return video without an audio track. Use Electron's
// documented Screen & System Audio Recording path and grant loopback explicitly.
// --native-audio keeps the alternative CoreAudio/system-picker path available.
const macAudioCompatibility =
  process.platform === 'darwin' && !process.argv.includes('--native-audio');
if (macAudioCompatibility)
  app.commandLine.appendSwitch('disable-features', 'MacCatapLoopbackAudioForScreenShare');

let window;
let server;
let appOrigin = '';
let shuttingDown = false;
let shortcutStatus = [];

const trusted = (url) => {
  try {
    return new URL(url).origin === appOrigin;
  } catch {
    return false;
  }
};
const trustedSender = (event) =>
  Boolean(
    window &&
    !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame &&
    trusted(event.senderFrame.url),
  );

function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 650,
    title: 'Callside',
    backgroundColor: '#111713',
    show: false,
    ...(smokeTest ? { focusable: false, skipTaskbar: true } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!trusted(url)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!trusted(url)) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  if (!smokeTest) window.once('ready-to-show', () => window?.show());
  window.on('closed', () => {
    window = undefined;
  });
  void window.loadURL(server.url);
}

async function boot() {
  const serverModule = await import(
    pathToFileURL(path.join(__dirname, '../dist-server/server/index.js')).href
  );
  server = await serverModule.startServer({
    port: 0,
    production: true,
    keyStore: createKeyStore(path.join(app.getPath('userData'), 'openai-key.enc'), safeStorage),
  });
  appOrigin = new URL(server.url).origin;

  const appSession = session.defaultSession;
  const permissionAllowed = (permission) =>
    permission === 'media' || permission === 'display-capture';
  appSession.setPermissionCheckHandler((contents, permission, origin, details) =>
    Boolean(
      window &&
      contents === window.webContents &&
      trusted(origin) &&
      permissionAllowed(permission) &&
      (permission !== 'media' || details.mediaType === 'audio'),
    ),
  );
  appSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = details.mediaTypes || [];
    callback(
      Boolean(
        window &&
        contents === window.webContents &&
        trusted(details.requestingUrl || contents.getURL()) &&
        permissionAllowed(permission) &&
        (permission !== 'media' || mediaTypes.every((type) => type === 'audio')),
      ),
    );
  });

  appSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      if (
        !window ||
        !request.frame ||
        request.frame !== window.webContents.mainFrame ||
        !trusted(request.securityOrigin) ||
        !request.userGesture
      ) {
        callback({});
        return;
      }
      // In compatibility mode the Start click grants system loopback plus a local
      // video track, which is required by getDisplayMedia and never sent to OpenAI.
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
        });
        if (!sources.length || !window || request.frame.isDestroyed()) {
          callback({});
          return;
        }
        callback({
          video: sources[0],
          ...(request.audioRequested &&
          (process.platform === 'win32' || process.platform === 'darwin')
            ? { audio: 'loopback' }
            : {}),
        });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: !macAudioCompatibility },
  );

  ipcMain.handle('callside:set-always-on-top', (event, enabled) => {
    if (!trustedSender(event) || typeof enabled !== 'boolean')
      throw new Error('Invalid desktop request.');
    window.setAlwaysOnTop(enabled, 'floating');
  });
  ipcMain.handle('callside:shortcut-status', (event) => {
    if (!trustedSender(event)) throw new Error('Invalid desktop request.');
    return shortcutStatus;
  });

  shortcutStatus = ['F8', 'CommandOrControl+Shift+Space'].map((accelerator) => ({
    accelerator,
    registered:
      !smokeTest &&
      globalShortcut.register(accelerator, () => {
        if (window && !window.isDestroyed()) window.webContents.send('callside:answer');
      }),
  }));
  for (const shortcut of shortcutStatus) {
    if (!shortcut.registered && !smokeTest)
      console.warn(`Callside: shortcut ${shortcut.accelerator} is unavailable; use Help now.`);
  }
  createWindow();
}

app
  .whenReady()
  .then(async () => {
    if (smokeTest && process.platform === 'darwin') app.dock?.hide();
    await boot();
  })
  .catch((error) => {
    if (smokeTest) {
      console.error('Callside smoke test failed:', error);
      app.exit(1);
      return;
    }
    dialog.showErrorBox(
      'Callside could not start',
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
  });
app.on('activate', () => {
  if (server && !window && !shuttingDown) createWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  globalShortcut.unregisterAll();
  if (shuttingDown || !server) return;
  event.preventDefault();
  shuttingDown = true;
  Promise.resolve(server.close())
    .catch(() => undefined)
    .finally(() => app.quit());
});
