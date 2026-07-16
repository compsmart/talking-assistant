// The low-level WebGPU rig remains JavaScript to preserve the reviewed face project.
// This typed controller is the only surface the cowork shell depends on.
import { loadFaceMesh } from './legacy/face/mesh.js';
import { buildMorphs } from './legacy/face/morphs.js';
import { Animator } from './legacy/face/animator.js';
import { Renderer } from './legacy/gpu/renderer.js';
import { PcmPlayer } from './legacy/audio/player.js';
import { LipSync } from './legacy/audio/lipsync.js';
import { mapPhoto } from './legacy/photo/mapper.js';
import { adaptMeshToFace } from './legacy/photo/shape.js';
import { runFaceTool } from './legacy/gemini/face-tools.js';
import type { AvatarAppearanceSettings } from '../../shared/protocol';
import { DEFAULT_ASSISTANT_SETTINGS } from '../settings/assistantDefaults';

export class AvatarController {
  onSpeakingChange?: (speaking: boolean) => void;
  private renderer: any;
  private animator = new Animator();
  private player = new PcmPlayer(24000);
  private lipsync = new LipSync(24000);
  private pristine!: Float32Array;
  private animation = 0;
  private last = performance.now();
  private blendTarget = 0;
  private blendCurrent = 0;
  private speaking = false;
  private hasPhoto = false;
  private appearance: AvatarAppearanceSettings = structuredClone(DEFAULT_ASSISTANT_SETTINGS.appearance);
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  constructor(private readonly canvas: HTMLCanvasElement) {}

  async initialize() {
    const mesh = await loadFaceMesh();
    this.pristine = mesh.positions.slice();
    const rig = buildMorphs(mesh);
    this.renderer = await Renderer.create(this.canvas, mesh, rig);
    this.renderer.setAppearance(this.appearance);
    this.renderer.setReducedMotion(this.reducedMotion.matches);
    this.reducedMotion.addEventListener('change', this.onReducedMotion);
    this.animator.setLipSeal(1);
    this.animation = requestAnimationFrame(this.frame);
  }

  ensureAudio() { this.player.ensureContext(); }
  enqueueAudio(samples: Float32Array) { const startsAt = this.player.enqueue(samples); this.lipsync.feed(samples, startsAt); }
  interrupt() { this.player.flush(); this.lipsync.clear(); }
  setBlend(value: number) { this.blendTarget = Math.max(0, Math.min(1, value)); }
  configureAppearance(value: AvatarAppearanceSettings) {
    this.appearance = structuredClone(value); this.blendTarget = this.hasPhoto ? value.skinBlend : 0; this.renderer?.setAppearance(value);
  }
  setPointer(x: number, y: number) { this.animator.setMouse(x, y); }
  runTool(name: string, args: Record<string, unknown>) { return runFaceTool(this.animator, name, args); }

  async applyPhoto(file: Blob) {
    const { bitmap, uvs, landmarks, aspect } = await mapPhoto(file, this.renderer.mesh.vertexCount);
    this.renderer.setPhoto(bitmap, uvs);
    if (adaptMeshToFace(this.renderer.mesh, this.pristine, landmarks, aspect)) this.renderer.applyGeometry(buildMorphs(this.renderer.mesh));
    this.hasPhoto = true; this.blendTarget = this.appearance.skinBlend;
  }

  clearPhoto() {
    if (!this.renderer) return;
    this.renderer.mesh.positions.set(this.pristine); this.renderer.applyGeometry(buildMorphs(this.renderer.mesh)); this.renderer.clearPhoto();
    this.hasPhoto = false; this.blendTarget = 0;
  }

  dispose() { cancelAnimationFrame(this.animation); this.reducedMotion.removeEventListener('change', this.onReducedMotion); this.interrupt(); }

  private onReducedMotion = (event: MediaQueryListEvent) => this.renderer?.setReducedMotion(event.matches);

  private frame = (now: number) => {
    const dt = Math.max(.0001, Math.min(.1, (now - this.last) / 1000));
    this.last = now;
    const mouth = this.lipsync.sample(this.player.time, dt);
    const speaking = this.player.playing;
    if (speaking !== this.speaking) {
      this.speaking = speaking;
      this.onSpeakingChange?.(speaking);
    }
    const state = this.animator.update(now / 1000, dt, mouth);
    this.blendCurrent += (this.blendTarget - this.blendCurrent) * (1 - Math.exp(-dt * 5));
    this.renderer.setBlend(this.blendCurrent);
    this.renderer.setWeights(state.weights);
    this.renderer.setModel(state.head);
    this.renderer.setIris(state.iris.x, state.iris.y, state.iris.x, state.iris.y, state.irisDim);
    this.renderer.setTalkEnergy(state.talkEnergy);
    this.renderer.render(now / 1000);
    this.animation = requestAnimationFrame(this.frame);
  };
}
