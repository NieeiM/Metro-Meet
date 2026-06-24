import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const SHANGHAI_METRO_RELATION_ID = 6799988;
const OVERPASS_URL = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'MetroMeet/0.1 Shanghai metro data importer';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(dirname, '..');
const outputPath = path.join(rootDir, 'data', 'shanghai-metro.json');
const schematicOverridesPath = path.join(rootDir, 'data', 'schematic-overrides.json');
const SCHEMATIC_GRID_SIZE = 32;
const SCHEMATIC_MAX_EDGE_LINES = 2;

const lineTypePriority = new Map([
  ['subway', 1],
  ['light_rail', 2],
  ['monorail', 3]
]);

const lineColorFallbacks = new Map([
  ['1', '#E4002B'],
  ['2', '#8CC63F'],
  ['3', '#FCD600'],
  ['4', '#461D7C'],
  ['5', '#8C4799'],
  ['6', '#D5007F'],
  ['7', '#F58220'],
  ['8', '#009B77'],
  ['9', '#71C5E8'],
  ['10', '#C9A646'],
  ['11', '#871F78'],
  ['12', '#007A53'],
  ['13', '#E999C0'],
  ['14', '#9A7611'],
  ['15', '#B8A078'],
  ['16', '#77C5D5'],
  ['17', '#B4875E'],
  ['18', '#00A3E0'],
  ['浦江', '#B5BD00'],
  ['磁浮', '#009A44']
]);

// Station order overrides: OSM sometimes returns stations in wrong order.
// Applied AFTER station IDs are computed. Station IDs are matched by name.
// Keys: line IDs. Values: correct station name order for the line.
const STATION_ORDER_OVERRIDES_BY_NAME = {
  'line-14': [
    '封浜', '乐秀路', '临洮路', '嘉怡路', '定边路', '真新新村',
    '真光路', '铜川路', '真如', '中宁路', '曹杨路', '武宁路',
    '武定路', '静安寺', '黄陂南路', '大世界', '豫园', '陆家嘴',
    '浦东南路', '东昌路', '浦东大道', '源深路', '昌邑路',
    '歇浦路', '云山路', '蓝天路', '黄杨路', '云顺路',
    '浦东足球场', '金粤路', '桂桥路'
  ]
};

