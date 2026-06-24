import { z } from 'zod';

export const metroStationSchema = z.object({
  id: z.string(),
  name: z.string(),
  lines: z.array(z.string()),
  lng: z.number().optional(),
  lat: z.number().optional(),
  mapX: z.number().optional(),
  mapY: z.number().optional(),
  schematicX: z.number().optional(),
  schematicY: z.number().optional(),
  isTransfer: z.boolean()
});

export const metroLineSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().optional(),
  stationIds: z.array(z.string()),
  schematicSegments: z
    .array(
      z.object({
        fromStationId: z.string(),
        toStationId: z.string(),
        x1: z.number(),
        y1: z.number(),
        x2: z.number(),
        y2: z.number(),
        slotIndex: z.number().optional(),
        slotCount: z.number().optional()
      })
    )
    .optional()
});

export const metroEdgeSchema = z.object({
  fromStationId: z.string(),
  toStationId: z.string(),
  lineId: z.string()
});

export const metroDataSchema = z.object({
  stations: z.array(metroStationSchema),
  lines: z.array(metroLineSchema),
  edges: z.array(metroEdgeSchema)
});

export const optimalOriginsRequestSchema = z.object({
  targetStationIds: z.array(z.string()).min(1),
  resultCount: z.number().int().min(1).max(50).default(10),
  mode: z.enum(['fast', 'balanced', 'accurate']).default('balanced'),
  excludeTargetStations: z.boolean().default(true)
});

export type MetroStation = z.infer<typeof metroStationSchema>;
export type MetroLine = z.infer<typeof metroLineSchema>;
export type MetroEdge = z.infer<typeof metroEdgeSchema>;
export type MetroData = z.infer<typeof metroDataSchema>;
export type CalculationMode = 'fast' | 'balanced' | 'accurate';
export type OptimalOriginsRequest = z.infer<typeof optimalOriginsRequestSchema>;

export type RouteStep = {
  type: 'subway' | 'walk' | 'transfer' | 'other';
  lineName?: string;
  fromStationName?: string;
  toStationName?: string;
  durationMinutes?: number;
  description?: string;
};

export type CommuteRoute = {
  fromStationId: string;
  toStationId: string;
  durationMinutes: number;
  transferCount?: number;
  lines?: string[];
  transferStations?: string[];
  steps?: RouteStep[];
  raw?: unknown;
  source: 'amap-mcp' | 'local-estimate';
  updatedAt: string;
  cacheHit?: boolean;
  failed?: boolean;
  errorMessage?: string;
};

export type OptimalOriginResult = {
  station: MetroStation;
  rank: number;
  totalDurationMinutes: number;
  averageDurationMinutes: number;
  maxDurationMinutes: number;
  minDurationMinutes: number;
  averageTransferCount?: number;
  routes: CommuteRoute[];
  cacheHitCount: number;
  failedRouteCount: number;
  score: number;
};

export type OptimalOriginsResponse = {
  targets: MetroStation[];
  results: OptimalOriginResult[];
  meta: {
    mode: CalculationMode;
    candidateCount: number;
    preciseQueryCount: number;
    cacheHitCount: number;
    failedQueryCount: number;
    elapsedMs: number;
  };
};
