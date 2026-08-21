# Phase 1 release evidence — 0.3.0

Recorded 2026-08-20 against the local Colima lab. This release completes Phase 1C and carries forward the Phase 1A/1B evidence in the preceding release records.

## Bundle and automated gates

- Artifact: `dist/extension-workflows.js` (51,288 bytes).
- SHA-256: `e6bcffc56af983ce643cb4c382a6eb85e8f4f3cae7461aebaeef4d02181fa228`.
- Installed `extension-workflows-0.3.0.js` has the same digest; it is the only enabled `.js` bundle.
- `npm run check`: 45/45 tests passed with TypeScript, production build, 133-package license allowlist, 1,000-node generated-fixture, bundle externalization, and deterministic scale gates green.
- `npm audit --audit-level=low`: 0 vulnerabilities.
- Node budgets: deterministic 250-, 1,000-, and 5,000-node fixtures; the native window contains at most 20 data rows at the 448px live viewport and fewer than 25 including overscan in the pure contract.
- Run-history budget: a 5,000-entry shallow host tree yields 25 manifest reads, no more than six concurrent requests, a tree under 1 MB, and an extension page under 25 KB.
- Application identity keys prevent a cursor from carrying between Applications; superseded live-page effects abort their six bounded workers before replacement loads proceed.
- Anonymous telemetry covers extension load, Workflow readiness, run-page latency/failure/state/size and feature availability, and render errors. The typed payload has no resource-name, namespace, URL, message, parameter, or artifact field.

## Scale behavior

- DAGs remain available through 250 nodes and paint in 50-node animation-frame chunks.
- Workflows above 250 nodes open list-first; no SVG DAG is constructed.
- The fixed-height list renders only the visible rows plus bounded overscan. Live scrolling moved from rows 1–20 to 21–40 while the DOM stayed at 20 data rows.
- Search reduced the 1,000-node fixture to one matching row and preserved selection/details after virtual scrolling.
- Codex browser automation observed a 43 ms search interaction on the live 1,000-node fixture. The measured 3.8 s tab transition is an end-to-end automation wall clock including Argo CD's large resource fetch and tool transport, not a main-thread claim.

## Paging and authorization boundary

- Live run paging is accurately described as browser paging over Argo CD's host-supplied shallow Application tree. Only complete-manifest fan-out and rendered payload are bounded.
- Argo CD 2.13.4/3.4.6 do not inject a list/page client into the Application extension. A genuine proxy requires an authenticated Application/Project header boundary, `applications,get` plus `extensions,invoke`, a mandatory label-selectable Application identity, namespace scope, `limit=25`, and opaque Kubernetes continuation.
- No namespace-only proxy was added: it could disclose or misattribute Workflows from another Application. Archive remains capability-unavailable.
- Two-Project, restricted-namespace, own-resource/cross-resource RBAC evidence remains recorded in `docs/release-evidence-0.2.0.md`; no authorization path changed in 0.3.0.

## Compatibility and browser evidence

| Argo CD | Result |
|---|---|
| 2.13.4 | Pass. Application Workflows loaded three authorized rows with no alerts. The 1,000-node resource opened list-first, rendered 20 data rows, scrolled to the next window without DOM growth, selected node details, and rendered white text on the dark host background. |
| 3.4.6 | Pass. Application Workflows loaded three authorized rows with no alerts. The same large resource rendered 20 rows, scrolled to rows 21–40, and stayed free of the extension error boundary. |

The 3.4.6 check temporarily changed only the Colima `argocd-server` image. The server was restored to `quay.io/argoproj/argocd:v2.13.4` and reached Ready 1/1. Final browser state reports `v2.13.4+102853d` at the Application Workflows view.

## Visual evidence

- `docs/screenshots/phase1c-argocd-2.13.4-large-workflow-virtualized-1242x1403.png`
- `docs/screenshots/phase1c-argocd-2.13.4-large-workflow-dark-1242x1403.png`
- `docs/screenshots/phase1c-argocd-3.4.6-large-workflow-virtualized-1242x1403.png`
- Phase 1A/1B light/dark Application, Workflow, WorkflowTemplate, and CronWorkflow images remain under `docs/screenshots/`.

## Final local state

- Cluster: only commands explicitly pinned to `kubectl --context colima` or `helmfile --kube-context colima` were used.
- Argo CD server: `quay.io/argoproj/argocd:v2.13.4`, Ready 1/1.
- Demo Application: `Synced/Degraded`; degradation remains intentional from the failed diagnostic Workflow fixture.
- Extension: only `extension-workflows-0.3.0.js` enabled, digest matches the release artifact.

## Release result

Phase 1 is complete for the supported Argo CD `>=2.13.4, <3.5` host contract. The unsafe server-paging shortcut is deliberately absent; ADR 0003 defines the deployment identity contract that must exist before a proxy can be added.
