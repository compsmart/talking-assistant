import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { GEMINI_LIVE_VOICES, type AssistantProfile, type AssistantSettings, type AvatarAppearanceSettings } from '../../shared/protocol';
import { DEFAULT_ASSISTANT_SETTINGS } from '../settings/assistantDefaults';
import { FloatingWindow } from './FloatingWindow';

interface Props {
  profile: AssistantProfile;
  onPreviewAppearance: (appearance: AvatarAppearanceSettings) => void;
  onPreviewPhoto: (photo: File | null) => Promise<void>;
  onSave: (settings: AssistantSettings, photoAction: 'keep' | 'replace' | 'remove', photo?: File) => Promise<void>;
  onCancel: () => Promise<void>;
  onError: (message: string) => void;
  onClose: () => void;
}

export function AssistantSettingsPanel({ profile, onPreviewAppearance, onPreviewPhoto, onSave, onCancel, onError, onClose }: Props) {
  const [draft, setDraft] = useState(profile.settings);
  const [photoAction, setPhotoAction] = useState<'keep' | 'replace' | 'remove'>('keep');
  const [photo, setPhoto] = useState<File>();
  const [saving, setSaving] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { setDraft(profile.settings); setPhotoAction('keep'); setPhoto(undefined); }, [profile]);
  const hasDraftPhoto = photoAction === 'replace' || (photoAction === 'keep' && profile.hasPhoto);
  const set = (next: AssistantSettings) => { setDraft(next); onPreviewAppearance(next.appearance); };
  const appearance = (next: Partial<AvatarAppearanceSettings>) => set({ ...draft, appearance: { ...draft.appearance, ...next } });
  const choosePhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0]; event.target.value = ''; if (!selected) return;
    try {
      await onPreviewPhoto(selected); setPhoto(selected); setPhotoAction('replace');
      appearance({ skinBlend: 1 });
    } catch (reason) { onError((reason as Error).message === 'no-face' ? 'No face was found in that photo.' : `Photo mapping failed: ${(reason as Error).message}`); }
  };
  const removePhoto = async () => { await onPreviewPhoto(null); setPhoto(undefined); setPhotoAction('remove'); };
  const cancel = async () => { await onCancel(); onClose(); };
  const save = async () => { setSaving(true); try { await onSave(draft, photoAction, photo); onClose(); } catch (reason) { onError((reason as Error).message); } finally { setSaving(false); } };
  const colors = draft.appearance.colors; const bg = draft.appearance.background; const fx = draft.appearance.effects;
  return <FloatingWindow id="assistant-settings" title="Assistant Settings" initial={{ x: 430, y: 38, width: 560, height: 700 }} minWidth={440} minHeight={480} className="settings-window assistant-settings-window" onClose={() => void cancel()}>
    <div className="settings-page assistant-settings-page">
      <section><h2>Portrait and material</h2><p>Map a front-facing portrait onto the animated mesh, then blend between holographic wire and skin.</p>
        <div className="portrait-row"><div className={`portrait-status ${hasDraftPhoto ? 'configured' : ''}`}><span>{hasDraftPhoto ? 'Portrait configured' : 'Pure wireframe'}</span><small>{hasDraftPhoto ? 'Private · stored outside the workspace' : 'Upload JPEG, PNG, or WebP'}</small></div><button className="ghost" onClick={() => file.current?.click()}>{hasDraftPhoto ? 'Replace' : 'Upload photo'}</button>{hasDraftPhoto && <button className="danger-ghost" onClick={() => void removePhoto()}>Remove</button>}</div>
        <input ref={file} className="file-input" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void choosePhoto(event)} />
        <Slider label="Wire → skin" value={draft.appearance.skinBlend} min={0} max={1} step={.01} disabled={!hasDraftPhoto} format={(value) => `${Math.round(value * 100)}%`} onChange={(skinBlend) => appearance({ skinBlend })} />
      </section>
      <section><h2>Hologram colors</h2><div className="color-grid">
        <ColorField label="Wire" value={colors.wire} onChange={(wire) => appearance({ colors: { ...colors, wire } })} />
        <ColorField label="Rim light" value={colors.rim} onChange={(rim) => appearance({ colors: { ...colors, rim } })} />
        <ColorField label="Background" value={colors.background} onChange={(background) => appearance({ colors: { ...colors, background } })} />
        <ColorField label="Digital accent" value={colors.backgroundAccent} onChange={(backgroundAccent) => appearance({ colors: { ...colors, backgroundAccent } })} />
      </div></section>
      <section><h2>Digital background</h2><div className="settings-grid"><Field label="Animation"><select value={bg.mode} onChange={(event) => appearance({ background: { ...bg, mode: event.target.value as typeof bg.mode } })}><option value="none">Off</option><option value="grid">Circuit grid</option><option value="digital-rain">Digital rain</option><option value="starfield">Starfield</option></select></Field></div>
        <Slider label="Intensity" value={bg.intensity} min={0} max={1} step={.01} format={percent} onChange={(intensity) => appearance({ background: { ...bg, intensity } })} />
        <Slider label="Animation speed" value={bg.speed} min={0} max={2} step={.01} format={(value) => `${value.toFixed(1)}×`} onChange={(speed) => appearance({ background: { ...bg, speed } })} />
        <Slider label="Ambient particles" value={bg.particles} min={0} max={1} step={.01} format={percent} onChange={(particles) => appearance({ background: { ...bg, particles } })} />
      </section>
      <section><h2>Visual effects</h2><div className="effect-grid">
        <Slider label="Glow" value={fx.glow} min={0} max={2} step={.01} format={(value) => `${Math.round(value * 100)}%`} onChange={(glow) => appearance({ effects: { ...fx, glow } })} />
        <Slider label="Bloom" value={fx.bloom} min={0} max={2} step={.01} format={(value) => `${Math.round(value * 100)}%`} onChange={(bloom) => appearance({ effects: { ...fx, bloom } })} />
        <Slider label="Mesh pulse & shimmer" value={fx.meshPulse} min={0} max={1} step={.01} format={percent} onChange={(meshPulse) => appearance({ effects: { ...fx, meshPulse } })} />
        <Slider label="Scanlines" value={fx.scanlines} min={0} max={.12} step={.001} format={(value) => `${Math.round(value / .12 * 100)}%`} onChange={(scanlines) => appearance({ effects: { ...fx, scanlines } })} />
        <Slider label="Glitch" value={fx.glitch} min={0} max={1} step={.01} format={percent} onChange={(glitch) => appearance({ effects: { ...fx, glitch } })} />
        <Slider label="Chromatic split" value={fx.chromaticSplit} min={0} max={.1} step={.001} format={(value) => `${Math.round(value * 1000)}%`} onChange={(chromaticSplit) => appearance({ effects: { ...fx, chromaticSplit } })} />
        <Slider label="Vignette" value={fx.vignette} min={0} max={1} step={.01} format={percent} onChange={(vignette) => appearance({ effects: { ...fx, vignette } })} />
      </div></section>
      <section><h2>Personality and voice</h2><Field label="Gemini Live voice"><select value={draft.voice} onChange={(event) => setDraft((current) => ({ ...current, voice: event.target.value as AssistantSettings['voice'] }))}>{GEMINI_LIVE_VOICES.map((voice) => <option key={voice.name} value={voice.name}>{voice.name} — {voice.style}</option>)}</select></Field>
        <label className="settings-field personality-field"><span>Speaking style and personality instructions</span><textarea maxLength={4000} value={draft.personalityPrompt} placeholder="Talk like an angry pirate." onChange={(event) => setDraft((current) => ({ ...current, personalityPrompt: event.target.value }))} /><small>{draft.personalityPrompt.length}/4000 · appended to the Live agent system prompt</small></label>
      </section>
      <footer><button className="ghost" onClick={() => set(structuredClone(DEFAULT_ASSISTANT_SETTINGS))}>Restore defaults</button><span /><button className="ghost" onClick={() => void cancel()}>Cancel</button><button disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save settings'}</button></footer>
    </div>
  </FloatingWindow>;
}

function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="settings-field"><span>{label}</span>{children}</label>; }
function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [text, setText] = useState(value); useEffect(() => setText(value), [value]);
  const commit = (next: string) => { setText(next); if (/^#[0-9a-f]{6}$/i.test(next)) onChange(next.toLowerCase()); };
  return <label className="settings-field color-field"><span>{label}</span><div><input type="color" value={value} onChange={(event) => commit(event.target.value)} /><input value={text} maxLength={7} spellCheck={false} onBlur={() => setText(value)} onChange={(event) => commit(event.target.value)} /></div></label>;
}
function Slider({ label, value, min, max, step, disabled, format, onChange }: { label: string; value: number; min: number; max: number; step: number; disabled?: boolean; format: (value: number) => string; onChange: (value: number) => void }) { return <label className="settings-slider"><span>{label}<output>{format(value)}</output></span><input type="range" value={value} min={min} max={max} step={step} disabled={disabled} onChange={(event) => onChange(Number(event.target.value))} /></label>; }
function percent(value: number) { return `${Math.round(value * 100)}%`; }
