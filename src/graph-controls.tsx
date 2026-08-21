import React from 'react';

type GraphAction = 'zoom-in' | 'zoom-out' | 'fit';

const LABELS: Record<GraphAction, string> = {'zoom-in': 'Zoom in', 'zoom-out': 'Zoom out', fit: 'Fit graph to view'};

function GraphIcon({action}: {action: GraphAction}) {
  if (action === 'fit') return <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" /></svg>;
  return <svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3M4.5 7h5" />{action === 'zoom-in' ? <path d="M7 4.5v5" /> : null}</svg>;
}

export function GraphIconButton({action, onClick}: {action: GraphAction; onClick(): void}) {
  const label = LABELS[action];
  return <button className="wf-icon-button" type="button" aria-label={label} title={label} onClick={onClick}><GraphIcon action={action} /></button>;
}
