import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import worker, { type Env } from '../src/index';
import { toPostHog } from '../src/posthog';
import { validateEvent } from '../src/validate';

// Node's Request has no Cloudflare edge fields (colo, httpProtocol...); the handler doesn't read them.
const fetchWorker = (req: Request, e: Env, c: ExecutionContext) =>
  worker.fetch(req as Parameters<typeof worker.fetch>[0], e, c);

const INSTALL_ID = '6f1c3e9a-2b4d-4c8e-9f10-1a2b3c4d5e6f';
const TS = '2026-10-27T14:03:10Z';

const run = (props: Record<string, unknown> = {}) => ({
  event: 'pilum_run',
  ts: TS,
  props: {
    version: 'v0.11.0',
    os: 'linux',
    arch: 'amd64',
    command: 'deploy',
    ci: true,
    ci_provider: 'github_actions',
    success: false,
    exit_class: 'deploy',
    duration_ms: 184230,
    services: 7,
    recipes: { 'gcp-cloud-run': 5, npm: 2 },
    waves: 3,
    flags: { dry_run: false, only_changed: true },
    ...props,
  },
});

const stepFailed = (props: Record<string, unknown> = {}) => ({
  event: 'pilum_step_failed',
  ts: TS,
  props: {
    version: 'v0.11.0',
    os: 'darwin',
    arch: 'arm64',
    ci: false,
    ci_provider: 'none',
    recipe: 'gcp-cloud-run',
    step: 'deploy to cloud run',
    error_class: 'permission',
    duration_ms: 41200,
    ...props,
  },
});

let fetchMock: ReturnType<typeof vi.fn>;
let waits: Promise<unknown>[];
const ctx = () =>
  ({ waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} }) as unknown as ExecutionContext;
const env = (overrides: Partial<Env> = {}): Env => ({
  POSTHOG_KEY: 'phc_test',
  POSTHOG_HOST: 'https://us.i.posthog.com',
  COLLECTION_ENABLED: 'true',
  ...overrides,
});

const post = (body: unknown, init: { contentType?: string; raw?: string } = {}) =>
  new Request('https://t.pilum.dev/v1/events', {
    method: 'POST',
    headers: { 'content-type': init.contentType ?? 'application/json' },
    body: init.raw ?? JSON.stringify(body),
  });

const batch = (events: unknown[], extra: Record<string, unknown> = {}) => ({
  schema: 1,
  install_id: INSTALL_ID,
  sent_at: TS,
  events,
  ...extra,
});

async function send(req: Request, e: Env = env()) {
  const res = await fetchWorker(req, e, ctx());
  await Promise.all(waits);
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Every PostHog batch the Worker tried to forward. */
const forwarded = () => fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));

