import { MAX_SEMANTIC_OPERATIONS, type ValidationIssue } from './semantic-plan';
import { semanticDependencyState, validateSemanticPlan } from './semantic-validator';
import { ToolRegistry, type DispatchResult, type ReadExecutionContext } from './read-tools';

export interface ReadPlanResult {
  status: 'succeeded' | 'partial' | 'denied' | 'rejected' | 'failed';
  results: DispatchResult[];
  issues?: ValidationIssue[];
  reason?: string;
}
/** Offline only. No write handler or fallback route exists here. */
export class ReadPlanExecutor {
  constructor(private readonly registry: ToolRegistry) {}
  async execute(raw: unknown, context: ReadExecutionContext): Promise<ReadPlanResult> {
    try { context = structuredClone(context); }
    catch { return { status: 'rejected', results: [], reason: 'invalid_context' }; }
    const validation = validateSemanticPlan(raw, context);
    if (!validation.ok) return { status: validation.status === 'denied' ? 'denied' : 'rejected', results: [], issues: validation.issues };
    if (validation.plan.operations.some(op => op.action !== 'read' && op.action !== 'reply')) {
      return { status: 'rejected', results: [], reason: 'write_action_not_supported' };
    }
    const remaining = [...validation.plan.operations], results: DispatchResult[] = [];
    let bytes = 0;
    for (let step = 0; remaining.length && step < MAX_SEMANTIC_OPERATIONS; step++) {
      const index = remaining.findIndex(op => op.dependsOn.every(id => results.some(r => r.operationId === id)));
      if (index < 0) return { status: 'rejected', results, reason: 'unresolved_dependency' };
      const op = remaining.splice(index, 1)[0]!;
      const tool = op.action === 'read' ? op.tool : undefined;
      if (op.action !== 'read' || semanticDependencyState(op, results) !== 'ready') {
        results.push({ tool: tool?.name ?? 'none', version: 1, operationId: op.id, status: 'skipped', reason: 'dependency_or_non_read' }); continue;
      }
      if (!tool) { results.push({ tool: 'none', version: 1, operationId: op.id, status: 'rejected', reason: 'explicit_read_tool_required' }); continue; }
      const result = await this.registry.dispatch(tool.name, tool.input, context, op, tool.version);
      const size = new TextEncoder().encode(JSON.stringify(result)).byteLength;
      // Reserve bounded metadata space for the remaining operations' failure results.
      if (bytes + size > 59392) results.push({ tool: tool.name, version: 1, operationId: op.id, status: 'failed', reason: 'plan_output_limit' });
      else { results.push(result); bytes += size; }
    }
    const succeeded = results.filter(r => r.status === 'succeeded').length;
    return { status: succeeded === results.length ? 'succeeded' : succeeded ? 'partial'
      : results.some(r => r.status === 'denied') ? 'denied' : results.some(r => r.status === 'rejected') ? 'rejected' : 'failed', results };
  }
}
