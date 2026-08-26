import React from 'react';

const PREFIX = 'argoflow:';

export type HashState = Record<string, string>;

/** Reads only `argoflow:`-prefixed pairs; foreign keys stay untouched in the hash. */
export function parseHashState(hash: string): HashState {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const state: HashState = {};
  for (const part of raw.split('&')) {
    if (!part.startsWith(PREFIX)) continue;
    const body = part.slice(PREFIX.length);
    const equals = body.indexOf('=');
    if (equals <= 0) continue;
    try {
      state[body.slice(0, equals)] = decodeURIComponent(body.slice(equals + 1));
    } catch {
      // Malformed escape sequences are treated as absent rather than breaking the view.
    }
  }
  return state;
}

/** Merges a patch into namespaced state; undefined or empty values delete their key. */
export function mergeHashState(current: HashState, patch: Record<string, string | undefined>): HashState {
  const merged: HashState = {...current};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === '') delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

function encodePair(key: string, value: string): string {
  return `${PREFIX}${key}=${encodeURIComponent(value)}`;
}

function foreignPairs(hash: string): string[] {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  return raw.split('&').filter(part => part && !part.startsWith(PREFIX));
}

/**
 * Serializes namespaced state while preserving every foreign pair of `hash`
 * verbatim. Namespaced keys sort deterministically so identical state always
 * yields an identical hash.
 */
export function serializeHashState(hash: string, state: HashState): string {
  const owned = Object.keys(state).sort().map(key => encodePair(key, state[key]));
  return [...foreignPairs(hash), ...owned].join('&');
}

/**
 * Deep-linkable UI state without touching the Argo CD router: values live under
 * namespaced keys of location.hash, restored on mount and on back/forward, written
 * with replaceState so browser history stays clean.
 */
export function useHashState(): [HashState, (patch: Record<string, string | undefined>) => void] {
  const [state, setState] = React.useState<HashState>(() => parseHashState(typeof window === 'undefined' ? '' : window.location.hash));

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const onHashChange = () => {
      // Every hashchange is a navigation the hook did not perform (its own
      // replaceState never fires the event), so the state is re-read even when
      // the URL matches a hash written earlier: back/forward can return here.
      // Canonical-JSON equality skips no-op events without going stale.
      const next = parseHashState(window.location.hash);
      setState(previous => (JSON.stringify(next) === JSON.stringify(previous) ? previous : next));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const patch = React.useCallback((update: Record<string, string | undefined>) => {
    setState(previous => mergeHashState(previous, update));
    if (typeof window === 'undefined') return;
    const nextHash = serializeHashState(window.location.hash, mergeHashState(parseHashState(window.location.hash), update));
    const nextUrl = `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ''}`;
    if (nextUrl !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(null, '', nextUrl);
    }
  }, []);

  return [state, patch];
}
