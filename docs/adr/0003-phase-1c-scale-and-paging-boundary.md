# ADR 0003 — Phase 1C scale and paging boundary

## Decision

- Render Workflow node lists with fixed-row native windowing. The DOM contains only the visible rows plus five rows of overscan on each side.
- Render DAGs only through 250 nodes and paint them in 50-node animation-frame chunks. Larger Workflows open list-first and do not construct an SVG DAG.
- Keep live Application runs browser-paged from the host-supplied shallow Application tree: sort shallow identities, select 25, then use at most six concurrent same-origin Argo CD `GetResource` calls.
- Emit anonymous browser `CustomEvent` telemetry for extension load, Workflow readiness, run-page latency/state/size, feature availability, and render failure. The typed event contract cannot accept resource names, URLs, messages, parameters, or artifacts.
- Do not ship a server-side Workflow list proxy until every candidate Workflow carries a mandatory, label-selectable Application identity.

## Why live runs are not called server-side paged

Argo CD 2.13.4 and 3.4.6 Application views receive `{application, tree}`. The complete shallow tree is already in browser memory, and the supported Application resource API reads exactly one tree member. The extension bounds manifest reads and its rendered payload, but it cannot make the host tree itself sublinear.

A real proxy must derive Project, Application, destination, and selector from Argo CD-authenticated headers; require `applications,get` and `extensions,invoke`; and issue a Kubernetes Workflow list with `limit=25` plus an opaque continuation token. Namespace-only selection is forbidden. Existing annotation-based tracking is not label-selectable, and Kubernetes continuation order is not globally newest-first. Shipping a proxy without the association-label contract would weaken authorization or mislabel results.

## Upgrade trigger

Add the proxy when deployment policy guarantees a label such as `workflow-extension.argocd.io/application-uid=<uid>` on every run and the product accepts Kubernetes page order, or supplies an authorized indexed archive for newest-first history. Until then, Archive remains capability-unavailable and the UI states that filters apply only to the current browser page.

## Compatibility

The implementation uses React 16.9-era hooks and browser APIs and keeps React externalized. It does not depend on Argo CD's optional four-argument Application-view registration added after 2.13.
