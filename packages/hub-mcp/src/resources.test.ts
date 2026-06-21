import { describe, it, expect, vi } from 'vitest';
import {
  RESOURCE_DEFINITIONS,
  isKnownResource,
  readResource,
} from './resources.js';
import type { ToolCtx } from './mcp-tools.js';
import type { ApiClient } from './api-client.js';
import type { CliDriver } from './cli-driver.js';
import type { ResolvedConfig } from './config.js';

function ctx(over: { api?: Partial<ApiClient> }): ToolCtx {
  return {
    api: (over.api ?? {}) as unknown as ApiClient,
    cli: {} as unknown as CliDriver,
    cfg: {
      apiUrl: 'http://127.0.0.1:9400',
      configDir: '/tmp/th',
      hubBin: 'hub',
      autoUp: true,
      transport: 'direct',
    } as ResolvedConfig,
  };
}

describe('RESOURCE_DEFINITIONS', () => {
  it('declares the two cheap read views with JSON mime + known URIs', () => {
    expect(RESOURCE_DEFINITIONS.map((r) => r.uri).sort()).toEqual([
      'hub://earnings',
      'hub://status',
    ]);
    for (const r of RESOURCE_DEFINITIONS) {
      expect(r.mimeType).toBe('application/json');
      expect(isKnownResource(r.uri)).toBe(true);
    }
    expect(isKnownResource('hub://nope')).toBe(false);
  });
});

describe('readResource', () => {
  it('hub://earnings returns the earnings tool payload as the body', async () => {
    const api = { earnings: vi.fn().mockResolvedValue({ apex: { total: 7 } }) };
    const out = await readResource(ctx({ api }), 'hub://earnings');
    expect(out.contents).toHaveLength(1);
    const entry = out.contents[0]!;
    expect(entry.uri).toBe('hub://earnings');
    expect(entry.mimeType).toBe('application/json');
    expect(JSON.parse(entry.text)).toEqual({ apex: { total: 7 } });
  });

  it('hub://status mirrors the status tool (API source)', async () => {
    const api = {
      listNodes: vi.fn().mockResolvedValue({ nodes: [] }),
      transport: vi.fn().mockResolvedValue({ mode: 'direct' }),
    };
    const out = await readResource(ctx({ api }), 'hub://status');
    expect(JSON.parse(out.contents[0]!.text)).toMatchObject({ source: 'api' });
  });

  it('throws on an unknown URI', async () => {
    await expect(readResource(ctx({}), 'hub://bogus')).rejects.toThrow(
      /Unknown resource/
    );
  });
});
