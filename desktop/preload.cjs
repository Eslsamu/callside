const { contextBridge, ipcRenderer } = require('electron');

// The renderer gets only these specific capabilities, never ipcRenderer or Node access.
contextBridge.exposeInMainWorld(
  'callsideDesktop',
  Object.freeze({
    platform: process.platform,
    getTestDiagnostics() {
      return ipcRenderer.invoke('callside:test-diagnostics');
    },
    loadTestState() {
      return ipcRenderer.invoke('callside:test-load');
    },
    saveTestState(state) {
      return ipcRenderer.invoke('callside:test-save', state);
    },
    relaunchTest() {
      return ipcRenderer.invoke('callside:test-relaunch');
    },
    saveTestReport(report) {
      return ipcRenderer.invoke('callside:test-report', report);
    },
    updates(action) {
      if (!['status', 'check', 'install'].includes(action))
        return Promise.reject(new Error('Invalid update action.'));
      return ipcRenderer.invoke('callside:updates', action);
    },
    setSessionActive(active) {
      if (typeof active !== 'boolean') return Promise.reject(new Error('Expected a boolean.'));
      return ipcRenderer.invoke('callside:session-active', active);
    },
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
    loadTemplate() {
      return ipcRenderer.invoke('callside:template-load');
    },
    saveTemplate(settings) {
      return ipcRenderer.invoke('callside:template-save', settings);
    },
    removeTemplate() {
      return ipcRenderer.invoke('callside:template-remove');
    },
  }),
);