async function main() {
  let osm;
  try {
    osm = await fetchShanghaiMetroOsm();
  } catch (error) {
    console.warn(error instanceof Error ? error.message : error);
    console.warn('Falling back to existing data/shanghai-metro.json for layout regeneration.');
    await regenerateLayoutFromExistingData();
    return;
  }
  const elementsByKey = new Map(osm.elements.map((element) => [`${element.type}/${element.id}`, element]));
  const relations = osm.elements.filter((element) => element.type === 'relation');
  const routeMasters = relations
    .filter((relation) => relation.tags?.ref)
    .filter((relation) => relation.members?.some((member) => {
      const route = elementsByKey.get(`${member.type}/${member.ref}`);
      return isSupportedRoute(route);
    }))
    .sort(compareRouteMasters);

  const stationByName = new Map();
  const lineEntries = [];
  const edgeEntries = new Map();
  const stationLineIds = new Map();

  for (const master of routeMasters) {
    const ref = String(master.tags.ref);
    const lineId = lineIdFromRef(ref);
    const childRoutes = (master.members ?? [])
      .map((member) => elementsByKey.get(`${member.type}/${member.ref}`))
      .filter(isSupportedRoute);
    const sequences = childRoutes
      .map((route) => stationSequenceFromRoute(route, elementsByKey))
      .filter((sequence) => sequence.length >= 2);

    if (sequences.length === 0) continue;

    const stationIds = orderedUnique(sequences.flatMap((sequence) => sequence.map((station) => {
      const stationId = stationIdForName(station.name);
      const existing = stationByName.get(station.name);
      stationByName.set(station.name, mergeStation(existing, station, stationId));
      addToSetMap(stationLineIds, stationId, lineId);
      return stationId;
    })));

    for (const sequence of sequences) {
      for (let index = 0; index < sequence.length - 1; index += 1) {
        const from = stationIdForName(sequence[index].name);
        const to = stationIdForName(sequence[index + 1].name);
        if (from === to) continue;
        const key = [from, to].sort().join('|') + `|${lineId}`;
        edgeEntries.set(key, { fromStationId: from, toStationId: to, lineId });
      }
    }

    // Apply station order override if this line has known OSM ordering issues
    let finalStationIds = stationIds;
    const overrideNames = STATION_ORDER_OVERRIDES_BY_NAME[lineId];
    if (overrideNames) {
      const overridden = overrideNames.map((name) => stationIdForName(name));
      const origSet = new Set(stationIds);
      const overSet = new Set(overridden);
      if (origSet.size === overSet.size && [...origSet].every((id) => overSet.has(id))) {
        finalStationIds = overridden;
        console.warn(`  Applied station order override for ${lineId} (${overrideNames.length} stations)`);
      } else {
        console.warn(`  Station order override for ${lineId} has mismatched stations, skipping`);
      }
    }

    lineEntries.push({
      id: lineId,
      name: lineNameFromMaster(master),
      color: normalizeColor(master.tags?.colour ?? lineColorFallbacks.get(ref)),
      stationIds: finalStationIds
    });
  }

  const stations = [...stationByName.values()]
    .map((station) => ({
      ...station,
      lines: [...(stationLineIds.get(station.id) ?? [])].sort(compareLineIds),
      isTransfer: (stationLineIds.get(station.id)?.size ?? 0) > 1
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

  assignMapCoordinates(stations);
  assignSchematicCoordinates(stations, lineEntries);
  await applySchematicOverrides(stations);
  snapStationsToSchematicGrid(stations);
  const edges = filterLine16ExpressEdges([...edgeEntries.values()], lineEntries);
  assignSchematicSegments(stations, lineEntries, edges);

  const metroData = {
    stations,
    lines: lineEntries.sort((a, b) => compareLineIds(a.id, b.id)),
    edges: edges.sort((a, b) =>
      a.lineId.localeCompare(b.lineId) ||
      a.fromStationId.localeCompare(b.fromStationId) ||
      a.toStationId.localeCompare(b.toStationId)
    )
  };

  await writeFile(outputPath, `${JSON.stringify(metroData, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${metroData.stations.length} stations, ${metroData.lines.length} lines, ${metroData.edges.length} edges to ${path.relative(rootDir, outputPath)}`);
  console.log(`Transfer stations: ${metroData.stations.filter((station) => station.isTransfer).length}`);
}

async function regenerateLayoutFromExistingData() {
  const raw = await readFile(outputPath, 'utf8');
  const metroData = JSON.parse(raw);
  assignMapCoordinates(metroData.stations);
  assignSchematicCoordinates(metroData.stations, metroData.lines);
  await applySchematicOverrides(metroData.stations);
  snapStationsToSchematicGrid(metroData.stations);
  metroData.edges = filterLine16ExpressEdges(metroData.edges ?? [], metroData.lines);
  assignSchematicSegments(metroData.stations, metroData.lines, metroData.edges ?? []);
  await writeFile(outputPath, `${JSON.stringify(metroData, null, 2)}\n`, 'utf8');
  console.log(`Updated layout for ${metroData.stations.length} stations, ${metroData.lines.length} lines in ${path.relative(rootDir, outputPath)}`);
  console.log(`Transfer stations: ${metroData.stations.filter((station) => station.isTransfer).length}`);
}

function filterLine16ExpressEdges(edges, lines) {
  const line16 = lines.find((line) => line.id === 'line-16');
  if (!line16) return edges;

  const order = new Map(line16.stationIds.map((stationId, index) => [stationId, index]));
  return edges.filter((edge) => {
    if (edge.lineId !== 'line-16') return true;
    const fromIndex = order.get(edge.fromStationId);
    const toIndex = order.get(edge.toStationId);
    if (fromIndex === undefined || toIndex === undefined) return true;
    return Math.abs(fromIndex - toIndex) === 1;
  });
}

async function fetchShanghaiMetroOsm() {
  const query = `[out:json][timeout:90];relation(${SHANGHAI_METRO_RELATION_ID});>>;out body qt;`;
  const response = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: new URLSearchParams({ data: query }),
    headers: { 'user-agent': USER_AGENT }
  });

  if (!response.ok) {
    throw new Error(`Overpass request failed: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

function isSupportedRoute(element) {
  return element?.type === 'relation' && element.tags?.type === 'route' && lineTypePriority.has(element.tags?.route);
}

function stationSequenceFromRoute(route, elementsByKey) {
  return (route.members ?? [])
    .filter((member) => String(member.role ?? '').startsWith('stop'))
    .map((member) => elementsByKey.get(`${member.type}/${member.ref}`))
    .filter((element) => element?.tags?.name && Number.isFinite(element.lat) && Number.isFinite(element.lon))
    .map((element) => ({
      name: cleanStationName(element.tags.name),
      lng: Number(element.lon),
      lat: Number(element.lat)
    }))
    .filter((station, index, stations) => index === 0 || station.name !== stations[index - 1].name);
}

function mergeStation(existing, station, id) {
  if (!existing) {
    return {
      id,
      name: station.name,
      lines: [],
      lng: station.lng,
      lat: station.lat,
      isTransfer: false
    };
  }

  return {
    ...existing,
    lng: average(existing.lng, station.lng),
    lat: average(existing.lat, station.lat)
  };
}

function assignMapCoordinates(stations) {
  const lngs = stations.map((station) => station.lng).filter(Number.isFinite);
  const lats = stations.map((station) => station.lat).filter(Number.isFinite);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const width = 1200;
  const height = 1000;
  const padding = 80;
  const centerLng = 121.47;
  const centerLat = 31.23;
  const spreadPower = 0.68;

  for (const station of stations) {
    const normalizedLng = ((station.lng - centerLng) / Math.max(centerLng - minLng, maxLng - centerLng));
    const normalizedLat = ((station.lat - centerLat) / Math.max(centerLat - minLat, maxLat - centerLat));
    const spreadLng = signedPower(normalizedLng, spreadPower);
    const spreadLat = signedPower(normalizedLat, spreadPower);
    station.mapX = Math.round(width / 2 + spreadLng * ((width - padding * 2) / 2));
    station.mapY = Math.round(height / 2 - spreadLat * ((height - padding * 2) / 2));
  }
}

function signedPower(value, power) {
  return Math.sign(value) * Math.min(1, Math.abs(value) ** power);
}

function assignSchematicCoordinates(stations, lines) {
  const stationById = new Map(stations.map((station) => [station.id, station]));
  const layout = new Map();
  const stationUseCount = new Map(stations.map((station) => [station.id, station.lines.length]));
  const geoSeed = createGeoSeed(stations);
  const sortedLines = [...lines].sort((a, b) => {
    const maxTransferA = Math.max(...a.stationIds.map((id) => stationUseCount.get(id) ?? 1));
    const maxTransferB = Math.max(...b.stationIds.map((id) => stationUseCount.get(id) ?? 1));
    return maxTransferB - maxTransferA || compareLineIds(a.id, b.id);
  });

  const passes = 3;
  for (let pass = 0; pass < passes; pass += 1) {
    for (const line of sortedLines) {
      assignLineSchematicCoordinates(line, stationById, layout, geoSeed);
    }
  }

  for (const station of stations) {
    if (!layout.has(station.id)) {
      layout.set(station.id, geoSeed.get(station.id));
    }
  }

  normalizeSchematicLayout(stations, layout);
}

function assignLineSchematicCoordinates(line, stationById, layout, geoSeed) {
  const ids = line.stationIds.filter((id) => stationById.has(id));
  if (ids.length === 0) return;

  const firstAssignedIndex = ids.findIndex((id) => layout.has(id));
  if (firstAssignedIndex >= 0) {
    walkForward(ids, firstAssignedIndex, stationById, layout);
    walkBackward(ids, firstAssignedIndex, stationById, layout);
    return;
  }

  const start = geoSeed.get(ids[0]);
  layout.set(ids[0], start);
  walkForward(ids, 0, stationById, layout);
}

function walkForward(ids, startIndex, stationById, layout) {
  for (let index = startIndex + 1; index < ids.length; index += 1) {
    const previousId = ids[index - 1];
    const stationId = ids[index];
    if (layout.has(stationId)) continue;
    const previous = stationById.get(previousId);
    const station = stationById.get(stationId);
    const previousPoint = layout.get(previousId);
    const direction = quantizedDirection(previous, station);
    const spacing = schematicSpacing(previous, station);
    layout.set(stationId, {
      x: previousPoint.x + direction.x * spacing,
      y: previousPoint.y + direction.y * spacing
    });
  }
}

function walkBackward(ids, startIndex, stationById, layout) {
  for (let index = startIndex - 1; index >= 0; index -= 1) {
    const nextId = ids[index + 1];
    const stationId = ids[index];
    if (layout.has(stationId)) continue;
    const next = stationById.get(nextId);
    const station = stationById.get(stationId);
    const nextPoint = layout.get(nextId);
    const direction = quantizedDirection(next, station);
    const spacing = schematicSpacing(next, station);
    layout.set(stationId, {
      x: nextPoint.x + direction.x * spacing,
      y: nextPoint.y + direction.y * spacing
    });
  }
}

function quantizedDirection(from, to) {
  const dx = to.lng - from.lng;
  const dy = -(to.lat - from.lat);
  const angle = Math.atan2(dy, dx);
  const octant = Math.round(angle / (Math.PI / 4));
  const snapped = octant * (Math.PI / 4);
  return {
    x: Math.round(Math.cos(snapped)),
    y: Math.round(Math.sin(snapped))
  };
}

function schematicSpacing(a, b) {
  const centerLng = 121.47;
  const centerLat = 31.23;
  const distanceFromCenter = Math.min(
    Math.hypot(a.lng - centerLng, a.lat - centerLat),
    Math.hypot(b.lng - centerLng, b.lat - centerLat)
  );
  if (distanceFromCenter < 0.08) return 44;
  if (distanceFromCenter < 0.16) return 42;
  if (distanceFromCenter < 0.28) return 40;
  return 38;
}

function createGeoSeed(stations) {
  const lngs = stations.map((station) => station.lng).filter(Number.isFinite);
  const lats = stations.map((station) => station.lat).filter(Number.isFinite);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const seed = new Map();

  for (const station of stations) {
    const x = ((station.lng - minLng) / (maxLng - minLng)) * 900;
    const y = ((maxLat - station.lat) / (maxLat - minLat)) * 720;
    seed.set(station.id, {
      x: Math.round(x / 24) * 24,
      y: Math.round(y / 24) * 24
    });
  }

  return seed;
}

function normalizeSchematicLayout(stations, layout) {
  const points = [...layout.values()];
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const width = 1500;
  const height = 1120;
  const padding = 90;
  const scale = Math.min((width - padding * 2) / (maxX - minX || 1), (height - padding * 2) / (maxY - minY || 1));

  for (const station of stations) {
    const point = layout.get(station.id);
    station.schematicX = Math.round(padding + (point.x - minX) * scale);
    station.schematicY = Math.round(padding + (point.y - minY) * scale);
  }

  expandCentralSchematicArea(stations, width, height, padding);
}

function expandCentralSchematicArea(stations, width, height, padding) {
  const geoCenterLng = 121.47;
  const geoCenterLat = 31.23;
  const visualCenter = stations.find((station) => station.name === '人民广场') ?? {
    schematicX: width / 2,
    schematicY: height / 2
  };

  for (const station of stations) {
    const geoDistance = Math.hypot(station.lng - geoCenterLng, station.lat - geoCenterLat);
    const factor = centralExpansionFactor(geoDistance);
    if (factor === 1) continue;

    station.schematicX = Math.round(clamp(visualCenter.schematicX + (station.schematicX - visualCenter.schematicX) * factor, padding, width - padding));
    station.schematicY = Math.round(clamp(visualCenter.schematicY + (station.schematicY - visualCenter.schematicY) * factor, padding, height - padding));
  }

  separateDuplicateSchematicPoints(stations);
}

function centralExpansionFactor(geoDistance) {
  if (geoDistance < 0.08) return 1.35;
  if (geoDistance < 0.14) return 1.2;
  if (geoDistance < 0.22) return 1.08;
  return 1;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function separateDuplicateSchematicPoints(stations) {
  for (let pass = 0; pass < 4; pass += 1) {
    const buckets = new Map();
    for (const station of stations) {
      const key = `${station.schematicX},${station.schematicY}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push(station);
      buckets.set(key, bucket);
    }

    const duplicates = [...buckets.values()].filter((bucket) => bucket.length > 1);
    if (duplicates.length === 0) return;

    for (const bucket of duplicates) {
      bucket
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
        .forEach((station, index) => {
          const angle = (Math.PI * 2 * (index + pass * 0.37)) / bucket.length;
          const radius = 12 + pass * 8 + Math.floor(index / 6) * 8;
          station.schematicX = Math.round(station.schematicX + Math.cos(angle) * radius);
          station.schematicY = Math.round(station.schematicY + Math.sin(angle) * radius);
        });
    }
  }
}

function snapStationsToSchematicGrid(stations) {
  const occupied = new Set();
  const sorted = [...stations].sort((a, b) => {
    const transferDelta = Number(b.isTransfer) - Number(a.isTransfer);
    return transferDelta || b.lines.length - a.lines.length || a.name.localeCompare(b.name, 'zh-Hans-CN');
  });

  for (const station of sorted) {
    const preferred = {
      x: snapToGrid(station.schematicX),
      y: snapToGrid(station.schematicY)
    };
    const point = nearestFreeGridPoint(preferred, occupied);
    station.schematicX = point.x;
    station.schematicY = point.y;
    occupied.add(gridPointKey(point));
  }
}

function snapToGrid(value) {
  return Math.round(value / SCHEMATIC_GRID_SIZE) * SCHEMATIC_GRID_SIZE;
}

function nearestFreeGridPoint(preferred, occupied) {
  if (!occupied.has(gridPointKey(preferred))) return preferred;

  for (let radius = 1; radius < 20; radius += 1) {
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        candidates.push({
          x: preferred.x + dx * SCHEMATIC_GRID_SIZE,
          y: preferred.y + dy * SCHEMATIC_GRID_SIZE
        });
      }
    }

    candidates.sort((a, b) => {
      const distanceA = Math.hypot(a.x - preferred.x, a.y - preferred.y);
      const distanceB = Math.hypot(b.x - preferred.x, b.y - preferred.y);
      return distanceA - distanceB || a.y - b.y || a.x - b.x;
    });

    const free = candidates.find((candidate) => !occupied.has(gridPointKey(candidate)));
    if (free) return free;
  }

  throw new Error(`Unable to find free schematic grid point near ${preferred.x},${preferred.y}`);
}

