# ADR 0002: Phase 1B Application view and live-run data

## Decision

- Register the Application view with the Argo CD 2.13-compatible three-argument contract: `registerAppViewExtension(component, title, icon)`.
- Accept that Argo CD 2.13 always shows the view icon. Render a useful internal empty state instead of depending on the optional Argo CD 3.4 visibility callback.
- Treat `{application, tree}` as the complete host prop contract. Do not import private Argo CD UI modules or assume a navigation/query client is injected.
- Build each live page from at most 25 `argoproj.io/Workflow` identities in `tree.nodes`, ordered stably newest first.
- Fetch only the selected page's manifests through Argo CD's same-origin Application `GetResource` API, with bounded concurrency. Argo CD enforces Application `get` RBAC and verifies that each requested resource belongs to the Application tree.
- Keep archive access capability-detected and unavailable by default. Archive records are not Kubernetes resources in the Application tree and require a separately authorized proxy before they may appear.
- Remain compatible with the React 16.9.3 host runtime used by both tested Argo CD endpoints.

## Consequences

- Live browsing needs no custom backend and never gives the browser Kubernetes credentials.
- The first page loads a bounded set of complete Workflow manifests even when the host tree contains thousands of shallow nodes.
- Argo CD 2.13 may show the Workflows icon for Applications without Workflow nodes; that view explains the empty state truthfully.
- Archived rows can share the page model and source label, but no browser-direct Argo Workflows Archive call is permitted.

## Authorization boundary

Each live request is constrained to one Application and one tree identity:

`GET /api/v1/applications/{application}/resource?appNamespace={application namespace}&project={project}&namespace={workflow namespace}&resourceName={workflow name}&version={version}&group=argoproj.io&kind=Workflow`

- The browser sends only the user's same-origin Argo CD session. It receives no Kubernetes or Argo Workflows credentials.
- Argo CD authorizes `applications,get` for the named Project/Application, then verifies the exact group, kind, namespace, name, and UID-bearing resource is in that Application's cached tree before reading it from the destination cluster.
- The extension selects identities only from the supplied Application tree, limits each page to 25 manifests, and caps parallel reads at six.
- A shared namespace is never correlation evidence by itself. Unresolved records are excluded by default and permission failures remain explicit.
- Archive records are outside this boundary. Any later archive proxy must independently constrain cluster, Project/Application, namespace, fields, and correlation before returning a record.

Colima evidence uses two isolated AppProjects (`phase-1b-a` and `phase-1b-b`) restricted to matching namespaces. A ten-minute `phase-1b-a` project-role token returned HTTP 200 for its own Workflow, HTTP 403 for the `phase-1b-b` Application, and HTTP 400 when the `phase-1b-b` namespace/name was requested through the `phase-1b-a` Application. The token and temporary admin CLI config were removed after the test.

## Compatibility evidence

- Argo CD 2.13.4 exposes the three-argument Application-view registration and supplies `{application, tree}`.
- Argo CD 3.4.6 retains that contract and adds an optional fourth visibility callback which this extension intentionally does not require.
- Both versions expose the Application `GetResource` endpoint and perform Application RBAC/tree-membership checks server-side.
