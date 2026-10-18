// @vitest-environment node
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { isPackaged: false } }));
import { ConversionDestinations, conversionDefaultPath } from './conversion-destinations';
let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'conversion-export-'));
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});
it('suggests the source directory and original stem with _convert.wav', () => {
  expect(
    conversionDefaultPath('Minha voz.pt.mp3', join(folder, 'Minha voz.pt.mp3'), tmpdir()),
  ).toBe(join(folder, 'Minha voz.pt_convert.wav'));
  expect(conversionDefaultPath('mic.wav', '', folder)).toBe(join(folder, 'mic_convert.wav'));
});
it('chooses a destination without writing, then saves exactly once for its owner', async () => {
  const plans = new ConversionDestinations(),
    path = join(folder, 'voz_convert.wav');
  const plan = await plans.authorize(1, path);
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  const download = vi.fn(async () => new TextEncoder().encode('audio'));
  await expect(plans.save(2, plan.token, download)).rejects.toThrow();
  expect(download).not.toHaveBeenCalled();
  await expect(plans.save(1, plan.token, download)).resolves.toEqual({ canceled: false, path });
  expect(await readFile(path, 'utf8')).toBe('audio');
  await expect(plans.save(1, plan.token, download)).rejects.toThrow();
});
it('refuses to overwrite the source audio', async () => {
  const path = join(folder, 'source.wav');
  await writeFile(path, 'original');
  await expect(new ConversionDestinations().authorize(1, path, undefined, path)).rejects.toThrow(
    'different',
  );
  expect(await readFile(path, 'utf8')).toBe('original');
});
it('preserves a destination modified during conversion', async () => {
  const path = join(folder, 'output.wav'),
    plans = new ConversionDestinations();
  const plan = await plans.authorize(1, path);
  await writeFile(path, 'new user file');
  await expect(
    plans.save(1, plan.token, async () => new TextEncoder().encode('converted')),
  ).rejects.toThrow('changed');
  expect(await readFile(path, 'utf8')).toBe('new user file');
});
it('keeps the previous file when download fails', async () => {
  const path = join(folder, 'output.wav'),
    plans = new ConversionDestinations();
  await writeFile(path, 'previous');
  const plan = await plans.authorize(1, path);
  await expect(
    plans.save(1, plan.token, async () => {
      throw new Error('offline');
    }),
  ).rejects.toThrow('offline');
  expect(await readFile(path, 'utf8')).toBe('previous');
});
