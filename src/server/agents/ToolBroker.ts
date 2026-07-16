import type { AgentStage, AgentToolDescriptor } from '../../shared/protocol.js';
import { ToolCatalog } from './ToolCatalog.js';

export interface ModelToolDefinition { type: 'function'; name: string; description: string; parameters: Record<string, any> }
export interface ToolBrokerContext {
  stage: AgentStage;
  grantedToolIds?: readonly string[];
  workspaceToolIds?: readonly string[];
  unavailableToolIds?: readonly string[];
}

/** Compiles registry grants into model functions and enforces the same mapping at invocation time. */
export class ToolBroker {
  private readonly runtime = new Map<string, ModelToolDefinition>();

  constructor(private readonly catalog: ToolCatalog, definitions: readonly ModelToolDefinition[]) {
    for (const definition of definitions) this.runtime.set(definition.name, structuredClone(definition));
  }

  descriptors(context: ToolBrokerContext): AgentToolDescriptor[] {
    if (context.grantedToolIds === undefined) return this.catalog.list().filter((tool) => tool.available && tool.stages.includes(context.stage));
    return this.catalog.effective({ stage: context.stage, profileToolIds: context.grantedToolIds, workspaceToolIds: context.workspaceToolIds, unavailableToolIds: context.unavailableToolIds });
  }

  compile(context: ToolBrokerContext): ModelToolDefinition[] {
    const compiled = new Map<string, ModelToolDefinition>();
    for (const descriptor of this.descriptors(context)) {
      const runtimeId = descriptor.runtimeToolId || descriptor.id;
      const source = this.runtime.get(runtimeId);
      if (!source) continue;
      const existing = compiled.get(runtimeId);
      const definition = existing || structuredClone(source);
      if (descriptor.inputSchema) definition.parameters = {
        ...definition.parameters,
        ...structuredClone(descriptor.inputSchema),
        properties: { ...(definition.parameters?.properties || {}), ...((structuredClone(descriptor.inputSchema).properties as Record<string, unknown>) || {}) },
      };
      const fixed = descriptor.fixedArguments || {};
      for (const [key, value] of Object.entries(fixed)) {
        const property = definition.parameters?.properties?.[key];
        if (property) property.enum = existing ? [...new Set([...(property.enum || []), value])] : [value];
      }
      compiled.set(runtimeId, definition);
    }
    return [...compiled.values()];
  }

  authorize(context: ToolBrokerContext, runtimeToolId: string, args: Record<string, unknown> = {}) {
    if (context.grantedToolIds === undefined) return;
    const candidates = this.descriptors(context).filter((tool) => (tool.runtimeToolId || tool.id) === runtimeToolId);
    const granted = candidates.find((tool) => Object.entries(tool.fixedArguments || {}).every(([key, value]) => args[key] === value));
    if (!granted) throw new Error(`Tool ${runtimeToolId} is not enabled for this agent or these arguments.`);
  }
}
