// All network/update privileges stay in the main process. No credentials are shipped.
function createUpdates(updater, { enabled, version, canInstall }) {
  let state = {
    phase: enabled ? 'idle' : 'unavailable',
    version,
    message: enabled
      ? 'Updates are checked when Callside opens.'
      : 'Updates are available in installed desktop releases.',
  };
  let checking = false,
    timer;
  const set = (phase, message, extra = {}) => {
    state = { ...state, phase, message, ...extra };
  };
  const fail = () =>
    set(
      'error',
      'Could not check or download updates. The release feed may still be private or unavailable. Try again later.',
    );
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.logger = null;
  updater.on('checking-for-update', () => set('checking', 'Checking for updates…'));
  updater.on('update-not-available', () =>
    set('current', 'You have the latest available version.'),
  );
  updater.on('update-available', (info) =>
    set('downloading', 'Downloading update…', { nextVersion: info.version, percent: 0 }),
  );
  updater.on('download-progress', (progress) =>
    set('downloading', 'Downloading update…', { percent: Math.round(progress.percent) }),
  );
  updater.on('update-downloaded', (info) =>
    set('ready', 'Update ready. Restart when your call is finished.', {
      nextVersion: info.version,
      percent: 100,
    }),
  );
  updater.on('error', fail);
  async function check() {
    if (!enabled || checking || ['downloading', 'ready'].includes(state.phase)) return state;
    checking = true;
    try {
      await updater.checkForUpdates();
    } catch {
      fail();
    } finally {
      checking = false;
    }
    return state;
  }
  if (enabled) {
    timer = setTimeout(() => void check(), 15000);
    timer.unref?.();
  }
  return {
    status: () => ({ ...state }),
    check,
    install() {
      if (state.phase !== 'ready') throw Error('No downloaded update is ready.');
      if (!canInstall()) throw Error('Finish your call and any active setup before restarting.');
      updater.quitAndInstall();
    },
    close() {
      clearTimeout(timer);
    },
  };
}
module.exports = { createUpdates };