function gridPointKey(point) {
  return `${point.x},${point.y}`;
}

function assignSchematicSegments(stations, lines, edges = []) {
  const stationById = new Map(stations.map((station) => [station.id, station]));
  const stationPointIndex = buildStationPointIndex(stations);
  const edgeOccupancy = new Map();

  for (const line of lines) {
    line.schematicSegments = [];
  }

  const bounds = schematicBounds(stations);

  for (const line of lines) {
    const allowedLineStationIds = new Set(line.stationIds);
    for (let index = 0; index < line.stationIds.length - 1; index += 1) {
      const fromStationId = line.stationIds[index];
      const toStationId = line.stationIds[index + 1];
      const from = stationById.get(fromStationId);
      const to = stationById.get(toStationId);
      if (!from || !to) continue;

      const path = findGridPath(
        { x: from.schematicX, y: from.schematicY },
        { x: to.schematicX, y: to.schematicY },
        allowedLineStationIds,
        stationPointIndex,
        edgeOccupancy,
        bounds
      );

      for (let pathIndex = 0; pathIndex < path.length - 1; pathIndex += 1) {
        const a = path[pathIndex];
        const b = path[pathIndex + 1];
        const edgeKey = gridEdgeKey(a, b);
        const occupancy = edgeOccupancy.get(edgeKey) ?? [];
        const slotIndex = occupancy.length;
        occupancy.push(line.id);
        edgeOccupancy.set(edgeKey, occupancy);
        line.schematicSegments.push({
          fromStationId,
          toStationId,
          x1: a.x,
          y1: a.y,
          x2: b.x,
          y2: b.y,
          slotIndex,
          slotCount: 1
        });
      }
    }
  }

  // Add closing segments for loop lines (e.g. Line 4)
  for (const line of lines) {
    if (line.stationIds.length < 2) continue;
    const firstId = line.stationIds[0];
    const lastId = line.stationIds[line.stationIds.length - 1];

    const hasClosingEdge = edges.some(
      (e) =>
        e.lineId === line.id &&
        ((e.fromStationId === firstId && e.toStationId === lastId) ||
          (e.fromStationId === lastId && e.toStationId === firstId))
    );

    if (!hasClosingEdge) continue;
    if (line.schematicSegments.some(
      (s) =>
        (s.fromStationId === lastId && s.toStationId === firstId) ||
        (s.fromStationId === firstId && s.toStationId === lastId)
    )) continue; // already has closing segment

    const from = stationById.get(lastId);
    const to = stationById.get(firstId);
    if (!from || !to) continue;

    const path = findGridPath(
      { x: from.schematicX, y: from.schematicY },
      { x: to.schematicX, y: to.schematicY },
      new Set(line.stationIds),
      stationPointIndex,
      edgeOccupancy,
      bounds
    );

    for (let pathIndex = 0; pathIndex < path.length - 1; pathIndex += 1) {
      const a = path[pathIndex];
      const b = path[pathIndex + 1];
      const edgeKey = gridEdgeKey(a, b);
      const occupancy = edgeOccupancy.get(edgeKey) ?? [];
      const slotIndex = occupancy.length;
      occupancy.push(line.id);
      edgeOccupancy.set(edgeKey, occupancy);
      line.schematicSegments.push({
        fromStationId: lastId,
        toStationId: firstId,
        x1: a.x, y1: a.y,
        x2: b.x, y2: b.y,
        slotIndex,
        slotCount: 1
      });
    }
  }

  const slotCounts = new Map([...edgeOccupancy.entries()].map(([key, value]) => [key, value.length]));
  for (const line of lines) {
    line.schematicSegments = line.schematicSegments.map((segment) => ({
      ...segment,
      slotCount: slotCounts.get(gridEdgeKey({ x: segment.x1, y: segment.y1 }, { x: segment.x2, y: segment.y2 })) ?? 1
    }));
  }
}

