import { describe, expect, it } from 'vitest';
import type { MetroData } from '@metro-meet/shared';
import { buildStationGraph, candidateLimit, estimateRoute, rankPreciseResults, roughRankCandidates } from './index.js';

const data: MetroData = {
  stations: [
    { id: 'a', name: 'A', lines: ['l1'], isTransfer: false },
    { id: 'b', name: 'B', lines: ['l1', 'l2'], isTransfer: true },
    { id: 'c', name: 'C', lines: ['l1'], isTransfer: false },
    { id: 'd', name: 'D', lines: ['l2'], isTransfer: false }
  ],
  lines: [
    { id: 'l1', name: '1号线', stationIds: ['a', 'b', 'c'] },
    { id: 'l2', name: '2号线', stationIds: ['b', 'd'] }
  ],
  edges: [
    { fromStationId: 'a', toStationId: 'b', lineId: 'l1' },
    { fromStationId: 'b', toStationId: 'c', lineId: 'l1' },
    { fromStationId: 'b', toStationId: 'd', lineId: 'l2' }
  ]
};

describe('core routing', () => {
  it('estimates same-line travel', () => {
    const graph = buildStationGraph(data);
    expect(estimateRoute(graph, 'a', 'c')?.durationMinutes).toBe(6);
  });

  it('adds transfer penalty', () => {
    const graph = buildStationGraph(data);
    const route = estimateRoute(graph, 'a', 'd');
    expect(route?.durationMinutes).toBe(12);
    expect(route?.transferCount).toBe(1);
  });

  it('limits rough candidates by mode', () => {
    expect(candidateLimit('fast', 10)).toBe(30);
    expect(candidateLimit('balanced', 10)).toBe(50);
    expect(candidateLimit('accurate', 10)).toBe(100);
  });

  it('can exclude target stations', () => {
    const candidates = roughRankCandidates(data, ['a', 'd'], 'fast', 10, true);
    expect(candidates.some((candidate) => candidate.station.id === 'a')).toBe(false);
  });

  it('penalizes failed precise routes', () => {
    const stations = new Map(data.stations.map((station) => [station.id, station]));
    const ranked = rankPreciseResults(
      stations,
      new Map([
        [
          'a',
          [
            {
              fromStationId: 'a',
              toStationId: 'd',
              durationMinutes: 10,
              source: 'amap-mcp',
              updatedAt: new Date().toISOString()
            }
          ]
        ],
        [
          'b',
          [
            {
              fromStationId: 'b',
              toStationId: 'd',
              durationMinutes: 1,
              source: 'amap-mcp',
              updatedAt: new Date().toISOString(),
              failed: true
            }
          ]
        ]
      ])
    );
    expect(ranked[0]?.station.id).toBe('a');
  });
});
