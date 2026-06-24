import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertCircle, Eraser, Plus, Play, Search, Trash2, X } from 'lucide-react';
import type { MetroData, MetroEdge, MetroLine, MetroStation, OptimalOriginResult, OptimalOriginsResponse, RouteStep } from '@metro-meet/shared';
import { stationLabel, useAppStore } from './store';
import type { CalculationProgress } from './store';
import './styles.css';

type MapLayoutMode = 'schematic' | 'geo';
const BASE_GRID_SIZE = 32;
const DEFAULT_GRID_SIZE = 90;
const MAP_VIEWBOX_WIDTH = 2300;
const MAP_VIEWBOX_HEIGHT = 1740;
const DEFAULT_GEO_SCALE = 4;
const DEFAULT_GEO_LINE_WIDTH = 4;
const DEFAULT_GEO_LABEL_SIZE = 24;
const KEYBOARD_PAN_STEP = 42;
const MAP_ZOOM_LIMITS: Record<MapLayoutMode, { min: number; max: number; step: number }> = {
  schematic: { min: 0.55, max: 1.8, step: 0.08 },
  geo: { min: 0.55, max: 12, step: 0.18 }
};

function App() {
  const metro = useAppStore((state) => state.metro);
  const setMetro = useAppStore((state) => state.setMetro);
  const selectedStationIds = useAppStore((state) => state.selectedStationIds);
  const error = useAppStore((state) => state.error);
  const setCalculationState = useAppStore((state) => state.setCalculationState);

  useEffect(() => {
    fetch('/api/metro/shanghai')
      .then((response) => {
        if (!response.ok) throw new Error('地铁数据加载失败');
        return response.json() as Promise<MetroData>;
      })
      .then(setMetro)
      .catch((loadError: unknown) => {
        setCalculationState({ error: loadError instanceof Error ? loadError.message : '地铁数据加载失败' });
      });
  }, [setCalculationState, setMetro]);

  return (
    <main className="app-shell">
      <section className="map-pane" aria-label="上海地铁图">
        {metro ? <MetroMap metro={metro} /> : <div className="loading">加载地铁数据...</div>}
      </section>
      <aside className="side-pane">
        <header className="app-header">
          <p>MetroMeet 上海</p>
          <h1>多目的地地铁通勤最优起点</h1>
        </header>
        {error ? (
          <div className="notice" role="alert">
            <AlertCircle size={18} />
            <span>{error}</span>
          </div>
        ) : null}
        <SelectionPanel />
        <Controls disabled={!metro || selectedStationIds.length === 0} />
        <ResultsPanel />
      </aside>
    </main>
  );
}

