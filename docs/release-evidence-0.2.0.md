# Phase 1 release evidence — 0.2.0

Recorded 2026-08-20 on arm64, Node.js 26.5.0, npm 11.17.0, local k3s v1.35.0+k3s1, and Argo Workflows v3.7.4.

## Bundle and automated gates

- Artifact: `dist/extension-workflows.js` (47,968 bytes)
- SHA-256: `fbae0291a40afbfa639b4f7741560b2674bd532c27dcb9bbee4ca4396c565d8b`
- Installed artifact has the same SHA-256.
- `npm run check`: 40/40 tests passed; TypeScript, production bundle, license, large-node, and large-history gates passed.
- Bundle inspection: React remains externalized; resource and Application registration guards passed.
- Dependency licenses: 133 locked packages passed the allowlist.
- `npm audit --audit-level=low`: 0 vulnerabilities.
- 1,000-node fixture: deterministic 194,469-byte status; list remains capped at 100 rows and DAG rendering is disabled above 200 nodes.
- 5,000-run history fixture: 753,901-byte host-supplied shallow tree; initial extension page fetched 25 manifests with at most six concurrent requests and serialized to 16,759 bytes in 57.6 ms.

## Scope delivered

- Read-only Workflow, WorkflowTemplate, and CronWorkflow resource experiences.
- WorkflowTemplate and CronWorkflow tabs reuse the same 25-row, six-request-concurrency Application source; template origin requires a direct same-namespace `workflowTemplateRef`, while Cron children require `status.active`, a direct owner reference, or Argo's Cron controller metadata. Namespace alone is never accepted.
- Application `Workflows` view registered through the portable three-argument host contract.
- Stable 25-row live pages, current-page filters, previous/next cursors, live/archive source text, and loading/empty/partial/error/stale/permission/archive-unavailable states.
- Verified/inferred/unresolved correlation; unresolved records are excluded by default and namespace alone is insufficient.
- Archive capability is absent in the local lab and degrades explicitly; the browser never contacts Argo Workflows Archive or Kubernetes directly.

## Authorization evidence

- Local fixtures: two AppProjects (`phase-1b-a`, `phase-1b-b`), each restricted to its matching namespace and Application.
- A ten-minute `phase-1b-a` project-role token received HTTP 200 for its own Application/Workflow and HTTP 403 for the `phase-1b-b` Application.
- Requesting the `phase-1b-b` namespace/name through the allowed `phase-1b-a` Application received HTTP 400 from Argo CD's tree-membership check.
- The test token record, token file, and temporary admin CLI configuration were removed immediately after the test.
- Every cluster command used an explicit `colima` context.

## Compatibility and browser evidence

| Argo CD | Evidence | Result |
|---|---|---|
| 2.13.4 | Server Ready 1/1. Codex browser loaded three authorized live rows, filters, paging controls, and archive-unavailable state. WorkflowTemplate showed a direct template-origin run; CronWorkflow showed the controller-labeled child; Workflow detail rendered summary and workspace. Filtering exposed and verified the React 16 pooled-event fix. Light/dark checks exposed and verified a scoped Application-view contrast fix. | Pass |
| 3.4.6 | Temporary server Ready 1/1; `/api/version` returned `v3.4.6`; asset registration markers were present. Codex browser verified the Application rows, filters, archive fallback, WorkflowTemplate relationship, Cron child relationship, and Workflow detail with no extension error boundary. | Pass |

After the upper-target server smoke test, the Colima server image was explicitly restored to `quay.io/argoproj/argocd:v2.13.4` and reached Ready 1/1.

## Visual evidence

- Application runs: `docs/screenshots/phase1b-argocd-2.13.4-application-runs-{light,dark}-1440x900.png`
- WorkflowTemplate: `docs/screenshots/phase1b-argocd-2.13.4-workflowtemplate-{light,dark}-1024x768.png`
- CronWorkflow: `docs/screenshots/phase1b-argocd-2.13.4-cronworkflow-{light,dark}-1024x768.png`
- Workflow run detail: `docs/screenshots/phase1b-argocd-2.13.4-workflow-run-{light,dark}-1440x900.png`
- Upper compatibility target: `docs/screenshots/phase1b-argocd-3.4.6-application-runs-dark-1440x900.png`

Argo CD's local notification stream intermittently reports a pre-existing TLS-handshake toast through the lab ingress. Extension queries and views continue loading; screenshots were captured after dismissing those unrelated notifications.

## Local fixtures and installation

- GitOps commit `577d896` added the WorkflowTemplate, suspended CronWorkflow, and template-origin Workflow fixtures to `workflows-extension-demo`.
- GitOps commits `7e6b729` and `7d88a6d` added and corrected the isolated two-Project authorization fixtures.
- GitOps commit `baa28e3` added the Cron controller label to the existing template-origin run so one fixture proves both direct template origin and a verified Cron child relationship.
- `npm run install:local` built and installed `extension-workflows-0.2.0.js` using only `helmfile --kube-context colima` and `kubectl --context colima`; `argocd-server` rolled out successfully.
- `npm run uninstall:local` left no enabled `.js` bundles and rolled the server successfully; a final install restored only the 0.2.0 bundle.

## Release result

Phase 1B gates passed. The local lab is restored to Argo CD 2.13.4 with `extension-workflows-0.2.0.js` enabled.
