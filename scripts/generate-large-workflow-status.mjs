#!/usr/bin/env node

const count = Number(process.argv.find(argument => /^\d+$/.test(argument)) || 1000);

if (!Number.isInteger(count) || count < 1000) throw new Error('node count must be an integer of at least 1000');

const phases = ['Pending', 'Running', 'Succeeded', 'Failed', 'Error', 'Skipped', 'Omitted', 'Unknown'];
const nodes = Object.fromEntries(Array.from({length: count}, (_, index) => {
  const id = `fixture-${index}`;
  const retry = index % 100 === 0;
  return [id, {
    id,
    name: `large-fixture.${id}`,
    displayName: `fixture step ${index}`,
    type: retry ? 'Retry' : 'Pod',
    phase: phases[index % phases.length],
    message: index % 8 === 3 ? `fixture failure ${index}` : undefined,
    boundaryID: index ? 'fixture-0' : undefined,
    children: retry && index + 1 < count ? [`fixture-${index + 1}`] : undefined,
    outboundNodes: !retry && index + 1 < count ? [`fixture-${index + 1}`] : undefined
  }];
}));
const patch = {
  metadata: {labels: {'workflows.argoproj.io/completed': 'true', 'workflows.argoproj.io/phase': 'Succeeded'}},
  status: {
    phase: 'Succeeded',
    progress: `${count}/${count}`,
    startedAt: '2026-08-20T00:00:00Z',
    finishedAt: '2026-08-20T00:01:00Z',
    nodes
  }
};

if (process.argv.includes('--check')) {
  if (Object.keys(nodes).length !== count || nodes['fixture-0'].type !== 'Retry' || nodes[`fixture-${count - 1}`].id !== `fixture-${count - 1}`) throw new Error('fixture generation failed');
  console.log(`generated ${count} deterministic workflow nodes (${Buffer.byteLength(JSON.stringify(patch))} bytes)`);
} else {
  process.stdout.write(`${JSON.stringify(patch)}\n`);
}
