import { useMemo, useState } from 'react';
import type { UiAccentId, UiDensity, UiScale, UiSurfaceId, UiTextId, UiTheme, UiThemeProfile, UiThemeProfileResponse } from '../../shared/protocol';
import { BUILTIN_UI_THEMES, UI_ACCENTS, UI_SURFACES, accentFor, compatibleTexts, surfaceFor } from '../../shared/uiThemes';
import { FloatingWindow } from './FloatingWindow';

interface Props {
  profile: UiThemeProfileResponse;
  onPreview: (theme: UiTheme) => void;
  onSave: (profile: UiThemeProfile) => Promise<void>;
  onCancel: () => void;
  onClose: () => void;
  onError: (message: string) => void;
}

export function UiThemePanel({ profile, onPreview, onSave, onCancel, onClose, onError }: Props) {
  const [draft, setDraft] = useState<UiThemeProfile>(() => ({ activeThemeId: profile.activeThemeId, customThemes: structuredClone(profile.customThemes) }));
  const [saving, setSaving] = useState(false);
  const themes = useMemo(() => [...BUILTIN_UI_THEMES, ...draft.customThemes], [draft.customThemes]);
  const selected = themes.find((theme) => theme.id === draft.activeThemeId) || themes[0]; const custom = draft.customThemes.some((theme) => theme.id === selected.id);

  const select = (id: string) => { const theme = themes.find((item) => item.id === id); if (!theme) return; setDraft((value) => ({ ...value, activeThemeId: id })); onPreview(theme); };
  const update = (change: Partial<UiTheme>) => {
    if (!custom) return; const next = { ...selected, ...change } as UiTheme;
    setDraft((value) => ({ ...value, customThemes: value.customThemes.map((theme) => theme.id === selected.id ? next : theme) })); onPreview(next);
  };
  const duplicate = () => {
    const copy: UiTheme = { ...structuredClone(selected), id: `custom-${crypto.randomUUID().toLowerCase()}`, name: uniqueName(`${selected.name} copy`, themes) };
    setDraft((value) => ({ activeThemeId: copy.id, customThemes: [...value.customThemes, copy] })); onPreview(copy);
  };
  const remove = () => {
    if (!custom || !window.confirm(`Delete the custom theme “${selected.name}”?`)) return;
    const next = { activeThemeId: 'dark', customThemes: draft.customThemes.filter((theme) => theme.id !== selected.id) }; setDraft(next); onPreview(BUILTIN_UI_THEMES[0]);
  };
  const changeSurface = (surface: UiSurfaceId) => { const choices = compatibleTexts(surface); update({ surface, text: choices.some((item) => item.id === selected.text) ? selected.text : choices[0].id }); };
  const cancel = () => { onCancel(); onClose(); };
  const save = async () => { setSaving(true); try { await onSave(draft); onClose(); } catch (error) { onError((error as Error).message); } finally { setSaving(false); } };

  return <FloatingWindow id="ui-themes" title="UI Themes" initial={{ x: 430, y: 44, width: 700, height: 680 }} minWidth={560} minHeight={480} className="ui-theme-window" onClose={cancel}>
    <div className="ui-theme-page">
      <aside className="theme-list"><header><strong>Themes</strong><button onClick={duplicate}>+ New</button></header>{themes.map((theme) => <button key={theme.id} className={theme.id === selected.id ? 'selected' : ''} onClick={() => select(theme.id)}><ThemeDots theme={theme} /><span><strong>{theme.name}</strong><small>{BUILTIN_UI_THEMES.some((item) => item.id === theme.id) ? 'Built in' : 'Custom'}</small></span></button>)}</aside>
      <main className="theme-editor">
        <div className="theme-editor-title"><div>{custom ? <input value={selected.name} maxLength={40} onChange={(event) => update({ name: event.target.value })} aria-label="Theme name" /> : <><h2>{selected.name}</h2><small>Built-in theme · duplicate to customize</small></>}</div><div><button onClick={duplicate}>Duplicate</button>{custom && <button className="danger-ghost" onClick={remove}>Delete</button>}</div></div>
        <fieldset disabled={!custom}><legend>Palette</legend><ThemePreview theme={selected} />
          <label>Surface family<div className="theme-swatches surface-swatches">{UI_SURFACES.map((surface) => <button type="button" key={surface.id} className={selected.surface === surface.id ? 'selected' : ''} onClick={() => changeSurface(surface.id)} title={surface.name}><i style={{ background: surface.panel, borderColor: surface.border }} /><span>{surface.name}</span></button>)}</div></label>
          <label>Text<div className="theme-options">{compatibleTexts(selected.surface).map((text) => <button type="button" key={text.id} className={selected.text === text.id ? 'selected' : ''} onClick={() => update({ text: text.id as UiTextId })}>{text.name}</button>)}</div></label>
          <AccentRow label="Primary accent" value={selected.primaryAccent} tone={surfaceFor(selected.surface).tone} onChange={(primaryAccent) => update({ primaryAccent })} />
          <AccentRow label="Secondary accent" value={selected.secondaryAccent} tone={surfaceFor(selected.surface).tone} onChange={(secondaryAccent) => update({ secondaryAccent })} />
        </fieldset>
        <fieldset disabled={!custom}><legend>Size and shape</legend>
          <OptionRow label="Scale" options={['small','standard','large']} value={selected.scale} onChange={(scale) => update({ scale: scale as UiScale })} />
          <OptionRow label="Density" options={['compact','comfortable','spacious']} value={selected.density} onChange={(density) => update({ density: density as UiDensity })} />
          <OptionRow label="Corners" options={['sharp','soft','rounded']} value={selected.corners} onChange={(corners) => update({ corners: corners as UiTheme['corners'] })} />
        </fieldset>
        <fieldset disabled={!custom}><legend>Effects</legend><div className="theme-effect-grid">
          <Effect label="Panel opacity" value={selected.effects.opacity} min={.82} max={1} format={percent} onChange={(opacity) => update({ effects: { ...selected.effects, opacity } })} />
          <Effect label="Background blur" value={selected.effects.blur} min={0} max={28} step={1} format={(value) => `${value}px`} onChange={(blur) => update({ effects: { ...selected.effects, blur } })} />
          {(['shadow','glow','lighting'] as const).map((key) => <Effect key={key} label={key[0].toUpperCase() + key.slice(1)} value={selected.effects[key]} min={0} max={1} format={percent} onChange={(value) => update({ effects: { ...selected.effects, [key]: value } })} />)}
        </div></fieldset>
      </main>
      <footer><button className="ghost" onClick={cancel}>Cancel</button><button disabled={saving || (custom && !selected.name.trim())} onClick={() => void save()}>{saving ? 'Saving…' : 'Save theme'}</button></footer>
    </div>
  </FloatingWindow>;
}

