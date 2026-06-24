import 'dotenv/config';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { optimalOriginsRequestSchema } from '@metro-meet/shared';
import { calculateOptimalOrigins } from './calculator.js';
import { clearRouteCache, getCachedRoute, routeCacheStats, setCachedRoute } from './route-cache.js';
import { loadMetroData } from './data.js';
import { createAmapClientFromEnv } from './amap-client.js';

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: true
});

app.get('/api/health', async () => ({ ok: true }));

app.get('/api/metro/shanghai', async () => loadMetroData());

app.get('/api/route', async (request, reply) => {
  const query = request.query as { fromStationId?: string; toStationId?: string };
  if (!query.fromStationId || !query.toStationId) {
    return reply.code(400).send({ error: 'fromStationId 和 toStationId 必填' });
  }

  const data = await loadMetroData();
  const stationsById = new Map(data.stations.map((station) => [station.id, station]));
  const from = stationsById.get(query.fromStationId);
  const to = stationsById.get(query.toStationId);
  if (!from || !to) {
    return reply.code(404).send({ error: '站点不存在' });
  }

  try {
    const cached = await getCachedRoute(from.id, to.id);
    if (cached) return cached;

    const route = await createAmapClientFromEnv().getRoute(from, to);
    await setCachedRoute(route);
    return route;
  } catch (error) {
    return reply.code(503).send({ error: error instanceof Error ? error.message : '路线查询失败' });
  }
});

app.post('/api/optimal-origins', async (request, reply) => {
  const parsed = optimalOriginsRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  const data = await loadMetroData();

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const sendEvent = (event: string, payload: unknown) => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const result = await calculateOptimalOrigins(data, parsed.data, (progress) => {
      sendEvent('progress', progress);
    });
    sendEvent('result', result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '计算失败';
    sendEvent('error', { message });
  }

  reply.raw.end();
});

app.post('/api/cache/clear', async () => {
  await clearRouteCache();
  return routeCacheStats();
});

const port = Number(process.env.API_PORT ?? 4000);
const host = process.env.API_HOST ?? '127.0.0.1';

await app.listen({ port, host });
