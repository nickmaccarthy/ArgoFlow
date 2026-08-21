# ADR 0001: Phase 1A host contract

## Decision

- Support Argo CD `>=2.13.4, <3.5`; smoke-test exact lower bound and selected latest 3.4 patch.
- Register only `argoproj.io/Workflow` through `window.extensionsAPI.registerResourceExtension`.
- Consume selected resource props only. No proxy or Kubernetes credentials in browser.
- Externalize React to host global and mount one `extension-*.js` bundle under `/tmp/extensions`.
- Use native SVG for the Phase 1A DAG. Add a graph dependency only if measured layout or scale requirements exceed it.

## Deferred

WorkflowTemplate, CronWorkflow, Application runs, archive, proxy, logs, artifacts, mutations, and Events.
