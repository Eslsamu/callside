import { DEFAULT_SETTINGS } from '../shared/defaults';
import type { Settings } from '../shared/types';
import { safeSettings } from './session';

const settingsKey = 'callside.settings.v1';

export async function loadTemplate(): Promise<{ settings: Settings; error: string }> {
  const defaults = DEFAULT_SETTINGS;
  try {
    const stored = window.callsideDesktop
      ? await window.callsideDesktop.loadTemplate()
      : JSON.parse(localStorage.getItem(settingsKey) || 'null');
    return { settings: safeSettings(stored, defaults), error: '' };
  } catch {
    return {
      settings: { ...defaults },
      error:
        'Could not load the saved template. Defaults are shown; your saved copy has not been changed.',
    };
  }
}

export async function saveTemplate(settings: Settings): Promise<void> {
  const value = safeSettings(settings, DEFAULT_SETTINGS);
  if (window.callsideDesktop) await window.callsideDesktop.saveTemplate(value);
  else localStorage.setItem(settingsKey, JSON.stringify(value));
}

export async function removeTemplate(): Promise<void> {
  if (window.callsideDesktop) await window.callsideDesktop.removeTemplate();
  else localStorage.removeItem(settingsKey);
}
