import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CommuteRoute } from '@metro-meet/shared';
import { dataDir, routeCachePath } from './data.js';

type RouteCacheFile = Record<string, CommuteRoute>;
let writeChain: Promise<void> = Promise.resolve();
let cacheState: RouteCacheFile | undefined;
let cacheLoadPromise: Promise<RouteCacheFile> | undefined;

export function routeCacheKey(fromStationId: string, toStationId: string): string {
  return `route:${fromStationId}:${toStationId}:amap`;
}

async function readCacheFile(): Promise<RouteCacheFile> {
  try {
    const raw = await readFile(routeCachePath, 'utf8');
    return JSON.parse(raw) as RouteCacheFile;
  } catch {
    return {};
  }
}

async function loadCache(): Promise<RouteCacheFile> {
  if (cacheState) return cacheState;
  if (!cacheLoadPromise) {
    cacheLoadPromise = readCacheFile().then((cache) => {
      cacheState = cache;
      return cache;
    });
  }
  return cacheLoadPromise;
}

async function writeCacheFile(cache: RouteCacheFile): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(routeCachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

export async function getCachedRoute(fromStationId: string, toStationId: string): Promise<CommuteRoute | undefined> {
  const cache = await loadCache();
  const route = cache[routeCacheKey(fromStationId, toStationId)];
  return route ? { ...route, cacheHit: true } : undefined;
}

export async function setCachedRoute(route: CommuteRoute): Promise<void> {
  if (route.failed) return;
  const cache = await loadCache();
  cache[routeCacheKey(route.fromStationId, route.toStationId)] = { ...route, cacheHit: false };
  writeChain = writeChain.then(async () => {
    await writeCacheFile(cache);
  });
  await writeChain;
}

export async function clearRouteCache(): Promise<void> {
  cacheState = {};
  cacheLoadPromise = Promise.resolve(cacheState);
  writeChain = writeChain.then(() => writeCacheFile(cacheState ?? {}));
  await writeChain;
}

export async function routeCacheStats(): Promise<{ size: number }> {
  return { size: Object.keys(await loadCache()).length };
}
