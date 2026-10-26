# Pilum-Metrics-Worker

The endpoint behind Pilum's opt-in telemetry, `https://t.pilum.dev/v1/events`.

Pilum sends nothing unless you turn telemetry on: the first-run prompt, `pilum telemetry enable`, `PILUM_TELEMETRY=1`, or `telemetry: true` on the GitHub Action. `DO_NOT_TRACK=1` always turns it off. User docs: [pilum.dev/docs/reference/telemetry](https://pilum.dev/docs/reference/telemetry/).

This Worker is the only thing the CLI talks to. It:

1. checks every event against [`schema/v1.json`](schema/v1.json), and drops any event with a name, property or value that isn't listed there;
2. never reads, logs or forwards the client's IP address (request logs are off);
3. forwards what's left to a PostHog project as anonymous events (no person profile, no GeoIP), with the project key held here as a secret, never in the CLI;
4. stores nothing itself.

Because the CLI only knows this URL and Pilum's own format, the key, the fields or the analytics backend can change without a CLI release.

## What an event looks like

```json
{
  "schema": 1,
  "install_id": "6f1c3e9a-2b4d-4c8e-9f10-1a2b3c4d5e6f",
  "sent_at": "2026-10-27T14:03:11Z",
  "events": [
    {
      "event": "pilum_run",
      "ts": "2026-10-27T14:03:10Z",
      "props": {
        "version": "v0.11.0", "os": "linux", "arch": "amd64",
        "command": "deploy", "ci": true, "ci_provider": "github_actions",
        "success": false, "exit_class": "deploy", "duration_ms": 184230,
        "services": 7, "recipes": { "gcp-cloud-run": 5, "npm": 2 },
        "waves": 3, "flags": { "dry_run": false, "only_changed": true }
      }
    }
  ]
}
```

`install_id` is a random UUID created when you opt in and deleted when you opt out. Recipe and step names are Pilum's built-in ones; a recipe loaded with `--recipe-path` is reported as `custom`. Service names, project IDs, paths, tags, repo names, environment variables and error messages are never sent, and the allowlist here would drop them if they were.

## API

| Request | Response |
|---|---|
| `POST /v1/events`, `application/json`, ≤ 32 KB, ≤ 50 events | `202 {"accept": true, "accepted": n, "dropped": m}` |
| Collection switched off (`COLLECTION_ENABLED = "false"`) | `202 {"accept": false}`. The CLI stops sending for 7 days. |
| More than 60 batches a minute from one install ID | `429` |
| Bad content type, oversized body, invalid JSON, wrong `schema` or `install_id` | `400` |
| More than 50 events | `413` |
| `GET /` | A pointer to the docs |

## Develop

```bash
pnpm install
pnpm check        # oxfmt, oxlint, tsc, vitest
pnpm dev          # local Worker on :8787
```

Point a local Pilum at it with `PILUM_TELEMETRY=1 PILUM_TELEMETRY_ENDPOINT=http://localhost:8787/v1/events`.

Changing `schema/v1.json` changes what's accepted. Pilum's tests check their constants against a copy of it (`lib/telemetry/testdata/v1.json` in the Pilum repo), so change both together.

## Deploy

Merges to `main` deploy through `.github/workflows/deploy.yml`, which needs a `CLOUDFLARE_API_TOKEN` repo secret with Workers edit access. The PostHog key is a Worker secret:

```bash
pnpm exec wrangler secret put POSTHOG_KEY
```

Until it's set, the Worker accepts events and discards them.

To stop collection everywhere, set `COLLECTION_ENABLED = "false"` in `wrangler.toml` and deploy.

## License

Apache 2.0, like Pilum.
