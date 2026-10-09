# Replay matching

Strict matching is the default for both replay and test. A tape records responses,
not the agent's whole process: the agent builds requests again during replay.

## Normalization

The SHA-256 match key covers canonical JSON of method, path, and normalized body:

- Uppercase the method; remove the query string and one boundary-delimited
  `/openai` or `/anthropic` proxy prefix from the path.
- Sort object keys recursively; preserve array order, whitespace in strings,
  and nested user content. Headers are not part of the key.
- Drop only these **top-level** body fields: `user`, `metadata`, `stream_options`,
  `store`, `service_tier`, `request_id`, `requestId`, `request-id`, `x-request-id`.
- Loose mode additionally drops top-level `seed`. Strict mode preserves it.

These rules apply to all endpoints. Identical keys form queues consumed in
recorded `seq` order. Each exchange can be consumed once. Distinct keys can be
requested in a different order; this is request matching, not a global call-order
assertion. An extra identical request exhausts its queue and misses.

## Strict versus loose

| Mode                                   | No normalized match                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Strict (default, or replay `--strict`) | HTTP 500 error; diagnostic request diff; replay exits 3 after the child finishes.                            |
| Replay `--loose`                       | Take the next unconsumed exchange with the same endpoint and model, and warn. If none exists, miss as above. |

Loose matching can conceal prompt or tool-schema changes. Use it to explore a
recording, not to certify a regression test. `test` always uses strict matching.
Loose fallback ignores the method and body beyond model; it does not call a model.

## When replay misses

1. Read the stderr diff between the incoming request and the nearest unused
   recorded request at that endpoint. Similarity is shared canonical JSON lines,
   not semantic meaning; ties keep recorded order.
2. Check the scenario, prompt, model, tool schema, SDK version, and generated
   values. A seed change matters in strict mode. Queries/headers do not.
3. Wrap local tools with the [tool helpers](tools.md) and keep scenario selection deterministic. `{tape}` and
   `TAPEDIFF_TAPE` can help select the correct input.
4. For an intentional change, [re-record and review the diff](ci.md#updating-tapes).
   Keep the old baseline until review is complete. Do not hand-edit match keys.

Replay never falls back to the real provider. It warns about unused exchanges;
`test` additionally fails on them. A passing replay with unused calls is therefore
weaker than a passing test suite. Redaction can change response/tool values;
see [tape format](tape-format.md#redaction) if secret-bearing history no longer matches.

Wrapped tools use separate FIFO queues keyed by canonical `{name,args}` and
always match strictly; `--loose` only affects HTTP exchanges. Tool misses and
unused tool records also count toward `test` failures.
