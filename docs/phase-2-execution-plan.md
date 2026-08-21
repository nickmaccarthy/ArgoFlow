# Phase 2 execution plan — Argo Events

## Goal

Ship a read-only Argo Events experience inside the existing extension. On the local `colima` lab, an operator can open an `EventSource`, `Sensor`, or `EventBus`, understand configuration and current conditions, follow a verified EventSource event → Sensor dependency → trigger → Workflow chain, identify the first blocked hop, and navigate to the existing Workflow and Pod experiences.

Phase 2 is one goal with internal checkpoints. Agents continue through the work graph without waiting for ticket-by-ticket approval unless a stop condition is hit.

## Fixed decisions

- Compatibility remains Argo CD `>=2.13.4, <3.5`; interactive endpoints are 2.13.4 and 3.4.6. Host React stays externalized and React 16.9-compatible.
- Local Argo Events target is `v1.9.11` with `v1alpha1` EventSource, Sensor, and EventBus CRDs.
- Reuse Phase 1 UI, graph, status, link, loading/error, theme, and accessibility patterns. No second design system.
- Resource tabs are the primary entry points. Use selected-resource props plus the authorized Application tree and Argo CD same-origin resource API.
- Start without a proxy. Exact, bounded Application-scoped reads are enough for the first slice. A proxy requires a separate authorization contract.
- Correlation is verified or unresolved. Namespace/name similarity never creates a confident edge. Inferred edges are optional, labeled, and excluded from blocked-hop conclusions.
- Read-only. No event submission button, Sensor/EventSource mutation, Workflow retry, logs proxy, secret display, or EventBus administration.
- All cluster commands name `--context colima`. Existing browser tab is reused. No alternate kube context is touched.

## Mandatory Kubernetes safety gate

Phase 2 may access only kube context `colima`. Production and every other context are out of scope.

Before the first Kubernetes read or mutation in each agent run, verify the target:

```bash
kubectl --context colima config view --minify \
  -o jsonpath='{.clusters[0].name}{" "}{.clusters[0].cluster.server}{"\n"}'
```

Expected: `colima https://127.0.0.1:6443`. A different name/server or missing context is a hard stop.

- Every Kubernetes command must start with `kubectl --context colima`.
- Every Helmfile command must include `helmfile --kube-context colima`.
- Never rely on the current context, a shell default, an inherited context, or `kubectl config current-context`.
- Never retry against another context. Never inspect, apply, patch, annotate, delete, port-forward, log, or watch resources through another context.
- Before any destructive/recreate step, resolve and print the exact Colima namespace and resource names first.
- Root reviews command text for explicit `colima` before executing cluster mutations. Subagents return commands; root owns mutation unless assigned an exact Colima-only command surface.

## Model orchestration contract

- **Sol:** root orchestrator. Owns architecture, task boundaries, conflict resolution, integration, cluster-mutation review, final code review, final compatibility/browser verification, and completion decision.
- **Terra:** primary implementation workers. Own bounded code or fixture surfaces, focused diagnosis, and substantial intermediate reviews.
- **Luna:** fast workers. Own repository scans, schema extraction, deterministic tests, browser checks, log reduction, documentation mechanics, and focused reviews.
- Terra/Luna output is evidence, not final approval. Sol reopens important files, reviews integrated diffs, reruns decisive checks, and personally verifies final live behavior before marking the goal complete.
- Prefer the cheapest capable worker for each task. Escalate worker reasoning/model only when a bounded task fails twice or requires architectural judgment.

## Phase 1 lessons applied

1. **Vertical slice first.** Build a real webhook → Sensor → Workflow fixture before polishing isolated screens. It exposes schema, RBAC, owner/label metadata, pod creation, and correlation facts early.
2. **Host contract is settled.** Do not repeat Argo CD extension/API research already captured in ADRs 0001–0003.
3. **Existing UI is the baseline.** Copy interaction patterns and scoped CSS from Workflow views; evaluate Phase 2 against live Argo CD, not standalone component aesthetics.
4. **Truth before graph.** Normalizers and evidence-based edges land before chain rendering. Unknown remains visible instead of being styled as healthy.
5. **Bounded reads only.** Fetch exact related manifests, cap concurrency at six, abort superseded requests, and never list a namespace from the browser.
6. **Real fixtures beat elaborate mock ceremony.** Keep deterministic unit fixtures, but acceptance requires live EventSource/Sensor pods and a triggered Workflow in the Application tree.
7. **Short verification loop.** Focused tests → `npm run check` → `npm run install:local` → Colima state/logs → existing in-app browser → compatibility endpoints once at release gate.
8. **One owner per file surface.** Parallel workers edit disjoint modules and do not revert concurrent changes. After a ticket hands back, root owns integration fixes; another worker touches that surface only through a new explicit assignment.
9. **No approval ceremony for reversible local work.** Continue through safe code, fixture, install, and read-only verification steps. Stop only for authorization expansion, non-Colima access, destructive unrelated state, or a product choice that changes scope.

