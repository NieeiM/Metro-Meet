import type {
  CalculationMode,
  CommuteRoute,
  MetroData,
  MetroStation,
  OptimalOriginResult
} from '@metro-meet/shared';

type GraphNeighbor = {
  stationId: string;
  lineId: string;
  weight: number;
};

export type MetroGraph = Map<string, GraphNeighbor[]>;

const DEFAULT_STATION_MINUTES = 3;
const DEFAULT_TRANSFER_MINUTES = 6;

export function buildStationGraph(data: MetroData): MetroGraph {
  const graph: MetroGraph = new Map();
  for (const station of data.stations) {
    graph.set(station.id, []);
  }

  for (const edge of data.edges) {
    graph.get(edge.fromStationId)?.push({
      stationId: edge.toStationId,
      lineId: edge.lineId,
      weight: DEFAULT_STATION_MINUTES
    });
    graph.get(edge.toStationId)?.push({
      stationId: edge.fromStationId,
      lineId: edge.lineId,
      weight: DEFAULT_STATION_MINUTES
    });
  }

  return graph;
}

export type LocalEstimate = {
  fromStationId: string;
  toStationId: string;
  durationMinutes: number;
  transferCount: number;
  lines: string[];
};

type QueueState = {
  stationId: string;
  lineId?: string;
  duration: number;
  transferCount: number;
  lines: string[];
};

export function estimateRoute(graph: MetroGraph, fromStationId: string, toStationId: string): LocalEstimate | null {
  if (fromStationId === toStationId) {
    return { fromStationId, toStationId, durationMinutes: 0, transferCount: 0, lines: [] };
  }

  const queue: QueueState[] = [{ stationId: fromStationId, duration: 0, transferCount: 0, lines: [] }];
  const best = new Map<string, number>();

  while (queue.length > 0) {
    queue.sort((a, b) => a.duration - b.duration);
    const current = queue.shift();
    if (!current) break;

    const key = `${current.stationId}:${current.lineId ?? 'start'}`;
    if ((best.get(key) ?? Number.POSITIVE_INFINITY) <= current.duration) continue;
    best.set(key, current.duration);

    if (current.stationId === toStationId) {
      return {
        fromStationId,
        toStationId,
        durationMinutes: current.duration,
        transferCount: current.transferCount,
        lines: [...new Set(current.lines)]
      };
    }

    for (const neighbor of graph.get(current.stationId) ?? []) {
      const isTransfer = current.lineId !== undefined && current.lineId !== neighbor.lineId;
      queue.push({
        stationId: neighbor.stationId,
        lineId: neighbor.lineId,
        duration: current.duration + neighbor.weight + (isTransfer ? DEFAULT_TRANSFER_MINUTES : 0),
        transferCount: current.transferCount + (isTransfer ? 1 : 0),
        lines: current.lines.includes(neighbor.lineId) ? current.lines : [...current.lines, neighbor.lineId]
      });
    }
  }

  return null;
}

export function candidateLimit(mode: CalculationMode, resultCount: number): number {
  if (mode === 'fast') return Math.max(30, resultCount * 3);
  if (mode === 'accurate') return Math.max(100, resultCount * 10);
  return Math.max(50, resultCount * 5);
}

export type RoughCandidate = {
  station: MetroStation;
  estimates: LocalEstimate[];
  score: number;
  maxDurationMinutes: number;
  averageTransferCount: number;
};

export function roughRankCandidates(
  data: MetroData,
  targetStationIds: string[],
  mode: CalculationMode,
  resultCount: number,
  excludeTargetStations: boolean
): RoughCandidate[] {
  const graph = buildStationGraph(data);
  const targetSet = new Set(targetStationIds);
  const candidates: RoughCandidate[] = [];

  for (const station of data.stations) {
    if (excludeTargetStations && targetSet.has(station.id)) continue;

    const estimates = targetStationIds
      .map((targetStationId) => estimateRoute(graph, station.id, targetStationId))
      .filter((estimate): estimate is LocalEstimate => estimate !== null);

    if (estimates.length !== targetStationIds.length) continue;

    const score = estimates.reduce((sum, estimate) => sum + estimate.durationMinutes, 0);
    const maxDurationMinutes = Math.max(...estimates.map((estimate) => estimate.durationMinutes));
    const averageTransferCount =
      estimates.reduce((sum, estimate) => sum + estimate.transferCount, 0) / estimates.length;

    candidates.push({ station, estimates, score, maxDurationMinutes, averageTransferCount });
  }

  return candidates
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (a.maxDurationMinutes !== b.maxDurationMinutes) return a.maxDurationMinutes - b.maxDurationMinutes;
      return a.averageTransferCount - b.averageTransferCount;
    })
    .slice(0, candidateLimit(mode, resultCount));
}

export function fallbackEstimateRoute(estimate: LocalEstimate): CommuteRoute {
  return {
    fromStationId: estimate.fromStationId,
    toStationId: estimate.toStationId,
    durationMinutes: estimate.durationMinutes,
    transferCount: estimate.transferCount,
    lines: estimate.lines,
    source: 'local-estimate',
    updatedAt: new Date().toISOString()
  };
}

export function rankPreciseResults(stationsById: Map<string, MetroStation>, routesByCandidate: Map<string, CommuteRoute[]>): OptimalOriginResult[] {
  const results: OptimalOriginResult[] = [];

  for (const [stationId, routes] of routesByCandidate.entries()) {
    const station = stationsById.get(stationId);
    if (!station) continue;

    const successfulRoutes = routes.filter((route) => !route.failed);
    const durations = successfulRoutes.map((route) => route.durationMinutes);
    const totalDurationMinutes = durations.reduce((sum, duration) => sum + duration, 0);
    const failedRouteCount = routes.length - successfulRoutes.length;
    const averageTransferCount =
      successfulRoutes.length === 0
        ? undefined
        : successfulRoutes.reduce((sum, route) => sum + (route.transferCount ?? 0), 0) / successfulRoutes.length;
    const failurePenalty = failedRouteCount * 10000;

    results.push({
      station,
      rank: 0,
      totalDurationMinutes,
      averageDurationMinutes: successfulRoutes.length === 0 ? 0 : totalDurationMinutes / successfulRoutes.length,
      maxDurationMinutes: durations.length === 0 ? 0 : Math.max(...durations),
      minDurationMinutes: durations.length === 0 ? 0 : Math.min(...durations),
      averageTransferCount,
      routes,
      cacheHitCount: routes.filter((route) => route.cacheHit).length,
      failedRouteCount,
      score: totalDurationMinutes + failurePenalty
    });
  }

  return results
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (a.maxDurationMinutes !== b.maxDurationMinutes) return a.maxDurationMinutes - b.maxDurationMinutes;
      return (a.averageTransferCount ?? Number.POSITIVE_INFINITY) - (b.averageTransferCount ?? Number.POSITIVE_INFINITY);
    })
    .map((result, index) => ({ ...result, rank: index + 1 }));
}
