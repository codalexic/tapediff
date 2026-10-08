These tapes are recorded through the real proxy against the local fake upstream
by `test/e2e/steps.test.ts`. Each API has JSON and SSE parallel-tool conversations,
an HTTP error, a stream error, and an aborted stream with partial output.

The recorder's timestamps, latency, and TCP chunk boundaries are normalized for
stable snapshots. Request/response payloads, matching keys, usage, pricing, and
abort state come from the recorded exchange. Unit tests separately split SSE into
single-character chunks to exercise arbitrary transport boundaries.

Regenerate intentionally with:

```sh
npx vitest run test/e2e/steps.test.ts --update
```

Review both the `.tape` and `.steps.json` snapshots after updating.
