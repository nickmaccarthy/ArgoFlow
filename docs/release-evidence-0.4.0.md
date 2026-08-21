# Phase 2 release evidence — 0.4.0

Recorded 2026-08-21 against the local Colima lab. This release completes the read-only Argo Events experience while preserving the Phase 1 Workflow surfaces.

## Bundle and automated gates

- Artifact: `dist/extension-workflows.js` (137,312 bytes).
- SHA-256: `4a51b27802794c39ebe22b939ddb3aec6db4bfbe1fb1adfdef9830381e3bf031`.
- Installed `extension-workflows-0.4.0.js` has the same digest and is the only enabled `.js` bundle.
- `npm run check`: 73/73 tests passed with TypeScript, production build, 133-package license allowlist, deterministic 1,000-node fixture, and React externalization green.
- Related Event reads use only exact Application-tree identities: at most 25 complete manifests, six concurrent workers, and abort on superseding selection.
- Chain construction caps SVG data at 100 cards and mounts at most 40 list rows above the graph ceiling.
- Adversarial coverage distinguishes 401, 403, missing, malformed, empty, stale, partial, and truncated results; secret-bearing JSON/camelCase controller and Pod messages are redacted.

## Live fixture

- GitOps revision: `6d148a9e20296001f55f749492e0d7f859e5425c`.
- Argo Events: `quay.io/argoproj/argo-events:v1.9.11`.
- Argo Workflows: `quay.io/argoproj/workflow-controller:v3.7.4`.
- Resources: one EventBus, two EventSources, and five Sensors in namespace `argo`.
- Healthy: `workflows-events-healthy-vsg9t` succeeded 3/3 and its Sensor owner UID matched exactly.
- Fan-in: `workflows-events-fan-in-57bwm` appeared only after both dependencies and succeeded 3/3.
- Fan-out: two Workflows (`workflows-events-fan-out-one-xkqrq`, `workflows-events-fan-out-two-kqf8q`) each succeeded 3/3.
- Unsatisfied filter: Sensor controller recorded that the dependency did not pass its filter; no Workflow was created. The browser reports unknown because that log is not exposed through the Application-scoped API.
- Trigger failure: Sensor controller recorded `jobs.batch is forbidden`; no Job or Workflow was created. The browser shows the configured `batch/v1/Job` trigger as outside the Workflow chain and does not claim to observe the RBAC log.
- Source failure: the unavailable EventSource reports `Deployed=False` with `EventBus not found`; the selected chain contains only that blocked source.

## Compatibility and browser evidence

| Argo CD | Result |
|---|---|
| 2.13.4 | Pass. EventSource, Sensor, and EventBus tabs rendered. Healthy showed one verified Workflow and three Pods with working Argo CD links; source failure was the first blocked hop; trigger/no-Workflow and unsatisfied-filter remained unknown; fan-in showed 1/3 and fan-out 2/6. Light and dark screenshots passed, with zero console errors. |
| 3.4.6 | Pass. The same interactive matrix rendered against `v3.4.6`; healthy showed 1/3, fan-in 1/3, fan-out 2/6, source blocked, and both no-Workflow cases remained unknown. Zero console errors. |

The 3.4.6 check changed only the Colima `argocd-server` container. It was restored to `quay.io/argoproj/argocd:v2.13.4` and reached Ready 1/1. Final browser state reports `v2.13.4+102853d` with the healthy Sensor chain open.

The narrow dark-mode audit measured a 640px viewport and 640px document width. The graph wrapper was 516px wide with 691px scroll content contained by `overflow:auto`.

## Visual evidence

- Healthy: `docs/screenshots/phase2-argocd-2.13.4-healthy-chain-{light,dark}.png`
- Source failure: `docs/screenshots/phase2-argocd-2.13.4-source-failure-{light,dark}.png`
- Trigger/no-Workflow: `docs/screenshots/phase2-argocd-2.13.4-trigger-no-workflow-{light,dark}.png`
- Unknown/no-Workflow: `docs/screenshots/phase2-argocd-2.13.4-unknown-no-workflow-{light,dark}.png`
- Fan-in: `docs/screenshots/phase2-argocd-2.13.4-fan-in-{light,dark}.png`
- Fan-out: `docs/screenshots/phase2-argocd-2.13.4-fan-out-{light,dark}.png`
- EventSource and EventBus summaries: `docs/screenshots/phase2-argocd-2.13.4-{eventsource-chain,eventbus}-light.png`
- Narrow drawer: `docs/screenshots/phase2-argocd-2.13.4-healthy-narrow-dark.png`
- Upper compatibility target: `docs/screenshots/phase2-argocd-3.4.6-healthy-chain-dark.png`

## Authorization, security, and limits

- Browser traffic remains same-origin and Application-scoped; there is no namespace list, direct Kubernetes/Argo Events call, proxy, or new mutation authority.
- Correlation requires exact group/kind/namespace/name plus direct dependency, trigger target, owner reference, or controller tracking metadata. Similar names and missing namespaces do not form edges.
- Operational telemetry accepts only version, feature/state names, durations, and numeric counts. Resource names, namespaces, URLs, messages, payloads, headers, and parameters are not fields in the telemetry contract.
- Event delivery/filter and trigger execution logs are not available through the authorized browser API. Their absence remains unknown rather than inferred failure or health.
- The Application is intentionally Degraded because the source-unavailable fixture is desired failure evidence; extension code does not mutate Application health.

## Rollback and final state

- `npm run uninstall:local` disabled all enabled Workflow bundles and rolled out the Colima server.
- Restoring only `extension-workflows-0.3.0.js` reproduced the prior Workflow extension on Argo CD 2.13.4 and removed Event tab registration.
- `npm run install:local` then restored only `extension-workflows-0.4.0.js`.
- Final state: Argo CD 2.13.4 Ready 1/1, fixture revision `6d148a9`, one enabled 0.4.0 bundle with matching digest.

## Release result

Phase 2 is complete for Argo CD `>=2.13.4, <3.5`, with exact interactive verification at 2.13.4 and 3.4.6 and the Argo Events 1.9.11 / Argo Workflows 3.7.4 fixture.