beforeEach(() => {
  waits = [];
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('forwarding', () => {
  it('forwards one PostHog event per valid input, anonymous and without location', async () => {
    const { status, body } = await send(post(batch([run(), stepFailed()])));
    expect(status).toBe(202);
    expect(body).toEqual({ accept: true, accepted: 2, dropped: 0 });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe('https://us.i.posthog.com/batch/');
    const [sent] = forwarded();
    expect(sent.api_key).toBe('phc_test');
    expect(sent.batch).toHaveLength(2);
    for (const e of sent.batch) {
      expect(e.distinct_id).toBe(INSTALL_ID);
      expect(e.properties).toMatchObject({
        $process_person_profile: false,
        $geoip_disable: true,
        $ip: null,
        schema: 1,
      });
    }
    expect(sent.batch[0].properties.recipes).toEqual({ 'gcp-cloud-run': 5, npm: 2 });
  });

  it('accepts and discards everything while no PostHog key is set', async () => {
    const { status, body } = await send(post(batch([run()])), env({ POSTHOG_KEY: undefined }));
    expect(status).toBe(202);
    expect(body).toMatchObject({ accept: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tells clients to stop when collection is switched off, and forwards nothing', async () => {
    const { status, body } = await send(post(batch([run()])), env({ COLLECTION_ENABLED: 'false' }));
    expect(status).toBe(202);
    expect(body).toEqual({ accept: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still answers 202 when PostHog fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    const { status } = await send(post(batch([run()])));
    expect(status).toBe(202);
  });
});

describe('the allowlist drops bad events and keeps the rest', () => {
  const cases: [string, unknown][] = [
    ['unknown event name', { event: 'pilum_whoami', ts: TS, props: {} }],
    ['unknown property', run({ service_name: 'billing-api' })],
    ['unknown enum value', run({ command: 'check' })],
    ['a service name where a recipe goes', stepFailed({ recipe: 'billing-api', step: 'custom' })],
    ['a step from another recipe', stepFailed({ step: 'push to tap' })],
    ['a custom step name', stepFailed({ step: 'migrate prod db' })],
    ['a recipe count keyed by service name', run({ recipes: { 'billing-api': 1 } })],
    ['an unknown flag', run({ flags: { tag: true } })],
    ['services over its cap', run({ services: 1001 })],
    ['negative duration', run({ duration_ms: -1 })],
    ['fractional count', run({ waves: 1.5 })],
    ['free-text version', run({ version: 'built by alice on prod-box' })],
    ['error text smuggled into error_class', stepFailed({ error_class: 'permission denied for project acme-prod' })],
    ['missing timestamp', { event: 'pilum_run', props: {} }],
    ['props not an object', { event: 'pilum_run', ts: TS, props: 'x' }],
  ];

  it.each(cases)('%s', async (_name, bad) => {
    const { status, body } = await send(post(batch([bad, run()])));
    expect(status).toBe(202);
    expect(body).toEqual({ accept: true, accepted: 1, dropped: 1 });
    const [sent] = forwarded();
    expect(sent.batch).toHaveLength(1);
    const text = JSON.stringify(sent);
    for (const leak of ['billing-api', 'migrate prod db', 'alice', 'acme-prod', 'service_name']) {
      expect(text).not.toContain(leak);
    }
  });

  it('accepts custom recipes and steps reported as "custom"', () => {
    expect(validateEvent(stepFailed({ recipe: 'custom', step: 'custom' })).ok).toBe(true);
    expect(validateEvent(run({ recipes: { custom: 2, homebrew: 1 } })).ok).toBe(true);
  });

  it('accepts dev builds and pre-release versions', () => {
    expect(validateEvent(run({ version: 'dev' })).ok).toBe(true);
    expect(validateEvent(run({ version: 'v0.11.0-rc.1' })).ok).toBe(true);
  });
});

describe('request checks', () => {
  it('rejects a body over 32 KB', async () => {
    const big = batch([run()], { padding: 'x'.repeat(33_000) });
    expect((await send(post(big))).status).toBe(400);
  });

  it('rejects more than 50 events', async () => {
    expect((await send(post(batch(Array.from({ length: 51 }, () => run()))))).status).toBe(413);
  });

  it('rejects the wrong content type', async () => {
    expect((await send(post(batch([run()]), { contentType: 'text/plain' }))).status).toBe(400);
  });

  it('rejects malformed JSON', async () => {
    expect((await send(post(null, { raw: '{"schema":1,' }))).status).toBe(400);
  });

  it('rejects other schema versions and bad install IDs', async () => {
    expect((await send(post(batch([run()], { schema: 2 })))).status).toBe(400);
    expect((await send(post(batch([run()], { install_id: 'my-laptop' })))).status).toBe(400);
  });

  it('rate limits by install ID', async () => {
    const limiter = { limit: vi.fn(async () => ({ success: false })) } as unknown as RateLimit;
    const { status } = await send(post(batch([run()])), env({ RATE_LIMITER: limiter }));
    expect(status).toBe(429);
    expect(limiter.limit).toHaveBeenCalledWith({ key: INSTALL_ID });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('only allows POST on /v1/events and 404s elsewhere', async () => {
    const get = new Request('https://t.pilum.dev/v1/events');
    expect((await fetchWorker(get, env(), ctx())).status).toBe(405);
    expect((await fetchWorker(new Request('https://t.pilum.dev/other'), env(), ctx())).status).toBe(404);
  });

  it('serves a pointer to the docs on /', async () => {
    const res = await fetchWorker(new Request('https://t.pilum.dev/'), env(), ctx());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('pilum.dev/docs/reference/telemetry');
  });
});

describe('toPostHog', () => {
  it('never copies anything but the validated props', () => {
    const out = toPostHog('k', INSTALL_ID, [{ event: 'pilum_run', ts: TS, props: { success: true } }]);
    expect(Object.keys(out.batch[0])).toEqual(['event', 'distinct_id', 'timestamp', 'properties']);
  });
});
