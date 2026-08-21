import type {WorkflowNode} from './workflow-nodes';

export const WORKFLOW_NODE_PAGE_SIZE = 20;

export function workflowNodePage(nodes: WorkflowNode[], page: number, pageSize = WORKFLOW_NODE_PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(nodes.length / pageSize));
  const current = Math.min(Math.max(0, page), pages - 1);
  return {current, pages, nodes: nodes.slice(current * pageSize, (current + 1) * pageSize)};
}