function buildStationPointIndex(stations) {
  const index = new Map();
  for (const station of stations) {
    const key = gridPointKey({ x: station.schematicX, y: station.schematicY });
    const stationIds = index.get(key) ?? [];
    stationIds.push(station.id);
    index.set(key, stationIds);
  }
  return index;
}

function schematicBounds(stations) {
  const xs = stations.map((station) => station.schematicX);
  const ys = stations.map((station) => station.schematicY);
  return {
    minX: Math.min(...xs) - SCHEMATIC_GRID_SIZE * 8,
    maxX: Math.max(...xs) + SCHEMATIC_GRID_SIZE * 8,
    minY: Math.min(...ys) - SCHEMATIC_GRID_SIZE * 8,
    maxY: Math.max(...ys) + SCHEMATIC_GRID_SIZE * 8
  };
}

function findGridPath(start, end, allowedStationIds, stationPointIndex, edgeOccupancy, bounds) {
  if (canUseGridEdge(start, end, allowedStationIds, stationPointIndex, edgeOccupancy)) return [start, end];

  for (const elbow of preferredElbows(start, end).filter((point) => pointInBounds(point, bounds))) {
    if (
      isAllowedPathPoint(elbow, allowedStationIds, stationPointIndex) &&
      canUseGridEdge(start, elbow, allowedStationIds, stationPointIndex, edgeOccupancy) &&
      canUseGridEdge(elbow, end, allowedStationIds, stationPointIndex, edgeOccupancy)
    ) {
      return [start, elbow, end];
    }
  }

  return bfsGridPath(start, end, allowedStationIds, stationPointIndex, edgeOccupancy, bounds);
}

