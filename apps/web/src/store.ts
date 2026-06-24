import { create } from 'zustand';
import type { CalculationMode, MetroData, MetroStation, OptimalOriginResult, OptimalOriginsResponse } from '@metro-meet/shared';

export type CalculationProgress = {
  phase: string;
  completed: number;
  total: number;
  cacheHitCount: number;
  failedQueryCount: number;
  currentFromStation?: string;
  currentToStation?: string;
};

type AppState = {
  metro?: MetroData;
  focusedStationId?: string;
  selectedStationIds: string[];
  selectedResult?: OptimalOriginResult;
  focusedRouteToStationId?: string;
  results: OptimalOriginResult[];
  meta?: OptimalOriginsResponse['meta'];
  resultCount: number;
  mode: CalculationMode;
  excludeTargetStations: boolean;
  isLoading: boolean;
  error?: string;
  progress?: CalculationProgress;
  setMetro: (metro: MetroData) => void;
  setFocusedStation: (stationId: string | undefined) => void;
  addTargetStation: (stationId: string) => void;
  removeStation: (stationId: string) => void;
  clearSelection: () => void;
  setResultCount: (count: number) => void;
  setMode: (mode: CalculationMode) => void;
  setExcludeTargetStations: (value: boolean) => void;
  setSelectedResult: (result: OptimalOriginResult | undefined) => void;
  setFocusedRoute: (toStationId: string | undefined) => void;
  setCalculationState: (state: Partial<Pick<AppState, 'isLoading' | 'error' | 'results' | 'meta' | 'progress'>>) => void;
};

export const useAppStore = create<AppState>((set, get) => ({
  selectedStationIds: JSON.parse(localStorage.getItem('metro-meet:selectedStationIds') ?? '[]') as string[],
  results: [],
  resultCount: 5,
  mode: 'balanced',
  excludeTargetStations: true,
  isLoading: false,
  setMetro: (metro) => set({ metro }),
  setFocusedStation: (focusedStationId) => set({ focusedStationId }),
  addTargetStation: (stationId) => {
    const selected = get().selectedStationIds;
    if (selected.includes(stationId)) return;
    const next = [...selected, stationId];
    localStorage.setItem('metro-meet:selectedStationIds', JSON.stringify(next));
    set({ selectedStationIds: next, selectedResult: undefined });
  },
  removeStation: (stationId) => {
    const next = get().selectedStationIds.filter((id) => id !== stationId);
    localStorage.setItem('metro-meet:selectedStationIds', JSON.stringify(next));
    set({ selectedStationIds: next, selectedResult: undefined });
  },
  clearSelection: () => {
    localStorage.removeItem('metro-meet:selectedStationIds');
    set({ selectedStationIds: [], selectedResult: undefined, results: [], meta: undefined });
  },
  setResultCount: (resultCount) => set({ resultCount }),
  setMode: (mode) => set({ mode }),
  setExcludeTargetStations: (excludeTargetStations) => set({ excludeTargetStations }),
  setSelectedResult: (selectedResult) => set({ selectedResult, focusedRouteToStationId: undefined }),
  setFocusedRoute: (focusedRouteToStationId) => set({ focusedRouteToStationId }),
  setCalculationState: (state) => set(state)
}));

export function stationLabel(station: MetroStation): string {
  return `${station.name} · ${station.lines.map((line) => line.replace('line-', '')).join('/')}`;
}
