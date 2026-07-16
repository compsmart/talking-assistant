import { describe, expect, it } from 'vitest';
import { PLANNING_SEGMENT_LIMIT, PLANNING_SYSTEM, PLANNING_TOOL_NAMES } from './PlanningAgent.js';

describe('planning agent boundaries', () => {
  it('exposes discovery tools without workspace mutation capabilities', () => {
    expect(PLANNING_TOOL_NAMES).toEqual(expect.arrayContaining(['list_files', 'search_files', 'locate_code', 'read_files']));
    expect(PLANNING_TOOL_NAMES).toContain('run_node_script');
    expect(PLANNING_TOOL_NAMES).not.toEqual(expect.arrayContaining(['apply_edits', 'run_command', 'install_dependencies', 'copy_reference_file', 'generate_image']));
  });

  it('requires decision-complete Markdown and delegates persistence to the server', () => {
    expect(PLANNING_SYSTEM).toContain('read-only software architect');
    expect(PLANNING_SYSTEM).toContain('server will persist your final Markdown');
    expect(PLANNING_SYSTEM).toContain('numbered implementation steps');
  });

  it('allows eighty interactions before requesting continuation', () => {
    expect(PLANNING_SEGMENT_LIMIT).toBe(80);
  });
});
