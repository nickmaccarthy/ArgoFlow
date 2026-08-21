# Release evidence

Copy this file into the release PR or release notes. Do not mark a result passed without its command output, screenshot, or CI link.

## Release

| Item | Record |
|---|---|
| Extension version | `<version>` |
| Immutable bundle name and digest | `extension-workflows-<version>.js`, `<sha256>` |
| Commit | `<commit>` |
| Date and operator | `<date>, <name>` |

## Compatibility and installation

| Argo CD | Required result | Evidence |
|---|---|---|
| 2.13.4 | Tested lower-bound baseline | `<command output / CI link>` |
| 3.4.6 | Latest selected 3.4 patch; pending until recorded | `<command output / CI link>` |

Record the local install command, `argocd-server` rollout result, and a hard-refresh confirmation that the bundle loads from `/tmp/extensions`.

## Release gates

| Gate | Evidence |
|---|---|
| `npm run check` | `<output / CI link>` |
| Bundle excludes React | `<bundle test output>` |
| License check | `<check:licenses output>` |
| 1,000-node performance fixture | `<timing and environment>` |
| 5,000-run bounded-history fixture | `<tree/page bytes, fetch count, concurrency, timing>` |
| Two-Project authorization boundary | `<own/cross-project/cross-namespace HTTP results>` |
| WorkflowTemplate screenshot, light/dark | `<links>` |
| CronWorkflow screenshot, light/dark | `<links>` |
| Application runs screenshot, light/dark/common widths | `<links>` |
| Resource-entry screenshot, light theme | `<link>` |
| Run-detail screenshot, light theme | `<link>` |
| Resource-entry screenshot, dark theme | `<link>` |
| Run-detail screenshot, dark theme | `<link>` |
| Rollback (`npm run uninstall:local`) and server rollout | `<output / CI link>` |

## Scope and security review

- Confirmed read-only: no logs, artifacts, mutations, cross-Application aggregation, event submission, or EventBus administration.
- Record the live-query authorization boundary, correlation rules, and archive capability state.
- Confirmed React is externalized and styles remain under the extension root.
- Record known deviations, sensitive-data findings, and rollback notes: `<details>`.
