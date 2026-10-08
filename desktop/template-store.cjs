const { readFile, writeFile, mkdir, rename, rm } = require('node:fs/promises');
const { dirname } = require('node:path');
const { randomUUID } = require('node:crypto');

// Only settings are persisted, never renderer session state or credentials.
function createTemplateStore(file, defaults) {
  function sanitize(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid template.');
    const result = {};
    for (const [key, fallback] of Object.entries(defaults)) {
      const field = Object.hasOwn(value, key) ? value[key] : fallback;
      const valid =
        key === 'maxOutputTokens'
          ? field === null || (typeof field === 'number' && Number.isFinite(field))
          : typeof field === typeof fallback &&
            (typeof field !== 'number' || Number.isFinite(field));
      if (!valid) throw new Error('Invalid template settings.');
      result[key] = field;
    }
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 1_000_000)
      throw new Error('The template is too large to save.');
    return result;
  }
  return {
    sanitize,
    async load() {
      let contents;
      try {
        contents = await readFile(file, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error('Could not read the saved template.');
      }
      try {
        return sanitize(JSON.parse(contents));
      } catch {
        throw new Error('The saved template is unreadable.');
      }
    },
    async save(settings) {
      const contents = JSON.stringify(sanitize(settings), null, 2);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    },
    async remove() {
      await rm(file, { force: true });
    },
  };
}
module.exports = { createTemplateStore };

// Separate file leaves the legacy template intact for migration/recovery.
function createTemplateLibraryStore(file, defaults) {
  const settingsStore = createTemplateStore(file, defaults);
  function sanitize(value) {
    if (
      value?.version !== 2 ||
      !Array.isArray(value.templates) ||
      value.templates.length < 1 ||
      value.templates.length > 100
    )
      throw new Error('Invalid template library.');
    const ids = new Set();
    const names = new Set();
    const templates = value.templates.map((item) => {
      if (
        typeof item.id !== 'string' ||
        !item.id ||
        item.id.length > 100 ||
        ids.has(item.id) ||
        typeof item.name !== 'string' ||
        !item.name.trim() ||
        item.name.trim().length > 80 ||
        names.has(item.name.trim().toLowerCase())
      )
        throw new Error('Invalid template name or ID.');
      ids.add(item.id);
      names.add(item.name.trim().toLowerCase());
      return {
        id: item.id,
        name: item.name.trim(),
        settings: settingsStore.sanitize(item.settings),
      };
    });
    if (!ids.has(value.activeId)) throw new Error('Invalid active template.');
    const result = { version: 2, activeId: value.activeId, templates };
    if (Number.isSafeInteger(value.presetVersion) && value.presetVersion >= 0)
      result.presetVersion = value.presetVersion;
    if (Buffer.byteLength(JSON.stringify(result)) > 10_000_000)
      throw new Error('Template library is too large.');
    return result;
  }
  return {
    async load() {
      try {
        return sanitize(JSON.parse(await readFile(file, 'utf8')));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error('Could not read saved templates.');
      }
    },
    async save(value) {
      const contents = JSON.stringify(sanitize(value), null, 2);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}
module.exports.createTemplateLibraryStore = createTemplateLibraryStore;
