# Phase 1A release evidence — 0.1.0

Recorded 2026-08-20 on arm64, Node.js 26.5.0, npm 11.17.0, and local k3s v1.35.0+k3s1.

## Bundle and automated gates

- Artifact: `dist/extension-workflows.js` (18,003 bytes)
- SHA-256: `8e0017e4d7537be7d8a9928006c45d6c03575cf2275158f7001f1a1316c13d39`
- `npm run check`: 18/18 tests passed; TypeScript and production bundle passed.
- Bundle inspection: React externalized; registration and scoped-CSS guards passed.
- Dependency licenses: 133 locked packages passed the allowlist.
- `npm audit --audit-level=low`: 0 vulnerabilities.
- Deterministic 1,000-node normalization/filter measurement: 12.9 ms in the latest full check; the list is capped at 100 rows and DAG rendering is disabled above 200 nodes.
- Live fixture: `argo/phase-1-large-fixture` is tracked by `workflows-extension-demo`, Synced/Healthy, stable at 1,000 status nodes, and generated from a 194,469-byte deterministic merge patch.

## Local Argo CD compatibility

| Version | Evidence | Result |
|---|---|---|
| 2.13.4 | Server Ready; `/api/version` returned `v2.13.4+102853d`; `/extensions.js` served the installed 0.1.0 bundle. Earlier interactive resource-tab checks covered summary, DAG/list toggle, filtering, selection, details, and zoom. | Pass |
| 3.4.6 | Official server image reached Ready; `/api/version` returned `v3.4.6`; `/extensions.js` served the same bundle; Chrome displayed v3.4.6, rendered the Workflow extension, and exposed the DAG. | Pass |

The lab was restored to Argo CD 2.13.4 after the upper-bound smoke test and remained 1/1 Ready with the extension served.

## Install and rollback

- `npm run install:local` installed `extension-workflows-0.1.0.js`; its digest matched the built artifact.
- `npm run uninstall:local` renamed enabled bundles to `.disabled`, restarted `argocd-server`, and left it 1/1 Ready.
- After rollback, `/extensions.js` was empty and contained no Workflow registration.
- A final `npm run install:local` restored the versioned bundle; the final lab state is Argo CD 2.13.4 with the extension enabled.

## Browser performance and visual evidence

- 1,000-node reload to visible extension: 2,775 ms.
- Search to one matching row: 435 ms.
- Status filter to 125 matching rows: 257 ms.
- Page change: 603 ms.
- Node selection/details: 1,779 ms.
- DOM stayed bounded at 100 rows on the first page and 25 rows on the final filtered page.
- Screenshots: `docs/screenshots/phase-1a-resource-entry-light.jpg`, `phase-1a-resource-entry-dark.jpg`, `phase-1a-workflow-detail-light.jpg`, and `phase-1a-workflow-detail-dark.jpg`.
