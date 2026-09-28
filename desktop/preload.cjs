const { contextBridge, ipcRenderer } = require('electron');

// The renderer gets only these specific capabilities, never ipcRenderer or Node access.
contextBridge.exposeInMainWorld(
  'callsideDesktop',
  Object.freeze({
    platform: process.platform,
    onAnswer(callback) {
      if (typeof callback !== 'function')
        throw new TypeError('Answer listener must be a function.');
      const listener = () => callback();
      ipcRenderer.on('callside:answer', listener);
      return () => ipcRenderer.removeListener('callside:answer', listener);
    },
    setAlwaysOnTop(enabled) {
      if (typeof enabled !== 'boolean') return Promise.reject(new TypeError('Expected a boolean.'));
      return ipcRenderer.invoke('callside:set-always-on-top', enabled);
    },
    getShortcutStatus() {
      return ipcRenderer.invoke('callside:shortcut-status');
    },
  }),
);
