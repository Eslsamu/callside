const { readFile, writeFile, mkdir, rename, rm } = require('node:fs/promises');
const { dirname } = require('node:path');
const { randomBytes } = require('node:crypto');

// Only ciphertext is written. The OS encryption provider remains in the main process.
function createKeyStore(file, encryption, platform = process.platform) {
  const available = async () => {
    if (
      !(await encryption.isAsyncEncryptionAvailable()) ||
      (platform === 'linux' && encryption.getSelectedStorageBackend() === 'basic_text')
    )
      throw new Error('Secure key storage is unavailable.');
  };
  const save = async (key) => {
    await available();
    const encrypted = await encryption.encryptStringAsync(key);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  };
  return {
    async load() {
      let encrypted;
      try {
        encrypted = await readFile(file);
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
      await available();
      const decrypted = await encryption.decryptStringAsync(encrypted);
      if (!/^[\x21-\x7e]{12,500}$/.test(decrypted.result))
        throw new Error('The saved key is invalid.');
      if (decrypted.shouldReEncrypt) await save(decrypted.result);
      return decrypted.result;
    },
    save,
    async remove() {
      await rm(file, { force: true });
    },
  };
}
module.exports = { createKeyStore };
