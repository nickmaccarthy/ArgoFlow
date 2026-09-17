export interface ArgoResourceIdentity {
  group?: string;
  kind: string;
  namespace?: string;
  name: string;
}

/** Uses Argo CD's stable resource-node deep-link shape; no host router API is exposed to extensions.
 *  AppsDetailsViewKey.Tree is the lowercase 'tree' — any other value drops Argo CD's
 *  application page into its resource-list fallback branch. */
export function argoResourceHref(resource: ArgoResourceIdentity, tab?: string, pathname?: string): string {
  const path = pathname || (typeof window === 'undefined' ? '' : window.location.pathname);
  const node = [resource.group || '', resource.kind, resource.namespace || '', resource.name, '0'].join('/');
  const query = new URLSearchParams({view: 'tree', resource: '', node});
  if (tab) query.set('tab', tab);
  return `${path}?${query.toString()}`;
}
