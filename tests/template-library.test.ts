import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { createLibrary, upgradePresets } from '../src/template';
const { createTemplateLibraryStore } = createRequire(import.meta.url)(
  '../desktop/template-store.cjs',
);
describe('named template library', () => {
  it('adds Language buddy once without changing existing settings or restoring deleted presets', () => {
    const library = createLibrary();
    delete library.presetVersion;
    library.templates = library.templates.filter((t) => t.id !== 'languageBuddy');
    library.activeId = 'sales';
    const existing = structuredClone(library.templates);
    library.templates[0].name = 'Language buddy';
    existing[0].name = 'Language buddy';
    const upgraded = upgradePresets(library);
    expect(upgraded.activeId).toBe('sales');
    expect(upgraded.templates.slice(0, -1)).toEqual(existing);
    expect(upgraded.templates.at(-1)?.name).toBe('Language buddy (2)');
    expect(upgraded.templates.at(-1)?.settings.autoTriggerSource).toBe('either');
    expect(upgraded.templates.at(-1)?.settings.context).toBe('');
    upgraded.templates = upgraded.templates.filter((t) => t.id !== 'languageBuddy');
    expect(upgradePresets(upgraded)).toBe(upgraded);
    expect(upgraded.templates).toHaveLength(existing.length);
  });
  it('preserves legacy context only in Saved setup, with separate preset settings', () => {
    const legacy = { ...DEFAULT_SETTINGS, context: 'Private sales notes' };
    const library = createLibrary(legacy);
    expect(library.activeId).toBe('migrated');
    expect(library.templates.find((t) => t.id === 'migrated')!.settings.context).toBe(
      legacy.context,
    );
    for (const t of library.templates.filter((t) => t.id !== 'migrated'))
      expect(t.settings.context).toBe('');
    library.templates[1].settings.context = 'Sales only';
    expect(library.templates[2].settings.context).toBe('');
  });
  it('round trips templates, strips credentials and rejects destructive invalid saves', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'callside-templates-'));
    try {
      const path = join(dir, 'templates.json');
      const store = createTemplateLibraryStore(path, DEFAULT_SETTINGS);
      const library = createLibrary();
      library.activeId = 'sales';
      library.templates[1].settings.context = 'Customer notes';
      (library.templates[1].settings as any).apiKey = 'secret';
      await store.save(library);
      expect((await store.load()).presetVersion).toBe(1);
      expect((await store.load()).templates[1].settings.context).toBe('Customer notes');
      const before = await readFile(path, 'utf8');
      expect(before).not.toContain('secret');
      library.templates[2].name = 'Sales';
      await expect(store.save(library)).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe(before);
      await writeFile(path, 'broken');
      await expect(store.load()).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe('broken');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