function preferredElbows(start, end) {
  const grid = SCHEMATIC_GRID_SIZE;
  const base = [
    { x: end.x, y: start.y },
    { x: start.x, y: end.y },
    { x: start.x + Math.sign(end.x - start.x) * Math.abs(end.y - start.y), y: end.y },
    { x: end.x, y: start.y + Math.sign(end.y - start.y) * Math.abs(end.x - start.x) }
  ];
  const expanded = [];
  for (const point of base) {
    expanded.push(point);
    expanded.push({ x: point.x + grid, y: point.y });
    expanded.push({ x: point.x - grid, y: point.y });
    expanded.push({ x: point.x, y: point.y + grid });
    expanded.push({ x: point.x, y: point.y - grid });
  }
  return uniquePoints(expanded.map((point) => ({ x: snapToGrid(point.x), y: snapToGrid(point.y) })));
}

function bfsGridPath(start, end, allowedStationIds, stationPointIndex, edgeOccupancy, bounds) {
  const queue = [start];
  const cameFrom = new Map([[gridPointKey(start), null]]);
  const directions = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
    { x: 1, y: 1 },
    { x: 1, y: -1 },
    { x: -1, y: 1 },
    { x: -1, y: -1 }
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (gridPointKey(current) === gridPointKey(end)) return reconstructPath(cameFrom, end);

    const neighbors = directions
      .map((direction) => ({
        x: current.x + direction.x * SCHEMATIC_GRID_SIZE,
        y: current.y + direction.y * SCHEMATIC_GRID_SIZE
      }))
      .filter((point) => pointInBounds(point, bounds))
      .filter((point) => canUseGridEdge(current, point, allowedStationIds, stationPointIndex, edgeOccupancy))
      .sort((a, b) => Math.hypot(a.x - end.x, a.y - end.y) - Math.hypot(b.x - end.x, b.y - end.y));

    for (const neighbor of neighbors) {
      const key = gridPointKey(neighbor);
      if (cameFrom.has(key)) continue;
      cameFrom.set(key, current);
      queue.push(neighbor);
      if (key === gridPointKey(end)) return reconstructPath(cameFrom, end);
    }
  }

  return fallbackGridPath(start, end, allowedStationIds, stationPointIndex, edgeOccupancy, bounds);
}

