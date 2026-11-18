import type { DraftOperation, DraftTarget, ModelPlanDraftV1 } from '../../src/semantic-draft';
import type { SemanticPlanV1, SemanticTarget } from '../../src/semantic-plan';
/** Mechanical test-only encoding of HUMAN gold. Never used as a planner or as live predictions. */
export function mockDraftFromGold(plan: SemanticPlanV1): ModelPlanDraftV1 {
  const target = (t: SemanticTarget): DraftTarget => ({ type: t.type, text: t.type === 'description' ? t.text : null,
    evidence: t.type === 'description' ? t.evidence : null, sourceId: t.type === 'reply' ? t.sourceId : null,
    listId: t.type === 'previous_list' ? t.listId : null, position: t.type === 'description' ? null : t.position });
  return { version: 1, operations: plan.operations.map(op => {
    const d: DraftOperation = { id: op.id, action: op.action, speechAct: op.speechAct, evidence: op.evidence, dependsOn: op.dependsOn,
      tool: null, arguments: null, target: null, targets: null, fields: null, reply: null };
    if (op.action === 'reply') d.reply = { subject: op.subject, text: op.text };
    if (op.action === 'read' && op.tool) {
      d.tool = op.tool.name; d.arguments = { period: null, course: null, group: null, reference: null, name: null, limit: null, archive: null };
      for (const [key, v] of Object.entries(op.tool.input)) if (key !== 'query') Object.assign(d.arguments, { [key]: v });
    }
    if ('target' in op) d.target = target(op.target);
    if (op.action === 'publish') d.targets = op.targets.map(target);
    if (op.action === 'create' || op.action === 'update') d.fields = Object.entries(op.action === 'create' ? op.data : op.patch).map(([name, item]) => {
      const clear = 'mode' in item && item.mode === 'clear', value = 'value' in item ? item.value : null;
      return { name: name as NonNullable<DraftOperation['fields']>[number]['name'], mode: clear ? 'clear' : 'set', evidence: item.evidence,
        value: clear ? null : typeof value === 'object' && value !== null ? value.text : String(value),
        dateKind: typeof value === 'object' && value !== null ? value.kind : null };
    });
    return d;
  }) };
}
