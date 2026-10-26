// t.pilum.dev: receives opt-in telemetry from the Pilum CLI, keeps only what
// schema/v1.json allows, and forwards it to PostHog. It stores nothing and
// never reads or forwards the client's IP address.
//
// POST /v1/events   a batch in Pilum's own format (see README.md)
// GET  /            one line pointing at the telemetry docs
import { forward, toPostHog } from './posthog';
import { LIMITS, parseBatch, validateEvent, type Drop, type Event } from './validate';

export interface Env {
  /** PostHog "Pilum CLI" project key. Until it is set, events are accepted and discarded. */
  POSTHOG_KEY?: string;
  POSTHOG_HOST: string;
  /** "false" tells every CLI to stop sending for a week. */
  COLLECTION_ENABLED: string;
  RATE_LIMITER?: RateLimit;
  METRICS?: AnalyticsEngineDataset;
}

const DOCS = 'https://pilum.dev/docs/reference/telemetry/';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Counts for monitoring the Worker without PostHog. No identifiers, only tallies. */
function record(env: Env, outcome: string, accepted = 0, dropped: Partial<Record<Drop, number>> = {}) {
  env.METRICS?.writeDataPoint({
    blobs: [outcome],
    doubles: [
      accepted,
      dropped.shape ?? 0,
      dropped.event ?? 0,
      dropped.property ?? 0,
      dropped.value ?? 0,
      dropped.timestamp ?? 0,
    ],
  });
}

async function handleEvents(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) {
    return json(400, { error: 'content-type must be application/json' });
  }
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > LIMITS.max_body_bytes) return json(400, { error: 'body too large' });

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > LIMITS.max_body_bytes) return json(400, { error: 'body too large' });

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { error: 'invalid JSON' });
  }
  const batch = parseBatch(body);
  if (!batch) return json(400, { error: 'expected {schema: 1, install_id, events}' });
  if (batch.events.length > LIMITS.max_events) return json(413, { error: `at most ${LIMITS.max_events} events` });

  if (env.COLLECTION_ENABLED === 'false') {
    record(env, 'paused');
    return json(202, { accept: false });
  }

  if (env.RATE_LIMITER) {
    const { success } = await env.RATE_LIMITER.limit({ key: batch.install_id });
    if (!success) {
      record(env, 'rate_limited');
      return json(429, { error: 'rate limited' });
    }
  }

  const kept: Event[] = [];
  const dropped: Partial<Record<Drop, number>> = {};
  for (const raw of batch.events) {
    const result = validateEvent(raw);
    if (result.ok) kept.push(result.event);
    else dropped[result.reason] = (dropped[result.reason] ?? 0) + 1;
  }

  if (env.POSTHOG_KEY && kept.length > 0) {
    const payload = toPostHog(env.POSTHOG_KEY, batch.install_id, kept);
    ctx.waitUntil(
      forward(env.POSTHOG_HOST, payload).then(
        (ok) => record(env, ok ? 'forwarded' : 'forward_failed', kept.length, dropped),
        () => record(env, 'forward_failed', kept.length, dropped),
      ),
    );
  } else {
    record(env, env.POSTHOG_KEY ? 'empty' : 'no_key', kept.length, dropped);
  }

  const droppedTotal = Object.values(dropped).reduce((a, b) => a + (b ?? 0), 0);
  return json(202, { accept: true, accepted: kept.length, dropped: droppedTotal });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/v1/events') {
      if (request.method !== 'POST') return json(405, { error: 'POST only' });
      return handleEvents(request, env, ctx);
    }
    if (pathname === '/' && request.method === 'GET') {
      return new Response(`Pilum telemetry endpoint. What is collected and how to turn it off: ${DOCS}\n`, {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    return json(404, { error: 'not found' });
  },
} satisfies ExportedHandler<Env>;
