import type { VisionFrameRate, VisionQuality, WorkspaceMode } from '../../shared/protocol';
import type { LiveClient } from './LiveClient';

export interface VisionOptions { mode: WorkspaceMode; frameRate: VisionFrameRate; quality: VisionQuality; canvasRestrictionTarget?: unknown }

export class CanvasVision {
  active = false;
  paused = false;
  private stream?: MediaStream;
  private track?: MediaStreamTrack & { restrictTo?: (target: unknown) => Promise<void> };
  private video?: HTMLVideoElement;
  private timer = 0;
  private canvas = document.createElement('canvas');
  constructor(private readonly client: LiveClient, private readonly target: HTMLElement, private options: VisionOptions) {}

  async start() {
    if (this.active) return;
    if (this.options.mode === 'canvas' && !this.options.canvasRestrictionTarget) throw new Error('Canvas mode requires a primary canvas with a Cowork layer adapter.');
    const Restriction = (window as any).RestrictionTarget;
    if (!Restriction?.fromElement) throw new Error('Element Capture is unavailable. Use Chrome or Edge 132 or newer.');
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 2, max: 2 } }, audio: false, preferCurrentTab: true } as any);
    const track = stream.getVideoTracks()[0] as (MediaStreamTrack & { restrictTo?: (target: unknown) => Promise<void> }) | undefined;
    if (!track?.restrictTo) { stream.getTracks().forEach((item) => item.stop()); throw new Error('Choose this browser tab when sharing the workspace.'); }
    try { await track.restrictTo(await this.currentRestrictionTarget()); }
    catch (error) { stream.getTracks().forEach((item) => item.stop()); throw new Error(`Could not restrict capture to the workspace: ${(error as Error).message}`); }
    this.stream = stream; this.track = track;
    this.video = document.createElement('video'); this.video.muted = true; this.video.playsInline = true; this.video.srcObject = stream;
    await this.video.play(); track.addEventListener('ended', () => this.stop()); this.active = true;
    await this.sendFrame(); this.restartTimer();
  }

  async configure(options: VisionOptions) {
    this.options = options;
    if (!this.active || !this.track?.restrictTo) return;
    if (options.mode === 'canvas' && !options.canvasRestrictionTarget) { this.stop(); throw new Error('Canvas vision stopped because the primary canvas adapter is unavailable.'); }
    await this.track.restrictTo(await this.currentRestrictionTarget()); this.restartTimer();
  }

  stop() {
    clearInterval(this.timer); this.stream?.getTracks().forEach((track) => track.stop());
    if (this.video) this.video.srcObject = null;
    this.stream = undefined; this.track = undefined; this.video = undefined; this.active = false;
  }

  setPaused(paused: boolean) { this.paused = paused; if (!paused && this.active) void this.sendFrame(); }

  private async currentRestrictionTarget() {
    if (this.options.mode === 'canvas') return this.options.canvasRestrictionTarget;
    return (window as any).RestrictionTarget.fromElement(this.target);
  }

  private restartTimer() {
    clearInterval(this.timer); this.timer = window.setInterval(() => void this.sendFrame(), 1000 / this.options.frameRate);
  }

  private async sendFrame() {
    if (this.paused || !this.video?.videoWidth || !this.client.ready || this.client.inputBlocked) return;
    const dimensions = { low: 512, balanced: 768, high: 1024 } as const;
    const quality = { low: .64, balanced: .72, high: .8 } as const;
    const scale = Math.min(1, dimensions[this.options.quality] / Math.max(this.video.videoWidth, this.video.videoHeight));
    this.canvas.width = Math.round(this.video.videoWidth * scale); this.canvas.height = Math.round(this.video.videoHeight * scale);
    this.canvas.getContext('2d')!.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => this.canvas.toBlob(resolve, 'image/jpeg', quality[this.options.quality]));
    if (!blob) return;
    const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    this.client.sendVideo(btoa(binary));
  }
}
