export interface ArgoResourceIdentity {
  group?: string;
  kind: string;
  namespace?: string;
  name: string;
}

/** Uses Argo CD's stable resource-node deep-link shape; no host router API is exposed to extensions. */
export function argoResourceHref(resource: ArgoResourceIdentity, tab?: string, pathname?: string): string {
  const path = pathname || (typeof window === 'undefined' ? '' : window.location.pathname);
  const node = [resource.group || '', resource.kind, resource.namespace || '', resource.name, '0'].join('/');
  const query = new URLSearchParams({view: 'Tree', resource: '', node});
  if (tab) query.set('tab', tab);
  return `${path}?${query.toString()}`;
}