function MetroMap({ metro }: { metro: MetroData }) {
  const selectedStationIds = useAppStore((state) => state.selectedStationIds);
  const focusedStationId = useAppStore((state) => state.focusedStationId);
  const selectedResult = useAppStore((state) => state.selectedResult);
  const focusedRouteToStationId = useAppStore((state) => state.focusedRouteToStationId);
  const setFocusedStation = useAppStore((state) => state.setFocusedStation);
  const svgRef = useRef<SVGSVGElement>(null);
  const layoutMode: MapLayoutMode = 'geo';
  const gridSize = DEFAULT_GRID_SIZE;
  const [geoLineWidth, setGeoLineWidth] = useState(DEFAULT_GEO_LINE_WIDTH);
  const [geoLabelSize, setGeoLabelSize] = useState(DEFAULT_GEO_LABEL_SIZE);
  const [view, setView] = useState(() => initialGeoView(metro.stations));
  const [drag, setDrag] = useState<{ x: number; y: number }>();

  const activeRoutes = useMemo(() => {
    const routes = selectedResult?.routes ?? [];
    if (!focusedRouteToStationId) return routes;
    return routes.filter((r) => r.toStationId === focusedRouteToStationId);
  }, [selectedResult, focusedRouteToStationId]);

  const stationNameToId = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of metro.stations) map.set(s.name, s.id);
    return map;
  }, [metro.stations]);

  const stationIdToName = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of metro.stations) map.set(s.id, s.name);
    return map;
  }, [metro.stations]);

  const highlightedSegments = useMemo(() => {
    const segs = new Set<string>();
    for (const route of activeRoutes) {
      for (const step of route.steps ?? []) {
        if (step.type !== 'subway') continue;
        if (!step.fromStationName || !step.toStationName || !step.lineName) continue;

        const fromId = resolveStationId(step.fromStationName, stationNameToId);
        const toId = resolveStationId(step.toStationName, stationNameToId);
        if (!fromId || !toId) continue;

        const matchedLine = metro.lines.find((l) => matchMCPLine(step.lineName!, l.name));
        if (!matchedLine) continue;

        const idx1 = matchedLine.stationIds.indexOf(fromId);
        const idx2 = matchedLine.stationIds.indexOf(toId);
        if (idx1 === -1 || idx2 === -1) continue;

        const start = Math.min(idx1, idx2);
        const end = Math.max(idx1, idx2);
        for (let i = start; i < end; i++) {
          const a = matchedLine.stationIds[i];
          const b = matchedLine.stationIds[i + 1];
          if (a && b) segs.add(`${matchedLine.id}:${a}:${b}`);
        }
      }
    }
    return segs;
  }, [metro.lines, activeRoutes, stationNameToId]);

  const walkingSegments = useMemo(() => {
    const segments: Array<{ fromStationId: string; toStationId: string; durationMinutes?: number }> = [];
    for (const route of activeRoutes) {
      const steps = route.steps ?? [];
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        if (!step) continue;
        if (step.type !== 'walk') continue;
        const endpoints = walkingStepEndpoints(route.fromStationId, route.toStationId, steps, index, stationIdToName);
        if (!endpoints.fromStationName || !endpoints.toStationName) continue;
        const fromId = resolveStationId(endpoints.fromStationName, stationNameToId);
        const toId = resolveStationId(endpoints.toStationName, stationNameToId);
        if (!fromId || !toId || fromId === toId) continue;
        segments.push({ fromStationId: fromId, toStationId: toId, durationMinutes: step.durationMinutes });
      }
    }
    return segments;
  }, [activeRoutes, stationIdToName, stationNameToId]);

  const hasAnyHighlight = highlightedSegments.size > 0;

  const routeStationIds = useMemo(() => {
    const ids = new Set<string>();
    for (const route of activeRoutes) {
      ids.add(route.fromStationId);
      ids.add(route.toStationId);
    }
    for (const key of highlightedSegments) {
      const parts = key.split(':');
      if (parts[1]) ids.add(parts[1]);
      if (parts[2]) ids.add(parts[2]);
    }
    for (const segment of walkingSegments) {
      ids.add(segment.fromStationId);
      ids.add(segment.toStationId);
    }
    return ids;
  }, [activeRoutes, highlightedSegments, walkingSegments]);

  const selectedSet = new Set(selectedStationIds);

  return (
    <div
      className="map-stage"
      tabIndex={0}
      onPointerDown={(event) => {
        event.currentTarget.focus();
        setDrag({ x: event.clientX, y: event.clientY });
      }}
      onPointerMove={(event) => {
        if (!drag) return;
        setView((current) => ({
          ...current,
          x: current.x + event.clientX - drag.x,
          y: current.y + event.clientY - drag.y
        }));
        setDrag({ x: event.clientX, y: event.clientY });
      }}
      onPointerUp={() => setDrag(undefined)}
      onPointerLeave={() => setDrag(undefined)}
      onWheel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const limits = MAP_ZOOM_LIMITS[layoutMode];
        const focalPoint = svgPointFromClient(svgRef.current, event.clientX, event.clientY);
        setView((current) => ({
          ...zoomViewAtPoint(
            current,
            clamp(current.scale + (event.deltaY > 0 ? -limits.step : limits.step), limits.min, limits.max),
            focalPoint ?? mapCenterPoint()
          )
        }));
      }}
      onKeyDown={(event) => {
        if (isKeyboardControlTarget(event.target)) return;

        const key = event.key.toLowerCase();
        if (key === 'e') {
          event.preventDefault();
          setView(initialGeoView(metro.stations));
          return;
        }

        const delta =
          key === 'w' || key === 'arrowup' ? { x: 0, y: KEYBOARD_PAN_STEP } :
          key === 's' || key === 'arrowdown' ? { x: 0, y: -KEYBOARD_PAN_STEP } :
          key === 'a' || key === 'arrowleft' ? { x: KEYBOARD_PAN_STEP, y: 0 } :
          key === 'd' || key === 'arrowright' ? { x: -KEYBOARD_PAN_STEP, y: 0 } :
          undefined;

        if (!delta) return;
        event.preventDefault();
        setView((current) => ({
          ...current,
          x: current.x + delta.x,
          y: current.y + delta.y
        }));
      }}
    >
      <div className="map-toolbar" role="group" aria-label="地图视图" onPointerDown={(event) => event.stopPropagation()}>
        <span className="map-mode-label">地理图</span>
        <label className="grid-slider">
          <span>缩放 {view.scale.toFixed(2)}x</span>
          <input
            type="range"
            min={MAP_ZOOM_LIMITS.geo.min}
            max={MAP_ZOOM_LIMITS.geo.max}
            step={0.05}
            value={view.scale}
            onChange={(event) => {
              const nextScale = Number(event.target.value);
              setView((current) => zoomViewAtPoint(current, nextScale, mapCenterPoint()));
            }}
          />
        </label>
        <label className="grid-slider">
          <span>线宽 {geoLineWidth}px</span>
          <input
            type="range"
            min={2}
            max={18}
            step={1}
            value={geoLineWidth}
            disabled={layoutMode !== 'geo'}
            onChange={(event) => setGeoLineWidth(Number(event.target.value))}
          />
        </label>
        <label className="grid-slider">
          <span>站名 {geoLabelSize}px</span>
          <input
            type="range"
            min={9}
            max={28}
            step={1}
            value={geoLabelSize}
            disabled={layoutMode !== 'geo'}
            onChange={(event) => setGeoLabelSize(Number(event.target.value))}
          />
        </label>
      </div>
      <div className="map-key-hints" aria-label="地图快捷键提示">
        <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / 方向键 移动</span>
        <span><kbd>E</kbd> 回到人民广场</span>
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${MAP_VIEWBOX_WIDTH} ${MAP_VIEWBOX_HEIGHT}`} role="img" aria-label="上海地铁线路地理图">
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {metro.lines.map((line) => (
            <LinePath
              key={line.id}
              line={line}
              stations={metro.stations}
              edges={metro.edges}
              layoutMode={layoutMode}
              gridSize={gridSize}
              geoLineWidth={geoLineWidth}
              highlightedSegments={highlightedSegments}
              hasAnyHighlight={hasAnyHighlight}
            />
          ))}
          <WalkingSegments segments={walkingSegments} stations={metro.stations} layoutMode={layoutMode} gridSize={gridSize} />
          {metro.stations.map((station, index) => (
            <StationNode
              key={station.id}
              station={station}
              selectedIndex={selectedStationIds.indexOf(station.id)}
              isResultOrigin={selectedResult?.station.id === station.id}
              isRouteStation={routeStationIds.has(station.id)}
              isSelected={selectedSet.has(station.id)}
              isFocused={focusedStationId === station.id}
              layoutMode={layoutMode}
              gridSize={gridSize}
              viewScale={view.scale}
              geoLabelSize={geoLabelSize}
              onClick={() => setFocusedStation(station.id)}
              labelOffset={index % 2 === 0 ? -10 : 18}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function initialGeoView(stations: MetroStation[]) {
  const centerStation = stations.find((station) => station.name === '人民广场');
  const point = centerStation ? getStationPoint(centerStation, 'geo') : undefined;
  const center = mapCenterPoint();
  return {
    x: point ? center.x - point.x * DEFAULT_GEO_SCALE : 0,
    y: point ? center.y - point.y * DEFAULT_GEO_SCALE : 20,
    scale: DEFAULT_GEO_SCALE
  };
}

function mapCenterPoint() {
  return { x: MAP_VIEWBOX_WIDTH / 2, y: MAP_VIEWBOX_HEIGHT / 2 };
}

function svgPointFromClient(svg: SVGSVGElement | null, clientX: number, clientY: number) {
  if (!svg) return undefined;
  const rect = svg.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return undefined;
  return {
    x: ((clientX - rect.left) / rect.width) * MAP_VIEWBOX_WIDTH,
    y: ((clientY - rect.top) / rect.height) * MAP_VIEWBOX_HEIGHT
  };
}

function zoomViewAtPoint(view: { x: number; y: number; scale: number }, nextScale: number, focalPoint: { x: number; y: number }) {
  const mapX = (focalPoint.x - view.x) / view.scale;
  const mapY = (focalPoint.y - view.y) / view.scale;
  return {
    x: focalPoint.x - mapX * nextScale,
    y: focalPoint.y - mapY * nextScale,
    scale: nextScale
  };
}

function isKeyboardControlTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('button, input, textarea, select, [contenteditable="true"]'));
}

function LinePath({ line, stations, edges, layoutMode, gridSize, geoLineWidth, highlightedSegments, hasAnyHighlight }: { line: MetroLine; stations: MetroStation[]; edges: MetroEdge[]; layoutMode: MapLayoutMode; gridSize: number; geoLineWidth: number; highlightedSegments: Set<string>; hasAnyHighlight: boolean }) {
  if (layoutMode === 'schematic' && line.schematicSegments?.length) {
    const hasLineHighlight = line.schematicSegments.some(
      (seg) => highlightedSegments.has(`${line.id}:${seg.fromStationId}:${seg.toStationId}`)
    );
    const groupMuted = hasAnyHighlight && !hasLineHighlight;

    return (
      <g className={groupMuted ? 'line-group muted' : 'line-group'}>
        {line.schematicSegments.map((segment, index) => {
          const segKey = `${line.id}:${segment.fromStationId}:${segment.toStationId}`;
          const isHighlighted = !hasAnyHighlight || highlightedSegments.has(segKey);
          const rendered = renderSegmentSlot(scaleSchematicSegment(segment, gridSize));
          const baseClass = rendered.slotCount > 1 ? 'line segment shared' : 'line segment';
          return (
            <line
              key={`${segment.fromStationId}-${segment.toStationId}-${index}`}
              className={isHighlighted ? baseClass : `${baseClass} muted-segment`}
              x1={rendered.x1}
              y1={rendered.y1}
              x2={rendered.x2}
              y2={rendered.y2}
              stroke={line.color ?? '#555'}
            />
          );
        })}
      </g>
    );
  }

  const stationById = new Map(stations.map((station) => [station.id, station]));
  const lineEdges = edges.filter((edge) => edge.lineId === line.id);
  const sharedEdgeSlots = buildSharedEdgeSlots(edges);
  const hasLineHighlight = lineEdges.some((edge) => isHighlightedSegment(line.id, edge.fromStationId, edge.toStationId, highlightedSegments));
  const groupMuted = hasAnyHighlight && !hasLineHighlight;

  return (
    <g className={groupMuted ? 'line-group muted' : 'line-group'}>
      {lineEdges.map((edge, index) => {
        const from = stationById.get(edge.fromStationId);
        const to = stationById.get(edge.toStationId);
        const fromPoint = from ? getStationPoint(from, layoutMode, gridSize) : undefined;
        const toPoint = to ? getStationPoint(to, layoutMode, gridSize) : undefined;
        if (!fromPoint || !toPoint) return null;

        const slot = sharedEdgeSlots.get(sharedEdgeKey(edge.fromStationId, edge.toStationId, edge.lineId));
        const rendered = slot ? renderSharedGeoEdge(fromPoint, toPoint, slot.slotIndex, slot.slotCount, geoLineWidth) : {
          x1: fromPoint.x,
          y1: fromPoint.y,
          x2: toPoint.x,
          y2: toPoint.y,
          strokeWidth: geoLineWidth
        };
        const isHighlighted = !hasAnyHighlight || isHighlightedSegment(line.id, edge.fromStationId, edge.toStationId, highlightedSegments);
        return (
          <line
            key={`${edge.fromStationId}-${edge.toStationId}-${index}`}
            className={isHighlighted ? 'line' : 'line muted-segment'}
            x1={rendered.x1}
            y1={rendered.y1}
            x2={rendered.x2}
            y2={rendered.y2}
            stroke={line.color ?? '#555'}
            style={{ strokeWidth: isHighlighted ? rendered.strokeWidth : Math.max(1.5, rendered.strokeWidth - 2) }}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </g>
  );
}

function buildSharedEdgeSlots(edges: MetroEdge[]) {
  const grouped = new Map<string, MetroEdge[]>();
  for (const edge of edges) {
    const key = edgePairKey(edge.fromStationId, edge.toStationId);
    const group = grouped.get(key) ?? [];
    group.push(edge);
    grouped.set(key, group);
  }

  const slots = new Map<string, { slotIndex: number; slotCount: number }>();
  for (const group of grouped.values()) {
    const lineIds = [...new Set(group.map((edge) => edge.lineId))].sort(compareMetroLineIds);
    if (lineIds.length <= 1) continue;
    for (const edge of group) {
      slots.set(sharedEdgeKey(edge.fromStationId, edge.toStationId, edge.lineId), {
        slotIndex: lineIds.indexOf(edge.lineId),
        slotCount: lineIds.length
      });
    }
  }
  return slots;
}

function renderSharedGeoEdge(from: { x: number; y: number }, to: { x: number; y: number }, slotIndex: number, slotCount: number, lineWidth: number) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const normal = { x: -dy / length, y: dx / length };
  const strokeWidth = Math.max(1.5, lineWidth / slotCount);
  const offset = (slotIndex - (slotCount - 1) / 2) * strokeWidth;
  return {
    x1: Math.round(from.x + normal.x * offset),
    y1: Math.round(from.y + normal.y * offset),
    x2: Math.round(to.x + normal.x * offset),
    y2: Math.round(to.y + normal.y * offset),
    strokeWidth
  };
}

function sharedEdgeKey(fromStationId: string, toStationId: string, lineId: string) {
  return `${edgePairKey(fromStationId, toStationId)}|${lineId}`;
}

function edgePairKey(fromStationId: string, toStationId: string) {
  return [fromStationId, toStationId].sort().join('|');
}

function compareMetroLineIds(a: string, b: string) {
  const aNumber = Number(a.replace('line-', ''));
  const bNumber = Number(b.replace('line-', ''));
  if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
  if (Number.isFinite(aNumber)) return -1;
  if (Number.isFinite(bNumber)) return 1;
  return a.localeCompare(b);
}

function WalkingSegments({ segments, stations, layoutMode, gridSize }: { segments: Array<{ fromStationId: string; toStationId: string; durationMinutes?: number }>; stations: MetroStation[]; layoutMode: MapLayoutMode; gridSize: number }) {
  if (segments.length === 0) return null;

  const stationById = new Map(stations.map((station) => [station.id, station]));
  return (
    <g className="walking-segments">
      {segments.map((segment, index) => {
        const from = stationById.get(segment.fromStationId);
        const to = stationById.get(segment.toStationId);
        const fromPoint = from ? getStationPoint(from, layoutMode, gridSize) : undefined;
        const toPoint = to ? getStationPoint(to, layoutMode, gridSize) : undefined;
        if (!fromPoint || !toPoint) return null;

        return (
          <line
            key={`${segment.fromStationId}-${segment.toStationId}-${index}`}
            className="walking-line"
            x1={fromPoint.x}
            y1={fromPoint.y}
            x2={toPoint.x}
            y2={toPoint.y}
            vectorEffect="non-scaling-stroke"
          >
            <title>{segment.durationMinutes ? `步行 ${segment.durationMinutes} 分钟` : '步行'}</title>
          </line>
        );
      })}
    </g>
  );
}

function walkingStepEndpoints(fromStationId: string, toStationId: string, steps: RouteStep[], stepIndex: number, stationIdToName: Map<string, string>) {
  const step = steps[stepIndex];
  let fromStationName = step?.fromStationName;
  let toStationName = step?.toStationName;

  if (!fromStationName) {
    for (let index = stepIndex - 1; index >= 0; index -= 1) {
      const previous = steps[index];
      if (previous?.type === 'subway' && previous.toStationName) {
        fromStationName = previous.toStationName;
        break;
      }
    }
    fromStationName ??= stationIdToName.get(fromStationId);
  }

  if (!toStationName) {
    for (let index = stepIndex + 1; index < steps.length; index += 1) {
      const next = steps[index];
      if (next?.type === 'subway' && next.fromStationName) {
        toStationName = next.fromStationName;
        break;
      }
    }
    toStationName ??= stationIdToName.get(toStationId);
  }

  return { fromStationName, toStationName };
}

function isHighlightedSegment(lineId: string, fromStationId: string, toStationId: string, highlightedSegments: Set<string>) {
  return highlightedSegments.has(`${lineId}:${fromStationId}:${toStationId}`) || highlightedSegments.has(`${lineId}:${toStationId}:${fromStationId}`);
}

function renderSegmentSlot(segment: NonNullable<MetroLine['schematicSegments']>[number]) {
  const slotCount = segment.slotCount ?? 1;
  if (slotCount <= 1) return { ...segment, slotCount };

  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const length = Math.hypot(dx, dy) || 1;
  const normal = { x: -dy / length, y: dx / length };
  const slotIndex = segment.slotIndex ?? 0;
  const offset = (slotIndex - (slotCount - 1) / 2) * 4.5;

  return {
    ...segment,
    slotCount,
    x1: Math.round(segment.x1 + normal.x * offset),
    y1: Math.round(segment.y1 + normal.y * offset),
    x2: Math.round(segment.x2 + normal.x * offset),
    y2: Math.round(segment.y2 + normal.y * offset)
  };
}

function scaleSchematicSegment(segment: NonNullable<MetroLine['schematicSegments']>[number], gridSize: number) {
  const scale = gridSize / BASE_GRID_SIZE;
  return {
    ...segment,
    x1: Math.round(segment.x1 * scale),
    y1: Math.round(segment.y1 * scale),
    x2: Math.round(segment.x2 * scale),
    y2: Math.round(segment.y2 * scale)
  };
}

function StationNode({
  station,
  selectedIndex,
  isResultOrigin,
  isRouteStation,
  isSelected,
  isFocused,
  layoutMode,
  gridSize,
  viewScale,
  geoLabelSize,
  onClick,
  labelOffset
}: {
  station: MetroStation;
  selectedIndex: number;
  isResultOrigin: boolean;
  isRouteStation: boolean;
  isSelected: boolean;
  isFocused: boolean;
  layoutMode: MapLayoutMode;
  gridSize: number;
  viewScale: number;
  geoLabelSize: number;
  onClick: () => void;
  labelOffset: number;
}) {
  const { x, y } = getStationPoint(station, layoutMode, gridSize) ?? { x: 0, y: 0 };
  const visualScale = layoutMode === 'geo' ? 1 / viewScale : 1;
  const className = ['station', station.isTransfer ? 'transfer' : '', isSelected ? 'selected' : '', isFocused ? 'focused' : '', isResultOrigin ? 'origin' : '', isRouteStation ? 'route' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <g className={className} transform={`translate(${x} ${y}) scale(${visualScale})`} onClick={(event) => {
      event.stopPropagation();
      onClick();
    }}>
      {station.isTransfer ? <rect className="transfer-symbol" x="-8" y="-8" width="16" height="16" rx="2.5" /> : null}
      <circle r={station.isTransfer ? 5.4 : 5.5} />
      {selectedIndex >= 0 ? <text className="station-index" y="3">{selectedIndex + 1}</text> : null}
      <text
        className="station-label"
        x={labelOffset < 0 ? -12 : 12}
        y={labelOffset}
        textAnchor={labelOffset < 0 ? 'end' : 'start'}
        style={layoutMode === 'geo' ? { fontSize: geoLabelSize } : undefined}
      >
        {station.name}
      </text>
      <title>{stationLabel(station)}</title>
    </g>
  );
}

function getStationPoint(station: MetroStation, layoutMode: MapLayoutMode, gridSize = BASE_GRID_SIZE): { x: number; y: number } | undefined {
  if (layoutMode === 'schematic' && station.schematicX !== undefined && station.schematicY !== undefined) {
    const scale = gridSize / BASE_GRID_SIZE;
    return { x: Math.round(station.schematicX * scale), y: Math.round(station.schematicY * scale) };
  }
  if (station.mapX !== undefined && station.mapY !== undefined) {
    return { x: station.mapX, y: station.mapY };
  }
  if (station.schematicX !== undefined && station.schematicY !== undefined) {
    return { x: station.schematicX, y: station.schematicY };
  }
  return undefined;
}

function SelectionPanel() {
  const metro = useAppStore((state) => state.metro);
  const focusedStationId = useAppStore((state) => state.focusedStationId);
  const selectedStationIds = useAppStore((state) => state.selectedStationIds);
  const setFocusedStation = useAppStore((state) => state.setFocusedStation);
  const addTargetStation = useAppStore((state) => state.addTargetStation);
  const removeStation = useAppStore((state) => state.removeStation);
  const clearSelection = useAppStore((state) => state.clearSelection);
  const [query, setQuery] = useState('');
  const stationsById = new Map(metro?.stations.map((station) => [station.id, station]) ?? []);
  const lineNameById = new Map(metro?.lines.map((line) => [line.id, line.name]) ?? []);
  const focusedStation = focusedStationId ? stationsById.get(focusedStationId) : undefined;
  const selectedSet = new Set(selectedStationIds);
  const formatLines = (station: MetroStation) => station.lines.map((lineId) => lineNameById.get(lineId) ?? lineId).join(' / ');
  const searchResults = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!metro || normalized.length === 0) return [];
    return metro.stations
      .filter((station) => `${station.name} ${station.lines.map((lineId) => lineNameById.get(lineId) ?? lineId).join(' ')}`.toLowerCase().includes(normalized))
      .slice(0, 8);
  }, [lineNameById, metro, query]);

  return (
    <section className="panel">
      <div className="panel-title">
        <h2>目标站</h2>
        <button className="icon-button" type="button" onClick={clearSelection} title="清空选择" aria-label="清空选择">
          <Eraser size={17} />
        </button>
      </div>
      <div className="station-search">
        <Search size={16} />
        <input
          type="search"
          placeholder="搜索站名或线路"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {searchResults.length > 0 ? (
        <div className="search-results">
          {searchResults.map((station) => (
            <button
              key={station.id}
              type="button"
              className="search-result"
              onClick={() => {
                setFocusedStation(station.id);
                setQuery('');
              }}
            >
              <span>{station.name}</span>
              <small>{formatLines(station)}</small>
            </button>
          ))}
        </div>
      ) : null}
      {focusedStation ? (
        <div className="station-info">
          <div>
            <h3>{focusedStation.name}</h3>
            <p>{formatLines(focusedStation)}</p>
            <span>{focusedStation.isTransfer ? '换乘站' : '普通站'}</span>
          </div>
          {selectedSet.has(focusedStation.id) ? (
            <button className="secondary-button compact" type="button" onClick={() => removeStation(focusedStation.id)}>
              <X size={16} />
              移除
            </button>
          ) : (
            <button className="primary-button compact" type="button" onClick={() => addTargetStation(focusedStation.id)}>
              <Plus size={16} />
              添加
            </button>
          )}
        </div>
      ) : (
        <p className="empty">点击地图站点或搜索站名查看详情。</p>
      )}
      {selectedStationIds.length === 0 ? (
        <p className="empty">添加目标站后可开始计算。</p>
      ) : (
        <ol className="selected-list">
          {selectedStationIds.map((id) => {
            const station = stationsById.get(id);
            if (!station) return null;
            return (
              <li key={id}>
                <span>{station.name}</span>
                <button className="icon-button small" type="button" onClick={() => removeStation(id)} title="删除" aria-label={`删除 ${station.name}`}>
                  <X size={15} />
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function Controls({ disabled }: { disabled: boolean }) {
  const selectedStationIds = useAppStore((state) => state.selectedStationIds);
  const resultCount = useAppStore((state) => state.resultCount);
  const mode = useAppStore((state) => state.mode);
  const excludeTargetStations = useAppStore((state) => state.excludeTargetStations);
  const isLoading = useAppStore((state) => state.isLoading);
  const progress = useAppStore((state) => state.progress);
  const setResultCount = useAppStore((state) => state.setResultCount);
  const setMode = useAppStore((state) => state.setMode);
  const setExcludeTargetStations = useAppStore((state) => state.setExcludeTargetStations);
  const setCalculationState = useAppStore((state) => state.setCalculationState);
  const setSelectedResult = useAppStore((state) => state.setSelectedResult);
  const [resultCountInput, setResultCountInput] = useState(String(resultCount));

  useEffect(() => {
    setResultCountInput(String(resultCount));
  }, [resultCount]);

  async function calculate() {
    const normalizedResultCount = normalizeResultCount(resultCountInput, resultCount);
    setResultCount(normalizedResultCount);
    setCalculationState({ isLoading: true, error: undefined, progress: undefined });
    setSelectedResult(undefined);
    try {
      const response = await fetch('/api/optimal-origins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetStationIds: selectedStationIds, resultCount: normalizedResultCount, mode, excludeTargetStations })
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        throw new Error(payload.error ?? '计算失败');
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';

        for (const event of events) {
          const parsed = parseSSEEvent(event);
          if (!parsed) continue;

          if (parsed.type === 'progress') {
            setCalculationState({ progress: parsed.data as CalculationProgress });
          } else if (parsed.type === 'result') {
            const data = parsed.data as OptimalOriginsResponse;
            setCalculationState({ results: data.results, meta: data.meta, isLoading: false, progress: undefined });
            setSelectedResult(data.results[0]);
          } else if (parsed.type === 'error') {
            setCalculationState({ isLoading: false, progress: undefined, error: (parsed.data as { message: string }).message });
          }
        }
      }
    } catch (error) {
      setCalculationState({ isLoading: false, progress: undefined, error: error instanceof Error ? error.message : '计算失败' });
    }
  }

  async function clearCache() {
    await fetch('/api/cache/clear', { method: 'POST' });
  }

  const pct = progress && progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;

  return (
    <section className="panel controls">
      <label>
        候选数量
        <input
          type="number"
          min={1}
          max={50}
          value={resultCountInput}
          onChange={(event) => {
            const value = event.target.value;
            setResultCountInput(value);
            const parsed = Number(value);
            if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 50) {
              setResultCount(parsed);
            }
          }}
          onBlur={() => {
            const normalized = normalizeResultCount(resultCountInput, resultCount);
            setResultCount(normalized);
            setResultCountInput(String(normalized));
          }}
        />
      </label>
      <label>
        计算模式
        <select value={mode} onChange={(event) => setMode(event.target.value as 'fast' | 'balanced' | 'accurate')}>
          <option value="fast">快速</option>
          <option value="balanced">平衡</option>
          <option value="accurate">精确</option>
        </select>
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={excludeTargetStations}
          onChange={(event) => setExcludeTargetStations(event.target.checked)}
        />
        排除目标站本身
      </label>
      {isLoading && progress ? (
        <div className="progress-block">
          <div className="progress-bar-track">
            <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="progress-stats">
            <span>{progress.completed} / {progress.total} ({pct}%)</span>
            <span>缓存 {progress.cacheHitCount}</span>
            {progress.failedQueryCount > 0 ? <span className="progress-fail">失败 {progress.failedQueryCount}</span> : null}
          </div>
          {progress.currentFromStation ? (
            <div className="progress-current">
              <span>{progress.currentFromStation} → {progress.currentToStation}</span>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="button-row">
        <button className="primary-button" type="button" disabled={disabled || isLoading} onClick={calculate}>
          <Play size={17} />
          {isLoading ? '计算中' : '开始计算'}
        </button>
        <button className="secondary-button" type="button" onClick={clearCache}>
          <Trash2 size={17} />
          清空缓存
        </button>
      </div>
    </section>
  );
}

function normalizeResultCount(value: string, fallback: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(50, Math.max(1, parsed));
}

function ResultsPanel() {
  const results = useAppStore((state) => state.results);
  const meta = useAppStore((state) => state.meta);
  const selectedResult = useAppStore((state) => state.selectedResult);
  const setSelectedResult = useAppStore((state) => state.setSelectedResult);

  return (
    <section className="panel results-panel">
      <div className="panel-title">
        <h2>候选起点</h2>
        {meta ? <span>{meta.elapsedMs} ms</span> : null}
      </div>
      {meta ? (
        <div className="meta-row">
          <span>候选 {meta.candidateCount}</span>
          <span>查询 {meta.preciseQueryCount}</span>
          <span>缓存 {meta.cacheHitCount}</span>
          <span>失败 {meta.failedQueryCount}</span>
        </div>
      ) : null}
      {results.length === 0 ? (
        <p className="empty">计算后显示总耗时最短的候选起点。</p>
      ) : (
        <div className="result-list">
          {results.map((result) => {
            const isSelected = selectedResult?.station.id === result.station.id;
            return (
              <div key={result.station.id} className={isSelected ? 'result-group expanded' : 'result-group'}>
                <button
                  className={isSelected ? 'result-item active' : 'result-item'}
                  type="button"
                  onClick={() => setSelectedResult(isSelected ? undefined : result)}
                >
                  <span className="rank">{result.rank}</span>
                  <span className="result-main">
                    <strong>{result.station.name}</strong>
                    <small>{result.station.lines.join(' / ')}</small>
                  </span>
                  <span className="metric">{Math.round(result.totalDurationMinutes)} 分钟</span>
                  <span className="submetric">均 {Math.round(result.averageDurationMinutes)} / 最长 {Math.round(result.maxDurationMinutes)}</span>
                </button>
                {isSelected ? <RouteDetails result={result} /> : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function RouteDetails({ result }: { result: OptimalOriginResult }) {
  const metro = useAppStore((state) => state.metro);
  const focusedRouteToStationId = useAppStore((state) => state.focusedRouteToStationId);
  const setFocusedRoute = useAppStore((state) => state.setFocusedRoute);
  const stationById = new Map(metro?.stations.map((station) => [station.id, station]) ?? []);

  return (
    <div className="details">
      <h3>{result.station.name} 出发明细</h3>
      {result.routes.map((route) => {
        const isFocused = focusedRouteToStationId === route.toStationId;
        const className = ['route-detail', route.failed ? 'failed' : '', isFocused ? 'focused' : ''].filter(Boolean).join(' ');

        return (
          <article
            key={route.toStationId}
            className={className}
            role="button"
            tabIndex={0}
            onClick={() => setFocusedRoute(isFocused ? undefined : route.toStationId)}
            onKeyDown={(e) => { if (e.key === 'Enter') setFocusedRoute(isFocused ? undefined : route.toStationId); }}
          >
            <div>
              <strong>{stationById.get(route.toStationId)?.name ?? route.toStationId}</strong>
              <span className="route-metrics">
                <span>{formatTransferCount(route)}</span>
                {formatWalkingDuration(route.steps ?? []) ? <span>{formatWalkingDuration(route.steps ?? [])}</span> : null}
                <span>{Math.round(route.durationMinutes)} 分钟</span>
              </span>
            </div>
            <p>{describeRoutePath(route, stationById)}</p>
          </article>
        );
      })}
    </div>
  );
}

function formatTransferCount(route: { transferCount?: number; steps?: { type: string; lineName?: string }[]; failed?: boolean }) {
  if (route.failed) return '路线失败';
  const transferCount = route.transferCount ?? inferTransferCount(route.steps ?? []);
  return transferCount === 0 ? '无需换乘' : `换乘 ${transferCount} 次`;
}

function inferTransferCount(steps: { type: string; lineName?: string }[]) {
  const lineNames = steps
    .filter((step) => step.type === 'subway' && step.lineName)
    .map((step) => step.lineName!.replace(/\(.*\)$/, ''));
  return Math.max(0, new Set(lineNames).size - 1);
}

function formatWalkingDuration(steps: RouteStep[]) {
  const minutes = steps
    .filter((step) => step.type === 'walk')
    .reduce((sum, step) => sum + (step.durationMinutes ?? 0), 0);
  return minutes > 0 ? `步行 ${minutes} 分钟` : undefined;
}

function describeRoutePath(route: { fromStationId: string; toStationId: string; lines?: string[]; steps?: { type: string; lineName?: string; fromStationName?: string; toStationName?: string }[]; failed?: boolean; errorMessage?: string }, stationById: Map<string, MetroStation>): string {
  const subwaySteps = (route.steps ?? []).filter((s) => s.type === 'subway');
  if (subwaySteps.length === 0) {
    return route.lines?.join(' → ') || '本地估算路线';
  }

  const fromName = stationById.get(route.fromStationId)?.name ?? route.fromStationId;
  const parts: string[] = [fromName];

  for (const step of subwaySteps) {
    const shortLine = (step.lineName ?? '').replace(/\(.*\)$/, '');
    parts.push(`→ (${shortLine}) →`);
    if (step.toStationName) parts.push(step.toStationName);
  }

  if (route.failed && route.errorMessage) {
    parts.push(`· ${route.errorMessage}`);
  }

  return parts.join(' ');
}

function resolveStationId(name: string, nameToId: Map<string, string>): string | undefined {
  if (nameToId.has(name)) return nameToId.get(name);
  if (name.endsWith('站')) {
    const without = name.slice(0, -1);
    if (nameToId.has(without)) return nameToId.get(without);
  }
  if (nameToId.has(`${name}站`)) return nameToId.get(`${name}站`);
  return undefined;
}

function matchMCPLine(mcpLineName: string, metroLineName: string): boolean {
  // MCP returns e.g. "地铁15号线(顾村公园--紫竹高新区)", "地铁4号线内圈(宜山路--宜山路)"
  // Metro data has e.g. "15号线", "浦江线", "磁浮线"
  // Need exact number match: "15号线" matches "地铁15号线" but NOT "地铁5号线"
  const mcpNum = mcpLineName.match(/地铁(\d+)号线/)?.[1];
  const metroNum = metroLineName.match(/^(\d+)号线$/)?.[1];
  if (mcpNum && metroNum) return mcpNum === metroNum;
  return mcpLineName.includes(metroLineName);
}

function parseSSEEvent(raw: string): { type: string; data: unknown } | null {
  let eventType = '';
  let eventData = '';
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) eventType = line.slice(7);
    else if (line.startsWith('data: ')) eventData = line.slice(6);
  }
  if (!eventData) return null;
  try {
    return { type: eventType || 'message', data: JSON.parse(eventData) };
  } catch {
    return null;
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
