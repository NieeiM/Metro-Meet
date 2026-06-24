import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(dirname, '..');
const dataPath = path.join(rootDir, 'data', 'shanghai-metro.json');

const BRANCH_LINE_IDS = new Set(['line-5', 'line-10', 'line-11']);
const LOOP_LINE_IDS = new Set(['line-4']);
const EXPRESS_LINE_IDS = new Set(['line-16', 'line-maglev']);

const data = JSON.parse(await readFile(dataPath, 'utf8'));

const stationsById = new Map(data.stations.map((s) => [s.id, s]));
const stationByName = new Map(data.stations.map((s) => [s.name, s]));
const lineById = new Map(data.lines.map((l) => [l.id, l]));

const errors = [];
const warnings = [];

function err(line, msg) {
  errors.push({ line: line ? `${line.name} (${line.id})` : null, message: msg });
}

function warn(line, msg) {
  warnings.push({ line: line ? `${line.name} (${line.id})` : null, message: msg });
}

console.error('=== MetroMeet 上海地铁数据验证 ===\n');

// Check 1: stationIds consistency — all referenced stations exist
console.error('[1/8] 站点 ID 引用一致性...');
for (const line of data.lines) {
  for (const sid of line.stationIds) {
    if (!stationsById.has(sid)) err(line, `stationIds 引用了不存在的站点 "${sid}"`);
  }
  if (line.schematicSegments) {
    for (const seg of line.schematicSegments) {
      if (!stationsById.has(seg.fromStationId)) err(line, `schematicSegment 引用了不存在的站点 "${seg.fromStationId}"`);
      if (!stationsById.has(seg.toStationId)) err(line, `schematicSegment 引用了不存在的站点 "${seg.toStationId}"`);
    }
  }
}

// Check 2: edge coverage for consecutive station pairs
console.error('[2/8] 连续站对边覆盖...');
for (const line of data.lines) {
  for (let i = 0; i < line.stationIds.length - 1; i++) {
    const fromId = line.stationIds[i];
    const toId = line.stationIds[i + 1];
    const hasEdge = data.edges.some(
      (e) =>
        e.lineId === line.id &&
        ((e.fromStationId === fromId && e.toStationId === toId) ||
          (e.fromStationId === toId && e.toStationId === fromId))
    );
    if (hasEdge) continue;

    const fromName = stationsById.get(fromId)?.name ?? fromId;
    const toName = stationsById.get(toId)?.name ?? toId;

    // Branch line boundary gaps are expected (branch endpoint next to main-line station)
    if (BRANCH_LINE_IDS.has(line.id)) {
      warn(line, `分支线连续站对缺少 edge (预期): ${fromName} → ${toName}`);
    } else {
      err(line, `连续站对缺少 edge: ${fromName} → ${toName}`);
    }

  }
}

// Check 3: schematicSegment coverage for consecutive station pairs
console.error('[3/8] 连续站对 schematicSegment 覆盖...');
for (const line of data.lines) {
  if (!line.schematicSegments) continue;
  for (let i = 0; i < line.stationIds.length - 1; i++) {
    const fromId = line.stationIds[i];
    const toId = line.stationIds[i + 1];
    const hasSeg = line.schematicSegments.some(
      (s) =>
        (s.fromStationId === fromId && s.toStationId === toId) ||
        (s.fromStationId === toId && s.toStationId === fromId)
    );
    if (!hasSeg) {
      const fromName = stationsById.get(fromId)?.name ?? fromId;
      const toName = stationsById.get(toId)?.name ?? toId;
      warn(line, `连续站对缺少 schematicSegment: ${fromName} → ${toName}`);
    }
  }
}

// Check 4: loop line closure — check all lines for first↔last edge
console.error('[4/8] 环线/首尾连接检查...');
for (const line of data.lines) {
  if (line.stationIds.length < 2) continue;
  const firstId = line.stationIds[0];
  const lastId = line.stationIds[line.stationIds.length - 1];
  const hasClosingEdge = data.edges.some(
    (e) =>
      e.lineId === line.id &&
      ((e.fromStationId === firstId && e.toStationId === lastId) ||
        (e.fromStationId === lastId && e.toStationId === firstId))
  );
  if (hasClosingEdge) {
    const firstName = stationsById.get(firstId)?.name ?? firstId;
    const lastName = stationsById.get(lastId)?.name ?? lastName;
    if (LOOP_LINE_IDS.has(line.id)) {
      // This line is expected to be a loop — check schematic closing segment
      const hasClosingSeg = line.schematicSegments?.some(
        (s) =>
          (s.fromStationId === firstId && s.toStationId === lastId) ||
          (s.fromStationId === lastId && s.toStationId === firstId)
      );
      if (!hasClosingSeg) {
        err(line, `环线缺少首尾闭合 schematicSegment: ${lastName} → ${firstName}`);
      } else {
        console.error(`  ✓ ${line.name} 环线已闭合`);
      }
    } else if (BRANCH_LINE_IDS.has(line.id)) {
      console.error(`  ~ ${line.name} 分支线路首尾有连接: ${lastName} ↔ ${firstName}`);
    } else if (EXPRESS_LINE_IDS.has(line.id)) {
      console.error(`  ~ ${line.name} 快线首尾有连接: ${lastName} ↔ ${firstName}`);
    } else {
      warn(line, `非环线有首尾 edge: ${lastName} ↔ ${firstName} (可能是分支或数据问题)`);
    }
  } else if (LOOP_LINE_IDS.has(line.id)) {
    err(line, `环线缺少首尾闭合 edge`);
  }
}

