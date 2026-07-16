import { describe, expect, it } from 'vitest';
import { validateUiThemeProfile } from './UiThemeService.js';
import { BUILTIN_UI_THEMES } from '../../shared/uiThemes.js';

const custom = () => ({ ...structuredClone(BUILTIN_UI_THEMES[1]), id: 'my-light', name: 'My Light' });
describe('UI theme profile validation', () => {
  it('accepts built-in selection and compatible custom themes', () => { expect(validateUiThemeProfile({ activeThemeId: 'my-light', customThemes: [custom()] })).toMatchObject({ activeThemeId: 'my-light' }); });
  it('rejects missing active, duplicate, and incompatible themes', () => {
    expect(() => validateUiThemeProfile({ activeThemeId: 'missing', customThemes: [] })).toThrow(/does not exist/);
    expect(() => validateUiThemeProfile({ activeThemeId: 'dark', customThemes: [{ ...custom(), id: 'dark' }] })).toThrow(/Duplicate/);
    expect(() => validateUiThemeProfile({ activeThemeId: 'dark', customThemes: [{ ...custom(), text: 'cool-light' }] })).toThrow(/not compatible/);
  });
  it('rejects out-of-range effects', () => { expect(() => validateUiThemeProfile({ activeThemeId: 'my-light', customThemes: [{ ...custom(), effects: { ...custom().effects, blur: 29 } }] })).toThrow(/blur/); });
});
