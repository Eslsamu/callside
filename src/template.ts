import { TASK_PRESETS } from '../shared/tasks';
import type { TemplateLibrary, SavedTemplate } from '../shared/templates';
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

export function createLibrary(legacy?: Settings): TemplateLibrary {
  const templates: SavedTemplate[] = Object.entries(TASK_PRESETS).map(([id, preset]) => ({
    id,
    name: preset.name,
    settings: {
      ...(legacy ?? DEFAULT_SETTINGS),
      context: '',
      systemPrompt: preset.prompt,
      autoPrompt: preset.autoPrompt,
      autoTriggerSource: preset.autoTriggerSource,
    } as Settings,
  }));
  if (legacy) templates.push({ id: 'migrated', name: 'Saved setup', settings: { ...legacy } });
  return { version: 2, activeId: legacy ? 'migrated' : 'universal', templates };
}
export async function loadTemplates(): Promise<{
  library: TemplateLibrary;
  settings: Settings;
  error: string;
}> {
  try {
    const stored = window.callsideDesktop?.loadTemplates
      ? await window.callsideDesktop.loadTemplates()
      : JSON.parse(localStorage.getItem('callside.templates.v2') || 'null');
    if (stored) {
      if (
        stored.version !== 2 ||
        !Array.isArray(stored.templates) ||
        !stored.templates.length ||
        !stored.templates.some((t: SavedTemplate) => t.id === stored.activeId)
      )
        throw new Error('Invalid templates');
      const library: TemplateLibrary = {
        version: 2,
        activeId: stored.activeId,
        templates: stored.templates.map((t: SavedTemplate) => ({
          id: t.id,
          name: t.name,
          settings: safeSettings(t.settings, DEFAULT_SETTINGS),
        })),
      };
      return {
        library,
        settings: library.templates.find((t) => t.id === library.activeId)!.settings,
        error: '',
      };
    }
    const raw = window.callsideDesktop
      ? await window.callsideDesktop.loadTemplate()
      : JSON.parse(localStorage.getItem(settingsKey) || 'null');
    const library = createLibrary(raw ? safeSettings(raw, DEFAULT_SETTINGS) : undefined);
    return {
      library,
      settings: library.templates.find((t) => t.id === library.activeId)!.settings,
      error: '',
    };
  } catch {
    const library = createLibrary();
    return {
      library,
      settings: library.templates[0].settings,
      error: 'Could not load saved templates. Your saved files have not been changed.',
    };
  }
}
export async function saveTemplates(library: TemplateLibrary): Promise<void> {
  const value = {
    ...library,
    templates: library.templates.map((t) => ({
      ...t,
      settings: safeSettings(t.settings, DEFAULT_SETTINGS),
    })),
  };
  if (window.callsideDesktop) {
    if (!window.callsideDesktop.saveTemplates)
      throw new Error('Restart with an updated desktop app to save templates.');
    await window.callsideDesktop.saveTemplates(value);
  } else localStorage.setItem('callside.templates.v2', JSON.stringify(value));
}
