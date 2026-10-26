// Forward validated events to PostHog's batch API. The project key lives only
// here, as the POSTHOG_KEY secret, never in the CLI.
import type { Event } from './validate';

export interface PostHogBatch {
  api_key: string;
  batch: {
    event: string;
    distinct_id: string;
    timestamp: string;
    properties: Record<string, unknown>;
  }[];
}

export function toPostHog(key: string, installId: string, events: Event[]): PostHogBatch {
  return {
    api_key: key,
    batch: events.map((e) => ({
      event: e.event,
      distinct_id: installId,
      timestamp: e.ts,
      properties: {
        ...e.props,
        schema: 1,
        $lib: 'pilum-metrics-worker',
        // Anonymous events: no person profile, no location, no IP.
        $process_person_profile: false,
        $geoip_disable: true,
        $ip: null,
      },
    })),
  };
}

export async function forward(host: string, body: PostHogBatch, fetcher: typeof fetch = fetch): Promise<boolean> {
  const res = await fetcher(`${host.replace(/\/$/, '')}/batch/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.ok;
}