function reconstructPath(cameFrom, end) {
  const path = [end];
  let current = cameFrom.get(gridPointKey(end));
  while (current) {
    path.push(current);
    current = cameFrom.get(gridPointKey(current));
  }
  return path.reverse();
}

function fallbackGridPath(start, end, allowedStationIds, stationPointIndex, edgeOccupancy, bounds) {
  const grid = SCHEMATIC_GRID_SIZE;
  const directions = [1, -1];
  for (let radius = 1; radius <= 16; radius += 1) {
    const offsets = directions.map((direction) => direction * radius * grid);
    const candidates = [];

    for (const offset of offsets) {
      candidates.push([
        start,
        { x: start.x + offset, y: start.y },
        { x: start.x + offset, y: end.y },
        end
      ]);
      candidates.push([
        start,
        { x: start.x, y: start.y + offset },
        { x: end.x, y: start.y + offset },
        end
      ]);
    }

    for (const xOffset of offsets) {
      for (const yOffset of offsets) {
        candidates.push([
          start,
          { x: start.x + xOffset, y: start.y },
          { x: start.x + xOffset, y: end.y + yOffset },
          { x: end.x, y: end.y + yOffset },
          end
        ]);
        candidates.push([
          start,
          { x: start.x, y: start.y + yOffset },
          { x: end.x + xOffset, y: start.y + yOffset },
          { x: end.x + xOffset, y: end.y },
          end
        ]);
      }
    }

    const route = candidates
      .map(compactConsecutiveDuplicatePoints)
      .filter((path) => path.every((point) => pointInBounds(point, bounds)))
      .find((path) => isUsableGridPath(path, allowedStationIds, stationPointIndex, edgeOccupancy));
    if (route) return route;
  }

  throw new Error(`Unable to route schematic segment from ${gridPointKey(start)} to ${gridPointKey(end)} without crossing station nodes`);
}

