import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, symlink, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Electron Builder calls this only after every requested package has finished.
export default async function afterAllArtifactBuild({ outDir }) {
  const releaseRoot = fileURLToPath(new URL('../release/', import.meta.url));
  const destination = resolve(outDir);
  const latest = join(releaseRoot, 'Latest');
  if (destination === resolve(releaseRoot) || destination === latest)
    throw new Error('Use a separate version folder for release output.');

  await mkdir(releaseRoot, { recursive: true });
  const existing = await lstat(latest).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (existing && !existing.isSymbolicLink())
    throw new Error(`Cannot update ${latest}: it is not a shortcut.`);

  const temporary = `${latest}.tmp-${randomUUID()}`;
  const isWindows = process.platform === 'win32';
  // Junctions do not require Windows Developer Mode or administrator rights.
  await symlink(
    isWindows ? destination : relative(dirname(latest), destination),
    temporary,
    isWindows ? 'junction' : 'dir',
  );
  try {
    // POSIX rename swaps links atomically. Windows requires removing the old junction.
    if (isWindows && existing) await unlink(latest);
    await rename(temporary, latest);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  console.log(`Latest release: ${latest} -> ${destination}`);
  return [];
}
