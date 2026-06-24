import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CommuteRoute, MetroStation, RouteStep } from '@metro-meet/shared';

type ToolTextContent = {
  type: 'text';
  text: string;
};

type AmapGeoResponse = {
  results?: Array<{ location?: string }>;
};

type AmapTransitSegment = {
  walking?: {
    distance?: string;
    duration?: string;
    steps?: Array<{ instruction?: string; distance?: string }>;
  };
  bus?: {
    buslines?: Array<{
      name?: string;
      duration?: string;
      departure_stop?: { name?: string };
      arrival_stop?: { name?: string };
      via_stops?: Array<{ name?: string }>;
    }>;
  };
};

type AmapTransitResponse = {
  transits?: Array<{
    duration?: string;
    walking_distance?: string;
    segments?: AmapTransitSegment[];
  }>;
};

const MCP_QPS = 3;
const MCP_MAX_ATTEMPTS = 3;
const MCP_RETRY_BASE_DELAY_MS = 450;

class RateLimiter {
  private chain: Promise<void> = Promise.resolve();
  private readonly interval: number;

  constructor(qps: number) {
    this.interval = 1000 / qps;
  }

  async acquire(): Promise<void> {
    const prev = this.chain;
    let next: () => void;
    this.chain = new Promise<void>((resolve) => {
      next = resolve;
    });
    await prev;
    await new Promise((resolve) => setTimeout(resolve, this.interval));
    next!();
  }
}

export class AmapMcpClient {
  private client?: Client;
  private readonly geocodeCache = new Map<string, string>();
  private readonly rateLimiter = new RateLimiter(MCP_QPS);

  constructor(private readonly url: string) {}

  async getRoute(from: MetroStation, to: MetroStation): Promise<CommuteRoute> {
    const [origin, destination] = await Promise.all([this.getStationLocation(from), this.getStationLocation(to)]);
    const raw = await this.callJsonTool<AmapTransitResponse>('maps_direction_transit_integrated', {
      origin,
      destination,
      city: '上海',
      cityd: '上海'
    });
    const best = raw.transits?.[0];
    if (!best?.duration) {
      throw new Error('高德 MCP 未返回可用公交地铁路线');
    }

    const steps: RouteStep[] = [];
    const lines: string[] = [];
    const transferStations: string[] = [];
    let lastStationName = from.name;

    for (const segment of best.segments ?? []) {
      const buslines = segment.bus?.buslines ?? [];
      const firstDepartureName = buslines[0]?.departure_stop?.name;

      if (segment.walking?.distance && Number(segment.walking.distance) > 0) {
        const nextStationName = firstDepartureName ?? to.name;
        steps.push({
          type: 'walk',
          fromStationName: lastStationName,
          toStationName: nextStationName,
          durationMinutes: secondsToMinutes(segment.walking.duration),
          description: `步行 ${segment.walking.distance} 米`
        });
        lastStationName = nextStationName;
      }

      for (const line of buslines) {
        if (line.name) lines.push(line.name);
        if (line.departure_stop?.name || line.arrival_stop?.name) {
          steps.push({
            type: 'subway',
            lineName: line.name,
            fromStationName: line.departure_stop?.name,
            toStationName: line.arrival_stop?.name,
            durationMinutes: secondsToMinutes(line.duration),
            description: line.name
          });
          lastStationName = line.arrival_stop?.name ?? lastStationName;
        }
      }
    }

    for (let index = 1; index < steps.length; index += 1) {
      const previous = steps[index - 1];
      const current = steps[index];
      if (previous?.type === 'subway' && current?.type === 'subway' && previous.toStationName) {
        transferStations.push(previous.toStationName);
      }
    }

    const uniqueLines = [...new Set(lines)];
    const uniqueTransfers = [...new Set(transferStations)];

    return {
      fromStationId: from.id,
      toStationId: to.id,
      durationMinutes: secondsToMinutes(best.duration) ?? 0,
      transferCount: Math.max(0, uniqueLines.length - 1),
      lines: uniqueLines,
      transferStations: uniqueTransfers,
      steps,
      raw,
      source: 'amap-mcp',
      updatedAt: new Date().toISOString()
    };
  }

  private async getStationLocation(station: MetroStation): Promise<string> {
    const cached = this.geocodeCache.get(station.id);
    if (cached) return cached;

    try {
      const raw = await this.callJsonTool<AmapGeoResponse>('maps_geo', {
        address: `上海${station.name}地铁站`,
        city: '上海'
      });
      const location = raw.results?.[0]?.location;
      if (location) {
        this.geocodeCache.set(station.id, location);
        return location;
      }
    } catch {
      // Fall back to imported OSM coordinates below.
    }

    if (station.lng !== undefined && station.lat !== undefined) {
      const location = `${station.lng},${station.lat}`;
      this.geocodeCache.set(station.id, location);
      return location;
    }

    throw new Error(`无法解析站点坐标：${station.name}`);
  }

  private async callJsonTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MCP_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.rateLimiter.acquire();
        const client = await this.getClient();
        const result = await client.callTool({ name, arguments: args });
        const content = result.content as ToolTextContent[] | undefined;
        const text = content?.find((item) => item.type === 'text')?.text;
        if (!text) throw new Error(`MCP 工具 ${name} 未返回文本内容`);
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new Error(`MCP 返回非 JSON 响应 (${name}): ${text.slice(0, 200)}`);
        }
      } catch (error) {
        lastError = error;
        if (attempt >= MCP_MAX_ATTEMPTS) break;
        await delay(MCP_RETRY_BASE_DELAY_MS * attempt);
      }
    }

    throw new Error(`MCP 工具 ${name} 请求失败，已重试 ${MCP_MAX_ATTEMPTS} 次：${errorMessage(lastError)}`);
  }

  private async getClient(): Promise<Client> {
    if (this.client) return this.client;

    const client = new Client({ name: 'metro-meet-api', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(this.url));
    await client.connect(transport);
    this.client = client;
    return client;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAmapClientFromEnv(): AmapMcpClient {
  const key = process.env.AMAP_MCP_KEY;
  if (!key) {
    throw new Error('缺少 AMAP_MCP_KEY，请复制 .env.example 为 .env 并填入高德 MCP Key');
  }
  return new AmapMcpClient(`https://mcp.amap.com/mcp?key=${key}`);
}

function secondsToMinutes(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return undefined;
  return Math.ceil(seconds / 60);
}