// Check 5: non-consecutive edge detection
console.error('[5/8] 非连续边检测...');
for (const line of data.lines) {
  const lineStationIds = line.stationIds;
  for (const edge of data.edges) {
    if (edge.lineId !== line.id) continue;
    const idx1 = lineStationIds.indexOf(edge.fromStationId);
    const idx2 = lineStationIds.indexOf(edge.toStationId);
    if (idx1 === -1 || idx2 === -1) continue;
    if (Math.abs(idx1 - idx2) === 1) continue; // consecutive, OK

    // Check if this is a closing edge for a loop line
    const isClosingEdge =
      (idx1 === 0 && idx2 === lineStationIds.length - 1) ||
      (idx1 === lineStationIds.length - 1 && idx2 === 0);

    if (isClosingEdge && LOOP_LINE_IDS.has(line.id)) continue; // expected for loops
    if (isClosingEdge && EXPRESS_LINE_IDS.has(line.id)) continue; // express lines (16号线大站车, 磁浮)

    const fromName = stationsById.get(edge.fromStationId)?.name ?? edge.fromStationId;
    const toName = stationsById.get(edge.toStationId)?.name ?? edge.toStationId;

    if (BRANCH_LINE_IDS.has(line.id)) {
      warn(line, `分支非连续边 (idx ${idx1}↔${idx2}): ${fromName} ↔ ${toName}`);
    } else if (EXPRESS_LINE_IDS.has(line.id)) {
      warn(line, `快线非连续边 (idx ${idx1}↔${idx2}): ${fromName} ↔ ${toName} (大站车/跳站)`);
    } else {
      err(line, `异常非连续边 (idx ${idx1}↔${idx2}): ${fromName} ↔ ${toName}`);
    }
  }
}

// Check 6: exact duplicate schematicSegments
console.error('[6/8] 完全重复 schematicSegment 检查...');
for (const line of data.lines) {
  if (!line.schematicSegments) continue;
  const seen = new Set();
  for (const seg of line.schematicSegments) {
    const key = `${seg.fromStationId}|${seg.toStationId}|${seg.x1}|${seg.y1}|${seg.x2}|${seg.y2}`;
    if (seen.has(key)) {
      const fromName = stationsById.get(seg.fromStationId)?.name ?? seg.fromStationId;
      const toName = stationsById.get(seg.toStationId)?.name ?? seg.toStationId;
      err(line, `重复的 schematicSegment: ${fromName} → ${toName} (${seg.x1},${seg.y1}→${seg.x2},${seg.y2})`);
    }
    seen.add(key);
  }
}

// Check 7: transfer station flag
console.error('[7/8] 换乘站标记检查...');
for (const station of data.stations) {
  if (station.lines.length > 1 && !station.isTransfer) {
    err(null, `站点 "${station.name}" 属于 ${station.lines.length} 条线路但 isTransfer=false`);
  }
  if (station.lines.length <= 1 && station.isTransfer) {
    warn(null, `站点 "${station.name}" 仅属于 ${station.lines.length} 条线路但 isTransfer=true`);
  }
}

// Check 8: station line membership consistency
console.error('[8/8] 站点线路成员一致性...');
const stationLinesFromEdges = new Map();
for (const edge of data.edges) {
  for (const sid of [edge.fromStationId, edge.toStationId]) {
    if (!stationLinesFromEdges.has(sid)) stationLinesFromEdges.set(sid, new Set());
    stationLinesFromEdges.get(sid).add(edge.lineId);
  }
}
for (const line of data.lines) {
  for (const sid of line.stationIds) {
    const edgeLines = stationLinesFromEdges.get(sid);
    if (edgeLines && !edgeLines.has(line.id)) {
      const name = stationsById.get(sid)?.name ?? sid;
      warn(line, `站点 "${name}" 在 stationIds 中但没有 line-${line.id} 的 edge`);
    }
  }
}

// Summary
console.error('\n=== 验证结果 ===');
console.error(`错误: ${errors.length}`);
console.error(`警告: ${warnings.length}`);

if (errors.length > 0) {
  console.error('\n--- 错误详情 ---');
  for (const e of errors) {
    const prefix = e.line ? `[${e.line}]` : '';
    console.error(`  ❌ ${prefix} ${e.message}`);
  }
}

if (warnings.length > 0) {
  console.error('\n--- 警告详情 ---');
  for (const w of warnings) {
    const prefix = w.line ? `[${w.line}]` : '';
    console.error(`  ⚠️  ${prefix} ${w.message}`);
  }
}

const summary = {
  stations: data.stations.length,
  lines: data.lines.length,
  edges: data.edges.length,
  errors: errors.length,
  warnings: warnings.length
};

console.error(`\n总计: ${summary.stations} 站点, ${summary.lines} 线路, ${summary.edges} 边`);
console.error(errors.length === 0 ? '✓ 所有检查通过' : '✗ 存在错误');

console.log(JSON.stringify({ summary, errors, warnings }, null, 2));

process.exit(errors.length === 0 ? 0 : 1);
