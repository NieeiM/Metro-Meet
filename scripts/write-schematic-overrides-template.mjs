import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(dirname, '..');
const metroDataPath = path.join(rootDir, 'data', 'shanghai-metro.json');
const overridesPath = path.join(rootDir, 'data', 'schematic-overrides.json');

const metroData = JSON.parse(await readFile(metroDataPath, 'utf8'));
const linesById = new Map(metroData.lines.map((line) => [line.id, line.name]));
const template = {};

for (const station of metroData.stations) {
  template[station.name] = {
    stationId: station.id,
    lines: station.lines.map((lineId) => linesById.get(lineId) ?? lineId),
    autoSchematicX: station.schematicX,
    autoSchematicY: station.schematicY,
    offsetX: 0,
    offsetY: 0
  };
}

await writeFile(overridesPath, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
console.log(`Wrote ${Object.keys(template).length} station overrides to ${path.relative(rootDir, overridesPath)}`);