function ThemeDots({ theme }: { theme: UiTheme }) { const surface = surfaceFor(theme.surface); const tone = surface.tone; return <i className="theme-dots" style={{ background: surface.panel, borderColor: surface.border }}><b style={{ background: tone === 'dark' ? accentFor(theme.primaryAccent).dark : accentFor(theme.primaryAccent).light }} /><b style={{ background: tone === 'dark' ? accentFor(theme.secondaryAccent).dark : accentFor(theme.secondaryAccent).light }} /></i>; }
function ThemePreview({ theme }: { theme: UiTheme }) { const surface = surfaceFor(theme.surface); const text = compatibleTexts(theme.surface).find((item) => item.id === theme.text)!; const accent = surface.tone === 'dark' ? accentFor(theme.primaryAccent).dark : accentFor(theme.primaryAccent).light; return <div className="theme-sample" style={{ background: surface.panel, color: text.primary, borderColor: surface.border }}><span style={{ background: surface.control, color: text.muted }}>Window chrome</span><strong>Readable content</strong><button type="button" style={{ background: accent }}>Action</button></div>; }
function AccentRow({ label, value, tone, onChange }: { label: string; value: UiAccentId; tone: 'light'|'dark'; onChange: (value: UiAccentId) => void }) { return <label>{label}<div className="accent-swatches">{UI_ACCENTS.map((accent) => <button type="button" key={accent.id} className={value === accent.id ? 'selected' : ''} onClick={() => onChange(accent.id)} title={accent.name}><i style={{ background: tone === 'dark' ? accent.dark : accent.light }} /></button>)}</div></label>; }
function OptionRow({ label, options, value, onChange }: { label: string; options: string[]; value: string; onChange: (value: string) => void }) { return <label>{label}<div className="theme-options">{options.map((option) => <button type="button" key={option} className={value === option ? 'selected' : ''} onClick={() => onChange(option)}>{option[0].toUpperCase() + option.slice(1)}</button>)}</div></label>; }
function Effect({ label, value, min, max, step = .01, format, onChange }: { label: string; value: number; min: number; max: number; step?: number; format: (value: number) => string; onChange: (value: number) => void }) { return <label className="theme-effect"><span>{label}<output>{format(value)}</output></span><input type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /></label>; }
function percent(value: number) { return `${Math.round(value * 100)}%`; }
function uniqueName(input: string, themes: readonly UiTheme[]) { const base = input.slice(0, 40); let name = base; let number = 2; while (themes.some((theme) => theme.name.toLowerCase() === name.toLowerCase())) { const suffix = ` ${number++}`; name = `${base.slice(0, 40 - suffix.length)}${suffix}`; } return name; }