function compactConsecutiveDuplicatePoints(points) {
  const compacted = [];
  for (const point of points) {
    if (compacted.length === 0 || gridPointKey(compacted.at(-1)) !== gridPointKey(point)) {
      compacted.push(point);
    }
  }
  return compacted;
}

function isUsableGridPath(path, allowedStationIds, stationPointIndex, edgeOccupancy) {
  if (path.length < 2) return false;
  for (let index = 1; index < path.length - 1; index += 1) {
    if (!isAllowedPathPoint(path[index], allowedStationIds, stationPointIndex)) return false;
  }
  for (let index = 0; index < path.length - 1; index += 1) {
    if (!canUseGridEdge(path[index], path[index + 1], allowedStationIds, stationPointIndex, edgeOccupancy)) {
      return false;
    }
  }
  return true;
}

function canUseGridEdge(a, b, allowedStationIds, stationPointIndex, edgeOccupancy) {
  if (gridPointKey(a) === gridPointKey(b)) return false;
  if (!isAllowedGridLine(a, b)) return false;
  if (!isAllowedPathPoint(b, allowedStationIds, stationPointIndex)) return false;
  return (edgeOccupancy.get(gridEdgeKey(a, b))?.length ?? 0) < SCHEMATIC_MAX_EDGE_LINES;
}

function isAllowedPathPoint(point, allowedStationIds, stationPointIndex) {
  const stationIds = stationPointIndex.get(gridPointKey(point));
  if (!stationIds) return true;
  return stationIds.every((stationId) => allowedStationIds.has(stationId));
}

function isAllowedGridLine(a, b) {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return dx === 0 || dy === 0 || dx === dy;
}

function gridEdgeKey(a, b) {
  const aKey = `${a.x},${a.y}`;
  const bKey = `${b.x},${b.y}`;
  return aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
}

function pointInBounds(point, bounds) {
  return point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY;
}

function uniquePoints(points) {
  const seen = new Set();
  const unique = [];
  for (const point of points) {
    const key = gridPointKey(point);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(point);
  }
  return unique;
}

function groupOverlappingSchematicSegments(segments) {
  const buckets = new Map();

  for (const segment of segments) {
    const key = schematicSegmentBucketKey(segment);
    const bucket = buckets.get(key) ?? [];
    bucket.push(segment);
    buckets.set(key, bucket);
  }

  return [...buckets.values()].flatMap((bucket) => splitCollinearBucket(bucket));
}

function schematicSegmentBucketKey(segment) {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const direction = normalizedDirection(dx, dy);
  const normal = { x: -direction.y, y: direction.x };
  const lineCoordinate = Math.round((segment.x1 * normal.x + segment.y1 * normal.y) / 14);
  return `${direction.x},${direction.y}:${lineCoordinate}`;
}

