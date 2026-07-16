import type { VisionFrameRate, VisionQuality } from '../../shared/protocol';
import type { LiveClient } from './LiveClient';

export interface SurfaceVisionOptions { frameRate: VisionFrameRate; quality: VisionQuality }

export class SurfaceVision {
  active = false;
  private timer = 0;
  private sending = false;
  constructor(private readonly client: LiveClient, private readonly source: HTMLCanvasElement, private options: SurfaceVisionOptions) {}

  start() { if (this.active) return; this.active = true; void this.sendNow(); this.restartTimer(); }
  configure(options: SurfaceVisionOptions) { this.options = options; if (this.active) this.restartTimer(); }
  stop() { clearInterval(this.timer); this.timer = 0; this.active = false; }
  async sendNow() {
    if (!this.active || this.sending || !this.client.ready || this.client.inputBlocked || !this.source.width || !this.source.height) return;
    this.sending = true;
    try {
      const dimensions = { low: 512, balanced: 768, high: 1024 } as const;
      const quality = { low: .64, balanced: .72, high: .8 } as const;
      const scale = Math.min(1, dimensions[this.options.quality] / Math.max(this.source.width, this.source.height));
      const output = document.createElement('canvas'); output.width = Math.max(1, Math.round(this.source.width * scale)); output.height = Math.max(1, Math.round(this.source.height * scale));
      output.getContext('2d')!.drawImage(this.source, 0, 0, output.width, output.height);
      const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, 'image/jpeg', quality[this.options.quality])); if (!blob) return;
      const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      this.client.sendVideo(btoa(binary));
    } finally { this.sending = false; }
  }
  private restartTimer() { clearInterval(this.timer); this.timer = window.setInterval(() => void this.sendNow(), 1000 / this.options.frameRate); }
}