## Work graph

| Wave | Ticket | Worker | Owner surface | Depends on | Completion signal |
|---|---|---|---|---|---|
| 1 | [01 live event chain fixture](../.scratch/argo-cd-events-phase-2/issues/01-live-event-chain-fixture.md) | Terra build; Luna evidence review | local GitOps Event resources only | — | Real event creates a Workflow and visible pods on Colima. |
| 1 | [02 event models and correlation](../.scratch/argo-cd-events-phase-2/issues/02-event-models-and-correlation.md) | Terra build; Luna test review | new pure model modules/tests | — | Healthy/failure/fan-in/fan-out/unknown fixtures normalize deterministically. |
| 2 | [03 Event resource tabs](../.scratch/argo-cd-events-phase-2/issues/03-event-resource-tabs.md) | Terra build; Luna UI review | registrations, resource views, scoped styles | 02 | EventSource, Sensor, and EventBus render useful Argo-native summaries and links. |
| 2 | [04 chain and blocked-hop diagnosis](../.scratch/argo-cd-events-phase-2/issues/04-chain-and-blocked-hop.md) | Terra build; Luna correlation review | chain view and exact related-resource loader | 01, 02 | Verified chain links to triggered Workflow; first blocked hop is truthful. |
| 3 | [05 resilience, scale, and security](../.scratch/argo-cd-events-phase-2/issues/05-resilience-scale-security.md) | Luna adversarial review; Terra fixes | hardening and adversarial fixtures | 03, 04 | Partial/RBAC/stale/fan-out states remain bounded and readable. |
| 4 | [06 compatibility and release gate](../.scratch/argo-cd-events-phase-2/issues/06-compatibility-release-gate.md) | Luna evidence collection; Sol final verification | evidence/docs/install/browser | 01–05 | Sol verifies full checks and live browser matrix; rollback documented. |

Wave 1 runs in parallel. After model contracts stabilize, Wave 2 may run in parallel with strict file ownership. Root agent integrates, reviews diffs, and runs final live verification.

Before Wave 2, root compares the live labels/annotations/owner references returned by 01 with 02’s evidence rules, adds any observed contract to focused tests, and records unsupported relationships as unresolved.

## Goal execution prompt

> Complete Phase 2 using the tickets in `.scratch/argo-cd-events-phase-2/issues/` and this plan as the execution contract. Run Sol as the root orchestrator and final verifier. Use Terra and Luna for implementation tasks, fixtures, scans, tests, browser passes, log reduction, and intermediate reviews; choose the cheapest capable worker. Sol owns architecture, task boundaries, integration, conflict resolution, cluster-mutation review, final code review, final compatibility/browser verification, and the completion decision. Continue without ticket-by-ticket user confirmation. Kubernetes access is allowed only after the mandatory safety preflight returns exactly `colima https://127.0.0.1:6443`; every kubectl command must use `kubectl --context colima`, every Helmfile command must use `helmfile --kube-context colima`, and no fallback context is permitted. Preserve Argo CD `>=2.13.4,<3.5`, React 16.9 compatibility, read-only product behavior, and Application scoping. Reuse the current UI and browser tab. Phase 2 is complete only after Sol verifies a real event triggers a Workflow, all three Event resource tabs and the chain render live, blocked/unknown cases are truthful, `npm run check` passes, and browser evidence exists at both supported Argo CD endpoints.

## Stop conditions

- Required data is unavailable through selected-resource/Application-scoped Argo CD APIs and would require new server authority.
- A relationship cannot be supported by direct references or observed controller metadata.
- Work would touch a kube context other than `colima`.
- A fixture requires credentials, privileged workloads, external production services, or destructive unrelated changes.
- The same environment failure persists after two root-reviewed fixes and one clean retry. Root records commands, outputs, and remaining blocker, then asks the user only when new authority or a scope-changing choice is required.

## Final evidence

- Argo Events and Argo CD versions, exact fixture commit, extension bundle hash, and one enabled bundle.
- Unit tests for every normalization, correlation, and blocked-hop state.
- Live EventSource, Sensor, EventBus, triggered Workflow, and child Pod state from Colima.
- Existing in-app browser screenshots for healthy, source-failure, trigger/no-Workflow, fan-in/fan-out, and unknown/permission states in light and dark themes.
- `npm run check`, install, rollback, and compatibility results.
