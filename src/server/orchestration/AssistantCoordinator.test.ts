import { describe, expect, it } from 'vitest';
import { isStandaloneMediaObjective } from './AssistantCoordinator.js';

describe('Assistant media routing', () => {
  it('routes standalone media creation and processing to Media', () => {
    expect(isStandaloneMediaObjective('Generate five new fantasy slot symbols')).toBe(true);
    expect(isStandaloneMediaObjective('Extract the symbols from this sprite sheet')).toBe(true);
    expect(isStandaloneMediaObjective('Remove the background from the selected image')).toBe(true);
    expect(isStandaloneMediaObjective('Create a four second character animation')).toBe(true);
  });

  it('keeps explicit application integration with Coder', () => {
    expect(isStandaloneMediaObjective('Generate five slot symbols and add them to the game reels')).toBe(false);
    expect(isStandaloneMediaObjective('Create an image gallery component for the homepage')).toBe(false);
    expect(isStandaloneMediaObjective('Extract these sprites and map them into the game code')).toBe(false);
  });
});
