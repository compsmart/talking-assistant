import type { LiveClient } from './LiveClient';

export class MicrophoneInput {
  active = false;
  private stream?: MediaStream;
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  constructor(private readonly client: LiveClient) {}

  async start() {
    if (this.active) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    this.context = new AudioContext();
    await this.context.resume();
    await this.context.audioWorklet.addModule(new URL('../avatar/legacy/audio/pcm-worklet.js', import.meta.url));
    const source = this.context.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.context, 'pcm-capture');
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const samples = downsample(event.data, this.context!.sampleRate, 16000);
      this.client.sendAudio(pcmBase64(samples));
    };
    const mute = this.context.createGain(); mute.gain.value = 0;
    source.connect(this.node).connect(mute).connect(this.context.destination);
    this.active = true;
  }

  stop() {
    if (!this.active) return;
    this.stream?.getTracks().forEach((track) => track.stop());
    void this.context?.close();
    this.stream = undefined; this.context = undefined; this.node = undefined; this.active = false;
    this.client.sendAudioEnd();
  }
}

function downsample(input: Float32Array, from: number, to: number) {
  if (from === to) return input;
  const ratio = from / to;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let index = 0; index < output.length; index++) {
    const position = index * ratio, before = Math.floor(position), fraction = position - before;
    output[index] = input[before] + (input[Math.min(before + 1, input.length - 1)] - input[before]) * fraction;
  }
  return output;
}

function pcmBase64(input: Float32Array) {
  const data = new Int16Array(input.length);
  for (let index = 0; index < input.length; index++) {
    const value = Math.max(-1, Math.min(1, input[index]));
    data[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  const bytes = new Uint8Array(data.buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
