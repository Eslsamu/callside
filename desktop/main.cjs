const {
  app,
  BrowserWindow,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  session,
  dialog,
  safeStorage,
  shell,
} = require('electron');
const { createKeyStore } = require('./key-store.cjs');
const { createTemplateStore } = require('./template-store.cjs');
const { createTestStateStore, sanitizeTestReport } = require('./test-state.cjs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const smokeTest = process.argv.includes('--smoke-test');
const buildMetadata = require('../package.json');
const windowsPreview = Boolean(buildMetadata.callsideWindowsPreview);
const communityBuild = Boolean(buildMetadata.callsideCommunityBuild);
if (windowsPreview && !smokeTest) {
  app.setName('Callside Windows Test');
  app.setPath('userData', path.join(app.getPath('appData'), 'Callside Windows Test'));
}
const ownsInstance = smokeTest || app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();

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
let updates;
let sessionActive = false;
const processSessionId = randomUUID();
let storageProbe;
app.on('second-instance', () => {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
});

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
  void window.loadURL(server.url + (windowsPreview && !smokeTest ? '/windows-check' : ''));
}

async function boot() {
  const { DEFAULT_SETTINGS } = await import(
    pathToFileURL(path.join(__dirname, '../dist-server/shared/defaults.js')).href
  );
  const templateStore = createTemplateStore(
    path.join(app.getPath('userData'), 'template.json'),
    DEFAULT_SETTINGS,
  );
  const testStateStore = createTestStateStore(
    path.join(app.getPath('userData'), 'windows-test.json'),
    DEFAULT_SETTINGS,
  );
  const probeStore = createKeyStore(
    path.join(app.getPath('userData'), 'windows-test-storage.enc'),
    safeStorage,
    process.platform,
    (value) => value === 'callside-test-storage-sentinel',
  );
  const serverModule = await import(
    pathToFileURL(path.join(__dirname, '../dist-server/server/index.js')).href
  );
  server = await serverModule.startServer({
    localWhisperBinary: app.isPackaged
      ? path.join(
          process.resourcesPath,
          'app.asar.unpacked',
          'desktop/bin',
          process.platform === 'win32' ? 'windows/whisper-server.exe' : 'whisper-server',
        )
      : undefined,
    localModelDirectory: path.join(app.getPath('userData'), 'models'),
    bundledWhisperModel:
      windowsPreview && app.isPackaged
        ? path.join(process.resourcesPath, 'models', 'ggml-large-v3-turbo-q5_0.bin')
        : undefined,

    localSpeakerBinary: app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'desktop/bin/callside-diarizer')
      : path.join(__dirname, 'bin/callside-diarizer'),
    bundledSpeakerModel:
      windowsPreview && app.isPackaged
        ? path.join(process.resourcesPath, 'models', 'speakers', 'ls_eend_ami_step.onnx')
        : undefined,
    port: 0,
    production: true,
    keyStore: createKeyStore(path.join(app.getPath('userData'), 'openai-key.enc'), safeStorage),
    chatgptStore: createKeyStore(
      path.join(app.getPath('userData'), 'chatgpt-auth.enc'),
      safeStorage,
      process.platform,
      (value) => value.length <= 1_000_000 && Boolean(JSON.parse(value).hostId),
    ),
    openAuthBrowser: (url) => {
      const target = new URL(url);
      if (
        url !== 'https://chatgpt.com/settings/usage' &&
        (target.origin !== 'https://auth.openai.com' ||
          target.pathname !== '/api/accounts/authorize')
      )
        throw new Error('Invalid authorization URL.');
      return shell.openExternal(url);
    },
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
    { useSystemPicker: process.platform === 'darwin' && !macAudioCompatibility },
  );

  const { autoUpdater } = require('electron-updater');
  updates = require('./updates.cjs').createUpdates(autoUpdater, {
    enabled: app.isPackaged && !smokeTest && !windowsPreview && !communityBuild,
    unavailableMessage: communityBuild
      ? 'Community build · not notarized by Apple. Download updates manually from github.com/Eslsamu/callside/releases.'
      : undefined,
    version: app.getVersion(),
    canInstall: () => !sessionActive,
  });
  ipcMain.handle('callside:updates', (event, action) => {
    if (!trustedSender(event)) throw Error('Invalid desktop request.');
    if (action === 'status') return updates.status();
    if (action === 'check') return updates.check();
    if (action === 'install') return updates.install();
    throw Error('Unknown update action.');
  });
  ipcMain.handle('callside:test-diagnostics', async (event) => {
    if (!trustedSender(event)) throw Error('Invalid desktop request.');
    const os = require('node:os');
    storageProbe ??= (async () => {
      let secureStorage = false,
        secureStorageRestart = null;
      try {
        const previous = await probeStore.load();
        secureStorageRestart =
          previous === null ? null : previous === 'callside-test-storage-sentinel';
        await probeStore.save('callside-test-storage-sentinel');
        secureStorage = (await probeStore.load()) === 'callside-test-storage-sentinel';
      } catch {
        secureStorageRestart = false;
        /* Report capability failure without credentials or OS error details. */
      }
      return { secureStorage, secureStorageRestart };
    })();
    return {
      platform: process.platform,
      arch: process.arch,
      osVersion: os.release(),
      machine: os.machine(),
      cpu: os.cpus()[0]?.model,
      cpuThreads: os.cpus().length,
      ramGB: Math.round(os.totalmem() / 1024 ** 3),
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      preview: windowsPreview,
      buildId: buildMetadata.callsideBuildId ?? 'development',
      sessionId: processSessionId,
      ...(await storageProbe),
      shortcuts: shortcutStatus,
    };
  });
  const trustedTest = (event) => {
    if (
      !trustedSender(event) ||
      (!windowsPreview && !smokeTest) ||
      new URL(event.senderFrame.url).pathname !== '/windows-check'
    )
      throw Error('This action is available only in the Windows test preview.');
  };
  ipcMain.handle('callside:test-load', (event) => {
    trustedTest(event);
    return testStateStore.load();
  });
  ipcMain.handle('callside:test-save', (event, value) => {
    trustedTest(event);
    return testStateStore.save(value);
  });
  ipcMain.handle('callside:test-report', async (event, value) => {
    trustedTest(event);
    const contents = JSON.stringify(sanitizeTestReport(value), null, 2);
    const selected = await dialog.showSaveDialog(window, {
      title: 'Save Callside test report',
      defaultPath: path.join(
        app.getPath('downloads'),
        `callside-windows-test-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
      ),
      filters: [{ name: 'JSON report', extensions: ['json'] }],
    });
    if (selected.canceled || !selected.filePath) return { saved: false };
    await require('node:fs/promises').writeFile(selected.filePath, contents, { mode: 0o600 });
    return { saved: true };
  });
  ipcMain.handle('callside:test-relaunch', async (event) => {
    trustedTest(event);
    if (sessionActive) throw Error('Stop the active test before restarting.');
    await testStateStore.flush();
    // A brief delay lets the invoking UI receive its acknowledgement first.
    setTimeout(() => {
      app.relaunch();
      app.quit();
    }, 150);
  });
  ipcMain.handle('callside:session-active', (event, active) => {
    if (!trustedSender(event) || typeof active !== 'boolean')
      throw Error('Invalid desktop request.');
    sessionActive = active;
  });

  ipcMain.handle('callside:set-always-on-top', (event, enabled) => {
    if (!trustedSender(event) || typeof enabled !== 'boolean')
      throw new Error('Invalid desktop request.');
    window.setAlwaysOnTop(enabled, 'floating');
  });
  ipcMain.handle('callside:shortcut-status', (event) => {
    if (!trustedSender(event)) throw new Error('Invalid desktop request.');
    return shortcutStatus;
  });

  ipcMain.handle('callside:template-load', (event) => {
    if (!trustedSender(event)) throw new Error('Invalid desktop request.');
    return templateStore.load();
  });
  ipcMain.handle('callside:template-save', (event, settings) => {
    if (!trustedSender(event)) throw new Error('Invalid desktop request.');
    return templateStore.save(settings);
  });
  ipcMain.handle('callside:template-remove', (event) => {
    if (!trustedSender(event)) throw new Error('Invalid desktop request.');
    return templateStore.remove();
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
    if (ownsInstance) await boot();
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
  updates?.close();
  globalShortcut.unregisterAll();
  if (shuttingDown || !server) return;
  event.preventDefault();
  shuttingDown = true;
  Promise.resolve(server.close())
    .catch(() => undefined)
    .finally(() => app.quit());
});
