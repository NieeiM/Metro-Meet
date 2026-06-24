# MetroMeet Shanghai

MetroMeet is a local-first Shanghai Metro multi-destination commute optimization tool. It helps answer questions like: given several target metro stations, which origin station has the shortest total commute time?

[中文说明](./README.zh-CN.md)

![Main UI](./figs/main.png)

![Route Planning](./figs/path.png)

## Features

- Interactive Shanghai Metro map with station search, target selection, pan, zoom, and keyboard navigation.
- Candidate origin ranking by total, average, shortest, and longest commute time.
- Precise route queries through Amap MCP, with local caching and automatic retry.
- Local metro graph pre-ranking to reduce MCP request volume.
- Route details with travel time, transfer count, route text, and map highlighting.
- Metro data update workflow based on OpenStreetMap Overpass, with fallback to local data regeneration when the network request fails.

## Tech Stack

Frontend: React 19, Vite, Zustand, TypeScript

Backend: Fastify, TypeScript, MCP SDK

Core algorithms: local metro graph, Dijkstra-style estimation, candidate ranking

Package manager: pnpm workspace

## Requirements

- Node.js `>=26 <27`
- pnpm `>=11 <12`
- Amap MCP key

## Getting Started

Install dependencies:

```bash
pnpm install
```

Create the environment file:

```bash
cp .env.example .env
```

Edit `.env`:

```bash
AMAP_MCP_KEY=your-amap-mcp-key
API_PORT=4000
WEB_PORT=5173
```

For how to create an Amap service key, see https://lbs.amap.com/api/mcp-server/create-project-and-key

Start the app:

```bash
pnpm dev
```

Default local URLs:

- Web: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:4000`

## Common Commands

```bash
pnpm dev                       # start API and web dev servers
pnpm dev:api                   # start API only
pnpm dev:web                   # start web only
pnpm typecheck                 # build and typecheck
pnpm test                      # run tests
pnpm import:metro              # update/regenerate metro data
pnpm write:schematic-overrides # regenerate schematic override template
```

## Metro Data Updates

Shanghai Metro data is stored in `data/shanghai-metro.json`.

To update or regenerate it:

```bash
pnpm import:metro
```

The script first tries to fetch fresh data from OpenStreetMap Overpass. If Overpass is unavailable, it falls back to the existing local `data/shanghai-metro.json` and regenerates layout/topology-derived fields.

If `data/schematic-overrides.json` exists, schematic coordinate overrides are applied.

After updating data, run:

```bash
pnpm typecheck
pnpm test
```

## Amap MCP

The backend uses Amap MCP for precise route planning:

Uses `maps_geo` to resolve station coordinates.

Uses `maps_direction_transit_integrated` to query public transit/metro routes.

MCP requests are rate-limited, cached, and retried up to three times automatically. Successful route results are written to `data/route-cache.json`.

For how to create an Amap service key, see https://lbs.amap.com/api/mcp-server/create-project-and-key

## Project Structure

```text
apps/
  api/        Fastify API, Amap MCP integration, route cache
  web/        React frontend
packages/
  core/       metro graph estimation and ranking logic
  shared/     shared Zod schemas and TypeScript types
scripts/
  import-shanghai-metro-osm.mjs
  validate-metro-data.mjs
  write-schematic-overrides-template.mjs
data/
  shanghai-metro.json
  schematic-overrides.json
  route-cache.template.json
```
