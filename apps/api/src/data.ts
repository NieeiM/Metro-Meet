import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { metroDataSchema, type MetroData } from '@metro-meet/shared';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(dirname, '../../..');

export const dataDir = path.join(rootDir, 'data');
export const metroDataPath = path.join(dataDir, 'shanghai-metro.json');
export const routeCachePath = path.join(dataDir, 'route-cache.json');

export async function loadMetroData(): Promise<MetroData> {
  const raw = await readFile(metroDataPath, 'utf8');
  return metroDataSchema.parse(JSON.parse(raw));
}