function splitCollinearBucket(bucket) {
  const groups = [];
  const sorted = [...bucket].sort((a, b) => segmentStartProjection(a) - segmentStartProjection(b));

  for (const segment of sorted) {
    let placed = false;
    for (const group of groups) {
      if (group.some((other) => schematicSegmentsOverlap(segment, other))) {
        group.push(segment);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([segment]);
  }

  return groups;
}

function schematicSegmentsOverlap(a, b) {
  const startA = segmentStartProjection(a);
  const endA = segmentEndProjection(a);
  const startB = segmentStartProjection(b);
  const endB = segmentEndProjection(b);
  return Math.min(endA, endB) - Math.max(startA, startB) > 8;
}

function segmentStartProjection(segment) {
  const direction = normalizedDirection(segment.x2 - segment.x1, segment.y2 - segment.y1);
  return Math.min(
    segment.x1 * direction.x + segment.y1 * direction.y,
    segment.x2 * direction.x + segment.y2 * direction.y
  );
}

function segmentEndProjection(segment) {
  const direction = normalizedDirection(segment.x2 - segment.x1, segment.y2 - segment.y1);
  return Math.max(
    segment.x1 * direction.x + segment.y1 * direction.y,
    segment.x2 * direction.x + segment.y2 * direction.y
  );
}

function normalizedDirection(dx, dy) {
  const length = Math.hypot(dx, dy) || 1;
  const x = Math.round(dx / length);
  const y = Math.round(dy / length);
  if (x < 0 || (x === 0 && y < 0)) return { x: -x, y: -y };
  return { x, y };
}

function segmentNormal(segment) {
  const direction = normalizedDirection(segment.x2 - segment.x1, segment.y2 - segment.y1);
  return { x: -direction.y, y: direction.x };
}

function offsetValuesForGroup(count) {
  if (count <= 1) return [0];
  const gap = 9;
  const middle = (count - 1) / 2;
  return Array.from({ length: count }, (_, index) => (index - middle) * gap);
}

async function applySchematicOverrides(stations) {
  let overrides;
  try {
    overrides = JSON.parse(await readFile(schematicOverridesPath, 'utf8'));
  } catch {
    return;
  }

  for (const station of stations) {
    const override = overrides[station.id] ?? overrides[station.name];
    if (Number.isFinite(override?.schematicX) && Number.isFinite(override?.schematicY)) {
      station.schematicX = override.schematicX;
      station.schematicY = override.schematicY;
      continue;
    }

    if (Number.isFinite(override?.offsetX) || Number.isFinite(override?.offsetY)) {
      station.schematicX = Math.round(station.schematicX + (Number.isFinite(override?.offsetX) ? override.offsetX : 0));
      station.schematicY = Math.round(station.schematicY + (Number.isFinite(override?.offsetY) ? override.offsetY : 0));
    }
  }
}

function addToSetMap(map, key, value) {
  const set = map.get(key) ?? new Set();
  set.add(value);
  map.set(key, set);
}

function orderedUnique(items) {
  return [...new Set(items)];
}

function stationIdForName(name) {
  return `station-${createHash('sha1').update(name).digest('hex').slice(0, 10)}`;
}

function lineIdFromRef(ref) {
  if (/^\d+$/.test(ref)) return `line-${ref}`;
  if (ref === '浦江') return 'line-pujiang';
  if (ref === '磁浮') return 'line-maglev';
  return `line-${createHash('sha1').update(ref).digest('hex').slice(0, 8)}`;
}

function lineNameFromMaster(master) {
  const ref = String(master.tags.ref);
  if (/^\d+$/.test(ref)) return `${ref}号线`;
  if (ref === '浦江') return '浦江线';
  if (ref === '磁浮') return '磁浮线';
  return String(master.tags.name ?? ref).replace(/^上海地铁/, '');
}

function compareRouteMasters(a, b) {
  return compareLineRefs(String(a.tags.ref), String(b.tags.ref));
}

function compareLineIds(a, b) {
  return compareLineRefs(a.replace(/^line-/, ''), b.replace(/^line-/, ''));
}

function compareLineRefs(a, b) {
  const rankA = lineRank(a);
  const rankB = lineRank(b);
  return rankA - rankB || a.localeCompare(b, 'zh-Hans-CN');
}

function lineRank(ref) {
  if (/^\d+$/.test(ref)) return Number(ref);
  if (ref === 'pujiang' || ref === '浦江') return 100;
  if (ref === 'maglev' || ref === '磁浮') return 101;
  return 999;
}

function cleanStationName(name) {
  return String(name).replace(/\s+/g, '').trim();
}

function normalizeColor(color) {
  if (!color) return undefined;
  const trimmed = String(color).trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) return trimmed.toUpperCase();
  return trimmed;
}

function average(a, b) {
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  return Number(((a + b) / 2).toFixed(7));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
