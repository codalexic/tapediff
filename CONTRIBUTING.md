# Contributing

Use Node ≥20 and npm. [docs/design.md](docs/design.md) describes how the pieces fit together.
From a checkout:

```sh
npm ci
npm run build
npm run lint
npm run typecheck
npm test
```

All four checks must pass before a PR. `npm test` builds the real CLI and uses
local fixtures/mock upstreams, never real provider APIs. Tests live in `test/unit`
and `test/e2e`. Install the [Python example dependencies](examples/python-openai/README.md)
to enable its e2e tests; otherwise those tests explicitly skip. The Node example
SDK is also available through the root development dependencies.

## Scripts

| Script                            | Purpose                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| `npm run build`                   | Bundle the CLI with tsup.                                          |
| `npm run dev`                     | Watch and rebuild.                                                 |
| `npm run lint`                    | ESLint.                                                            |
| `npm run typecheck`               | Strict TypeScript checks, no emit.                                 |
| `npm run format`                  | Prettier writes formatting across the repository. Review the diff. |
| `npm test` / `npm run test:watch` | Offline tests, once / watch.                                       |
| `npm run test:smoke`              | Opt-in live provider smoke tests; see below.                       |
| `npm run examples:record`         | Record six example tapes through the local mock; overwrites them.  |
| `npm run docs:help`               | Refresh CLI reference from real help output after build.           |
| `npm run docs:screenshot`         | Capture real diff/show output as self-contained SVGs after build.  |

Install both examples' dependencies before recording (the scripts prefer
`examples/python-openai/.venv`). The CLI reference is generated from `--help`,
and a test checks that commands in the READMEs use real flags.

To regenerate the six committed example tapes through the local mock (no API key):

```sh
npm run examples:record
```

This overwrites the committed tapes. Review the diff, then rebuild and run
`npm run docs:screenshot`.

## Releasing

1. Set the exact version in `package.json` and `package-lock.json`, and add a dated
   section to `CHANGELOG.md`. Keep dependencies pinned. Update release docs and
   regenerate screenshots/transcripts for any output changes.
2. Run build, lint, typecheck, and tests. Run `npm pack --dry-run`,
   `npm run test:package`, `npm run benchmark:startup`, and
   `npm audit --omit=dev --audit-level=high`. The package check installs the tarball
   into a fresh temporary project and runs version, help, and the committed Node
   replay; on Windows it also executes the `.cmd` shim directly. Installation
   needs registry access; replay uses the committed tape without a provider key.
3. Configure the repository's `NPM_TOKEN` secret with permission to publish
   `tapediff`. The release workflow grants `id-token: write` for npm provenance
   and `contents: write` for the GitHub release. Never commit the token.
4. After review and a green CI matrix (Node 20/22/24 on Linux/macOS/Windows, plus
   package checks on Linux/Windows), the maintainer pushes the matching `v*` tag,
   for example `v0.1.0`.
5. [Release](.github/workflows/release.yml) verifies the tag/version and changelog,
   runs checks, publishes with `npm publish --provenance --access public`, then
   creates a GitHub release from that version's changelog section. The
   `prepublishOnly` hook also runs typecheck, build, and tests.

If publishing succeeds but GitHub release creation fails, create the release
from the same changelog section manually; do not republish that npm version.
The npm archive includes compiled JavaScript, README, license, changelog, and
package metadata. Source maps, tests, examples, and tapes stay in the repository.

### Live smoke tests

`npm run test:smoke` records one tiny real request per configured provider,
replays it offline, and checks that the key is absent from the tape. Set
`OPENAI_API_KEY` and/or `ANTHROPIC_API_KEY` in your environment; providers without
keys skip. It uses `gpt-4.1-nano` / `claude-haiku-4-5` with eight output tokens.
This incurs provider charges. Temporary tapes are removed afterward. Never place
keys in source files, command arguments, logs, issues or PRs.

### Windows esbuild workaround

If esbuild cannot traverse a restricted user directory, map the repository's
**parent** to an unused drive, work in that drive's repository directory, then
remove the mapping in a `finally` block. For this checkout (PowerShell):

```powershell
subst R: C:\Users\TheGoatTsiklauri\Desktop\opensource
try {
  Set-Location R:\tapediff
  npm.cmd run build
  npm.cmd run lint
  npm.cmd run typecheck
  npm.cmd test
} finally {
  Set-Location C:\Users\TheGoatTsiklauri\Desktop\opensource\tapediff
  subst R: /d
}
```

Adapt the paths and choose an unused drive. `npm.cmd` avoids PowerShell's script
execution policy; no execution-policy change is necessary. Check each command's
exit code (PowerShell does not stop automatically on a failed native command).

## Adding a provider

1. Propose the endpoint, URL routing and SDK environment contract in `docs/design.md`.
2. Extend provider detection, upstream selection, and the child environment in
   `src/providers/detect.ts`, `src/proxy/server.ts`, and `src/commands/run-child.ts`.
3. Implement JSON/SSE extraction and usage in `src/providers/`, `src/steps.ts`
   and `src/steps/`; preserve provider-neutral steps and abort/error behavior.
4. Update tape provider validation and any affected diff schema/types. Treat
   tape/JSON compatibility deliberately; do not silently reinterpret old data.
5. Add mock-upstream e2e cases for record/replay, streaming, errors, concurrent
   requests and redaction; add pure unit cases for normalization/steps/diff.
6. Add model pricing only with a source and update supported/limitation docs.

Keep runtime dependencies minimal. Use strict TypeScript, ESM and small modules;
prefer pure functions. No `any` without a justification comment. Use `path` and
`cross-spawn` for Windows portability; avoid shell-specific package scripts.

## Pull requests

Describe the concrete problem, changed behavior, and tests run. Explain any
departure from the spec. Use short imperative commit messages, such as
“Show changed prompt context”. Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Security reports belong in [the private reporting channel](SECURITY.md).
