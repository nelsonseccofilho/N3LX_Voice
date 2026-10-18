import { randomUUID } from 'node:crypto';
import { stat, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { portableFilename } from './portable-filename';
import { replaceFile } from './replace-file';
import { withSecurityScopedBookmark } from './security-scoped-files';

export function conversionDefaultPath(name: string, sourcePath: string, downloads: string) {
  const stem = portableFilename(name).replace(/\.[^.]+$/, '') || 'audio';
  return join(sourcePath ? dirname(sourcePath) : downloads, `${stem}_convert.wav`);
}
async function fingerprint(path: string) {
  try {
    const info = await stat(path);
    return JSON.stringify([await realpath(path), info.ino, info.size, info.mtimeMs]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export class ConversionDestinations {
  private plans = new Map<
    string,
    { owner: number; path: string; bookmark?: string; fingerprint: string | null; expires: number }
  >();
  async authorize(owner: number, path: string, bookmark?: string, sourcePath = '') {
    if (sourcePath) {
      const canonical = async (p: string) => await realpath(p).catch(() => resolve(p));
      const a = await canonical(sourcePath),
        b = await canonical(path);
      if (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
        throw new Error('Choose a destination different from the source audio');
    }
    const originalFingerprint = await withSecurityScopedBookmark(bookmark, () => fingerprint(path));
    for (const [id, plan] of this.plans)
      if (plan.owner === owner || plan.expires < Date.now()) this.plans.delete(id);
    const token = randomUUID();
    this.plans.set(token, {
      owner,
      path,
      bookmark,
      fingerprint: originalFingerprint,
      expires: Date.now() + 2 * 60 * 60 * 1000,
    });
    return { token, path };
  }
  async save(owner: number, token: string, download: () => Promise<Uint8Array>) {
    const plan = this.plans.get(token);
    if (!plan || plan.owner !== owner || plan.expires < Date.now())
      throw new Error('Choose the output file again');
    this.plans.delete(token);
    const bytes = await download();
    await withSecurityScopedBookmark(plan.bookmark, async () => {
      if ((await fingerprint(plan.path)) !== plan.fingerprint)
        throw new Error('The output file changed during conversion; choose the destination again');
      await replaceFile(plan.path, bytes);
    });
    return { canceled: false, path: plan.path };
  }
}
