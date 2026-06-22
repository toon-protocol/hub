import { describe, it, expect, vi } from 'vitest';
import { ApiClient, ApiError, ApexUnreachableError } from './api-client.js';

/** A fetch stub returning a JSON Response with the given status. */
function jsonFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () =>
      new Response(body === undefined ? '' : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
  ) as unknown as typeof fetch;
}

function client(fetchImpl: typeof fetch): ApiClient {
  return new ApiClient({ baseUrl: 'http://127.0.0.1:9400/', fetchImpl });
}

describe('ApiClient request mapping', () => {
  it('GETs the right URL and parses JSON', async () => {
    const fetchImpl = jsonFetch({ entries: [], ts: 1 });
    const c = client(fetchImpl);
    const res = await c.balances();
    expect(res).toEqual({ entries: [], ts: 1 });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:9400/wallet/balances',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('POSTs a JSON body with content-type for withdraw', async () => {
    const fetchImpl = jsonFetch({ txHash: '0xabc', chainId: 84532 });
    const c = client(fetchImpl);
    await c.withdraw({
      nodeType: 'town',
      chainFamily: 'evm',
      token: 'native',
      recipient: '0x00',
      amount: '1',
    } as never);
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(call[0]).toBe('http://127.0.0.1:9400/wallet/withdraw');
    expect(call[1].method).toBe('POST');
    expect(call[1].headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(call[1].body)).toMatchObject({ nodeType: 'town' });
  });

  it('encodes path params for removeNode', async () => {
    const fetchImpl = jsonFetch({ ok: true });
    await client(fetchImpl).removeNode('town/01');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:9400/api/nodes/town%2F01',
      expect.objectContaining({ method: 'DELETE' })
    );
  });
});

describe('ApiClient error mapping', () => {
  it('maps a non-2xx body to ApiError with status + detail', async () => {
    const fetchImpl = jsonFetch(
      { error: 'insufficient_balance', detail: 'need more', retryable: false },
      400
    );
    await expect(client(fetchImpl).balances()).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      retryable: false,
      detail: 'need more',
      message: 'insufficient_balance',
    });
  });

  it('surfaces the node-lifecycle {step, err} body in message + detail', async () => {
    const fetchImpl = jsonFetch(
      { step: 'preflight', err: 'MILL_RELAYS is not set...' },
      400
    );
    const e = await client(fetchImpl)
      .addNode({ type: 'mill' })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    const apiErr = e as ApiError;
    expect(apiErr.status).toBe(400);
    expect(apiErr.retryable).toBe(false);
    // The agent must see the step + the reason, not a bare "HTTP 400".
    expect(apiErr.message).toBe('[preflight] MILL_RELAYS is not set...');
    expect(apiErr.detail).toBe('MILL_RELAYS is not set...');
  });

  it('still honours the generic {error, detail, retryable} body', async () => {
    const fetchImpl = jsonFetch(
      {
        error: 'usdc_address_not_configured',
        detail: 'set USDC',
        retryable: false,
      },
      400
    );
    await expect(client(fetchImpl).earnings()).rejects.toMatchObject({
      message: 'usdc_address_not_configured',
      detail: 'set USDC',
      status: 400,
      retryable: false,
    });
  });

  it('marks 503 retryable by default', async () => {
    const fetchImpl = jsonFetch({ error: 'busy' }, 503);
    const e = await client(fetchImpl)
      .earnings()
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).retryable).toBe(true);
  });

  it('throws ApexUnreachableError when fetch rejects', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(client(fetchImpl).earnings()).rejects.toBeInstanceOf(
      ApexUnreachableError
    );
  });
});

describe('ApiClient.ping', () => {
  it('true when the apex answers 2xx', async () => {
    expect(await client(jsonFetch({ nodes: [] })).ping()).toBe(true);
  });

  it('true when reachable but errored (5xx)', async () => {
    expect(await client(jsonFetch({ error: 'x' }, 500)).ping()).toBe(true);
  });

  it('false when unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('refused');
    }) as unknown as typeof fetch;
    expect(await client(fetchImpl).ping()).toBe(false);
  });
});
