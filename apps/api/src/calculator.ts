import { fallbackEstimateRoute, rankPreciseResults, roughRankCandidates } from '@metro-meet/core';
import type { CommuteRoute, MetroData, OptimalOriginsRequest, OptimalOriginsResponse } from '@metro-meet/shared';
import { getCachedRoute, setCachedRoute } from './route-cache.js';
import { createAmapClientFromEnv } from './amap-client.js';

const PRECISE_CONCURRENCY = 3;

export type CalculationProgress = {
  phase: 'preparing' | 'computing' | 'ranking' | 'done';
  completed: number;
  total: number;
  cacheHitCount: number;
  failedQueryCount: number;
  currentFromStation?: string;
  currentToStation?: string;
};

export async function calculateOptimalOrigins(
  data: MetroData,
  request: OptimalOriginsRequest,
  onProgress?: (progress: CalculationProgress) => void
): Promise<OptimalOriginsResponse> {
  const startedAt = Date.now();
  const stationsById = new Map(data.stations.map((station) => [station.id, station]));
  const targets = request.targetStationIds.map((id) => stationsById.get(id)).filter((station) => station !== undefined);

  if (targets.length !== request.targetStationIds.length) {
    throw new Error('请求中包含未知目标站点');
  }

  const roughCandidates = roughRankCandidates(
    data,
    request.targetStationIds,
    request.mode,
    request.resultCount,
    request.excludeTargetStations
  );

  const total = roughCandidates.length * targets.length;

  onProgress?.({
    phase: 'preparing',
    completed: 0,
    total,
    cacheHitCount: 0,
    failedQueryCount: 0
  });

  const amapClient = createAmapClientFromEnv();
  const routesByCandidate = new Map<string, CommuteRoute[]>();
  let cacheHitCount = 0;
  let failedQueryCount = 0;
  let completed = 0;

  const emit = (currentFromStation?: string, currentToStation?: string) => {
    onProgress?.({
      phase: 'computing',
      completed,
      total,
      cacheHitCount,
      failedQueryCount,
      currentFromStation,
      currentToStation
    });
  };

  await runWithConcurrency(roughCandidates, PRECISE_CONCURRENCY, async (candidate) => {
    const routes: CommuteRoute[] = [];

    for (const target of targets) {
      const cached = await getCachedRoute(candidate.station.id, target.id);
      if (cached) {
        cacheHitCount += 1;
        completed += 1;
        routes.push(cached);
        emit(candidate.station.name, target.name);
        continue;
      }

      try {
        emit(candidate.station.name, target.name);
        const route = await amapClient.getRoute(candidate.station, target);
        await setCachedRoute(route);
        routes.push(route);
      } catch (error) {
        failedQueryCount += 1;
        const fallback = candidate.estimates.find((estimate) => estimate.toStationId === target.id);
        routes.push({
          ...(fallback
            ? fallbackEstimateRoute(fallback)
            : {
                fromStationId: candidate.station.id,
                toStationId: target.id,
                durationMinutes: 0,
                source: 'local-estimate' as const,
                updatedAt: new Date().toISOString()
              }),
          failed: true,
          errorMessage: error instanceof Error ? error.message : '未知 MCP 查询失败'
        });
      }

      completed += 1;
      emit(candidate.station.name, target.name);
    }

    routesByCandidate.set(candidate.station.id, routes);
  });

  onProgress?.({ phase: 'ranking', completed, total, cacheHitCount, failedQueryCount });

  const results = rankPreciseResults(stationsById, routesByCandidate).slice(0, request.resultCount);

  onProgress?.({ phase: 'done', completed, total, cacheHitCount, failedQueryCount });

  return {
    targets,
    results,
    meta: {
      mode: request.mode,
      candidateCount: roughCandidates.length,
      preciseQueryCount: completed - cacheHitCount,
      cacheHitCount,
      failedQueryCount,
      elapsedMs: Date.now() - startedAt
    }
  };
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(workers);
}
