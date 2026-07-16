// Hand-rolled WebGPU renderer: compute-morphed face mesh, barycentric
// wireframe + photo skin, glowing vertex points, HDR bloom post stack.

import {
  MORPH_COMPUTE, NORMAL_COMPUTE, FACE_SHADER, MOUTH_SHADER, POINTS_SHADER,
  BACKGROUND_SHADER, FACE_SHADOW_SHADER, BRIGHT_SHADER, DOWNSAMPLE_SHADER, UPSAMPLE_SHADER, COMPOSITE_SHADER,
} from './shaders.js';
import { perspective, multiply, translation, identity } from './mat4.js';
import { buildMouth } from '../face/mouth.js';
import { M } from '../face/morphs.js';

const BLOOM_LEVELS = 5;
const HDR_FORMAT = 'rgba16float';

export class Renderer {
  static async create(canvas, mesh, rig) {
    if (!navigator.gpu) throw new Error('webgpu-unsupported');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('webgpu-unsupported');
    const device = await adapter.requestDevice();
    const r = new Renderer(canvas, device, mesh, rig);
    r.#init();
    return r;
  }

  constructor(canvas, device, mesh, rig) {
    this.canvas = canvas;
    this.device = device;
    this.mesh = mesh;
    this.rig = rig;
    this.blend = 0;           // 0 = wireframe, 1 = photo skin
    this.glow = 1.0;
    this.sleep = 0;           // 0 = awake, 1 = offline (mesh greyed + dimmed)
    this.zoom = 1;            // clip-space zoom (scales the face to fit, pre-clip)
    this._scaleMat = identity();
    this._vpZoom = new Float32Array(16);
    this.talkEnergy = 0;
    this.iris = new Float32Array(4);
    this.model = identity();
    this.weights = new Float32Array(rig.numMorphs);
    this.wireColor = [0.05, 0.85, 1.0];
    this.rimColor = [0.35, 0.6, 1.0];
    this.backgroundColor = [0.004, 0.008, 0.04];
    this.backgroundAccent = [0.07, 0.24, 0.33];
    this.backgroundMode = 0; this.backgroundIntensity = .65; this.backgroundSpeed = 1; this.particles = 0;
    this.bloom = .85; this.meshPulse = 0; this.scanlines = .045; this.aberration = .035; this.vignette = .45; this.glitch = 0; this.reducedMotion = 0;
    this.canonicalUVs = mesh.uvs.slice();
    this.hasPhoto = false;
  }

  #init() {
    const { device, canvas, mesh, rig } = this;
    this.ctx = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device, format: this.format, alphaMode: 'opaque' });

    const sbuf = (data, usage = GPUBufferUsage.STORAGE) => {
      const b = device.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, data);
      return b;
    };

    // --- static geometry buffers
    this.basePosBuf = sbuf(mesh.positions);
    this.deltasBuf = sbuf(rig.deltas);
    this.trisBuf = sbuf(mesh.tris);
    this.adjOffBuf = sbuf(mesh.adjOffsets);
    this.adjTriBuf = sbuf(mesh.adjTris);
    this.photoUVBuf = sbuf(mesh.uvs); // canonical UVs until a photo is mapped

    // --- dynamic buffers
    this.weightsBuf = device.createBuffer({
      size: rig.numMorphs * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.morphedBuf = device.createBuffer({ size: mesh.vertexCount * 12, usage: GPUBufferUsage.STORAGE });
    this.normalsBuf = device.createBuffer({ size: mesh.vertexCount * 12, usage: GPUBufferUsage.STORAGE });

    this.morphParamsBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.morphParamsBuf, 0, new Uint32Array([mesh.vertexCount, rig.numMorphs, 0, 0]));

    this.frameBuf = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.postParamsBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.backgroundParamsBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

    // default 1x1 photo texture
    this.photoTex = device.createTexture({
      size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: this.photoTex }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);

    // --- compute pipelines
    this.morphPipe = device.createComputePipeline({
      layout: 'auto', compute: { module: device.createShaderModule({ code: MORPH_COMPUTE }), entryPoint: 'main' },
    });
    this.normalPipe = device.createComputePipeline({
      layout: 'auto', compute: { module: device.createShaderModule({ code: NORMAL_COMPUTE }), entryPoint: 'main' },
    });
    this.morphBG = device.createBindGroup({
      layout: this.morphPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.basePosBuf } },
        { binding: 1, resource: { buffer: this.deltasBuf } },
        { binding: 2, resource: { buffer: this.weightsBuf } },
        { binding: 3, resource: { buffer: this.morphedBuf } },
        { binding: 4, resource: { buffer: this.morphParamsBuf } },
      ],
    });
    this.normalBG = device.createBindGroup({
      layout: this.normalPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.morphedBuf } },
        { binding: 1, resource: { buffer: this.trisBuf } },
        { binding: 2, resource: { buffer: this.adjOffBuf } },
        { binding: 3, resource: { buffer: this.adjTriBuf } },
        { binding: 4, resource: { buffer: this.normalsBuf } },
        { binding: 5, resource: { buffer: this.morphParamsBuf } },
      ],
    });

    // --- render pipelines
    const premultipliedBlend = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    };
    const faceModule = device.createShaderModule({ code: FACE_SHADER });
    this.facePipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: faceModule, entryPoint: 'vs' },
      fragment: { module: faceModule, entryPoint: 'fs', targets: [{ format: HDR_FORMAT, blend: premultipliedBlend }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });

    // inner mouth: teeth / gums / tongue / cavity
    const mouth = buildMouth(mesh, rig);
    this.mouth = mouth;
    this.mouthVB = device.createBuffer({
      size: mouth.data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.mouthVB, 0, mouth.data);
    this.mouthParamsBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const mouthModule = device.createShaderModule({ code: MOUTH_SHADER });
    this.mouthPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: mouthModule, entryPoint: 'vs',
        buffers: [{
          arrayStride: 9 * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32x3' },
          ],
        }],
      },
      fragment: { module: mouthModule, entryPoint: 'fs', targets: [{ format: HDR_FORMAT, blend: premultipliedBlend }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.mouthBG = device.createBindGroup({
      layout: this.mouthPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: { buffer: this.mouthParamsBuf } },
      ],
    });

    const pointsModule = device.createShaderModule({ code: POINTS_SHADER });
    this.pointsPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: pointsModule, entryPoint: 'vs' },
      fragment: {
        module: pointsModule, entryPoint: 'fs',
        targets: [{
          format: HDR_FORMAT,
          blend: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } },
        }],
      },
      primitive: { topology: 'triangle-strip' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
    });
    this.pointsBG = device.createBindGroup({
      layout: this.pointsPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: { buffer: this.morphedBuf } },
      ],
    });

    const backgroundModule = device.createShaderModule({ code: BACKGROUND_SHADER });
    this.backgroundPipe = device.createRenderPipeline({
      layout: 'auto', vertex: { module: backgroundModule, entryPoint: 'vs' },
      fragment: { module: backgroundModule, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });
    this.backgroundBG = device.createBindGroup({ layout: this.backgroundPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.backgroundParamsBuf } }] });
    const shadowModule = device.createShaderModule({ code: FACE_SHADOW_SHADER });
    this.shadowPipe = device.createRenderPipeline({
      layout: 'auto', vertex: { module: shadowModule, entryPoint: 'vs' },
      fragment: { module: shadowModule, entryPoint: 'fs', targets: [{ format: HDR_FORMAT, blend: premultipliedBlend }] },
      primitive: { topology: 'triangle-list' },
    });
    this.shadowBG = device.createBindGroup({ layout: this.shadowPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.backgroundParamsBuf } }] });

    const post = (code, format, blend) => {
      const m = device.createShaderModule({ code });
      return device.createRenderPipeline({
        layout: 'auto',
        vertex: { module: m, entryPoint: 'vs' },
        fragment: { module: m, entryPoint: 'fs', targets: [{ format, blend }] },
        primitive: { topology: 'triangle-list' },
      });
    };
    const additive = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
    this.brightPipe = post(BRIGHT_SHADER, HDR_FORMAT);
    this.downPipe = post(DOWNSAMPLE_SHADER, HDR_FORMAT);
    this.upPipe = post(UPSAMPLE_SHADER, HDR_FORMAT, additive);
    this.compositePipe = post(COMPOSITE_SHADER, this.format);

    this.#makeFaceBindGroup();
    this.#resize();
    new ResizeObserver(() => this.#resize()).observe(this.canvas);
  }

  #makeFaceBindGroup() {
    this.faceBG = this.device.createBindGroup({
      layout: this.facePipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: { buffer: this.morphedBuf } },
        { binding: 2, resource: { buffer: this.normalsBuf } },
        { binding: 3, resource: { buffer: this.trisBuf } },
        { binding: 4, resource: { buffer: this.photoUVBuf } },
        { binding: 5, resource: this.photoTex.createView() },
        { binding: 6, resource: this.sampler },
      ],
    });
  }

  #resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(8, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(8, Math.floor(this.canvas.clientHeight * dpr));
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h;
    this.canvas.width = w; this.canvas.height = h;

    const tex = (sw, sh, opts = {}) => this.device.createTexture({
      size: [sw, sh], format: HDR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      ...opts,
    });
    this.depthTex?.destroy(); this.sceneTex?.destroy();
    this.depthTex = this.device.createTexture({
      size: [w, h], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.sceneTex = tex(w, h);

    this.bloomTex?.forEach((t) => t.destroy());
    this.bloomTex = [];
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const div = 2 << i; // half res, quarter, ...
      this.bloomTex.push(tex(Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1))));
    }

    // post bind groups
    const bg = (pipe, entries) => this.device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries });
    const tv = (t) => t.createView();
    this.brightBG = bg(this.brightPipe, [
      { binding: 0, resource: tv(this.sceneTex) }, { binding: 1, resource: this.sampler },
    ]);
    this.downBG = []; this.upBG = [];
    for (let i = 1; i < BLOOM_LEVELS; i++) {
      this.downBG.push(bg(this.downPipe, [
        { binding: 0, resource: tv(this.bloomTex[i - 1]) }, { binding: 1, resource: this.sampler },
      ]));
    }
    for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
      this.upBG[i] = bg(this.upPipe, [
        { binding: 0, resource: tv(this.bloomTex[i + 1]) }, { binding: 1, resource: this.sampler },
      ]);
    }
    this.compositeBG = bg(this.compositePipe, [
      { binding: 0, resource: tv(this.sceneTex) },
      { binding: 1, resource: tv(this.bloomTex[0]) },
      { binding: 2, resource: this.sampler },
      { binding: 3, resource: { buffer: this.postParamsBuf } },
    ]);

    const aspect = w / h;
    const proj = perspective((30 * Math.PI) / 180, aspect, 0.1, 20);
    const view = translation(0, -0.02, -4.4);
    this.viewProj = multiply(proj, view);
    this.aspect = aspect;
  }

  setWeights(w) { this.weights.set(w.subarray(0, this.rig.numMorphs)); }
  setModel(m) { this.model.set(m); }
  setIris(lx, ly, rx, ry, dim = 1) {
    this.iris[0] = lx; this.iris[1] = ly; this.iris[2] = rx; this.iris[3] = ry;
    this.irisDim = dim;
  }
  setBlend(v) { this.blend = Math.min(1, Math.max(0, v)); }
  setSleep(v) { this.sleep = Math.min(1, Math.max(0, v)); }
  // Zoom the whole rendered image in clip space (before the frustum clip), so
  // shrinking to fit a narrow/portrait viewport reveals the sides instead of
  // cropping them the way a post-render CSS scale would.
  setZoom(v) { this.zoom = Math.max(0.05, v); }
  setTalkEnergy(e) { this.talkEnergy = e; }
  setReducedMotion(value) { this.reducedMotion = value ? 1 : 0; }
  setAppearance(value) {
    const hex = (input) => [parseInt(input.slice(1, 3), 16) / 255, parseInt(input.slice(3, 5), 16) / 255, parseInt(input.slice(5, 7), 16) / 255];
    this.wireColor = hex(value.colors.wire); this.rimColor = hex(value.colors.rim); this.backgroundColor = hex(value.colors.background); this.backgroundAccent = hex(value.colors.backgroundAccent);
    this.backgroundMode = { none: 0, grid: 1, 'digital-rain': 2, starfield: 3 }[value.background.mode] ?? 0;
    this.backgroundIntensity = value.background.intensity; this.backgroundSpeed = value.background.speed; this.particles = value.background.particles;
    this.glow = value.effects.glow; this.bloom = value.effects.bloom; this.meshPulse = value.effects.meshPulse; this.scanlines = value.effects.scanlines; this.glitch = value.effects.glitch;
    this.aberration = value.effects.chromaticSplit; this.vignette = value.effects.vignette;
  }

  // Hot-swap the face geometry after shape adaptation: new base positions,
  // regenerated morph deltas, and a rebuilt inner mouth (same buffer sizes).
  applyGeometry(rig) {
    const { device, mesh } = this;
    this.rig = rig;
    device.queue.writeBuffer(this.basePosBuf, 0, mesh.positions);
    device.queue.writeBuffer(this.deltasBuf, 0, rig.deltas);
    const mouth = buildMouth(mesh, rig);
    this.mouth = mouth;
    device.queue.writeBuffer(this.mouthVB, 0, mouth.data);
  }

  setPhoto(bitmap, uvArray) {
    const { device } = this;
    this.photoTex?.destroy();
    this.photoTex = device.createTexture({
      size: [bitmap.width, bitmap.height], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: this.photoTex }, [bitmap.width, bitmap.height]);
    device.queue.writeBuffer(this.photoUVBuf, 0, uvArray);
    this.#makeFaceBindGroup();
    this.hasPhoto = true;
  }

  clearPhoto() {
    const { device } = this; this.photoTex?.destroy();
    this.photoTex = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: this.photoTex }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
    device.queue.writeBuffer(this.photoUVBuf, 0, this.canonicalUVs); this.#makeFaceBindGroup(); this.hasPhoto = false;
  }

  render(timeSec) {
    const { device, mesh, rig } = this;

    device.queue.writeBuffer(this.weightsBuf, 0, this.weights);

    // offline "sleep": fade the mesh toward a dim grey and dim the glow
    const s = this.sleep;
    const grey = [0.24, 0.26, 0.30];
    const mix = (c) => [
      c[0] + (grey[0] - c[0]) * s,
      c[1] + (grey[1] - c[1]) * s,
      c[2] + (grey[2] - c[2]) * s,
    ];
    const wire = mix(this.wireColor);
    const rim = mix(this.rimColor);
    const glow = this.glow * (1 - 0.65 * s);

    // scale clip-space x/y by zoom: diag(zoom, zoom, 1, 1) * viewProj
    this._scaleMat[0] = this.zoom; this._scaleMat[5] = this.zoom;
    const vp = multiply(this._scaleMat, this.viewProj, this._vpZoom);
    const motion = 1 - this.reducedMotion;

    const f = new Float32Array(64);
    f.set(vp, 0);
    f.set(this.model, 16);
    f.set([0, 0.05, 4.4, this.aspect], 32);          // camPos.xyz, aspect in w
    f.set([timeSec, this.blend, glow, 0.006], 36);   // p0
    f.set(this.iris, 40);                              // p1
    f.set([...rig.eyeCenterL, this.irisDim ?? 1], 44); // p2 (w = blink dim)
    f.set([...rig.eyeCenterR, this.talkEnergy], 48);   // p3
    f.set([...wire, 1], 52);
    const hologramMotion = this.meshPulse * motion;
    f.set([...rim, hologramMotion], 56);
    device.queue.writeBuffer(this.frameBuf, 0, f);
    device.queue.writeBuffer(this.postParamsBuf, 0, new Float32Array([timeSec, this.bloom, this.aberration, this.vignette, this.scanlines, this.glitch, motion, 0]));
    device.queue.writeBuffer(this.backgroundParamsBuf, 0, new Float32Array([
      ...this.backgroundColor, 1, ...this.backgroundAccent, 1,
      this.backgroundMode, this.backgroundIntensity, timeSec * this.backgroundSpeed * motion, this.particles,
      this.aspect, motion, 0, 0,
    ]));

    // inner mouth params: jaw follows the jawOpen morph weight exactly
    const jawAngle = this.weights[0] * rig.jawAngle; // weights[0] = M.jawOpen
    const tongueRaise = Math.min(1, this.talkEnergy * 1.5) * (0.45 + 0.55 * (0.5 + 0.5 * Math.sin(timeSec * 6.1)));
    // fade the teeth/gums/tongue in only as the mouth opens, so a fully closed
    // mouth doesn't leak a bright sliver of teeth at the lip seam
    const mouthOpen = Math.min(1, Math.max(this.weights[0] * 2.5, this.talkEnergy * 1.5));
    // teeth guard: lip morphs that pull the lips back in z (wide/press/corners)
    // eat into the arch clearance; recede the whole inner mouth by the residual
    // lip retraction (the morphs keep 25% of their z pull on the lip band) so
    // teeth can never pierce the lip surface, whatever the weight combination
    const w = this.weights;
    const lipRecede = rig.unit * (
      0.05 * 0.25 * w[M.lipWide] +
      0.03 * 0.25 * w[M.lipPress] +
      0.012 * (w[M.cornerUpL] + w[M.cornerUpR] + w[M.cornerDown])
    );
    device.queue.writeBuffer(this.mouthParamsBuf, 0, new Float32Array([
      jawAngle, tongueRaise, rig.jawPivot[0], rig.jawPivot[1],
      this.mouth.zFront, this.mouth.zBack, mouthOpen, lipRecede,
    ]));

    const enc = device.createCommandEncoder();

    // compute: morph + normals
    {
      const pass = enc.beginComputePass();
      const wg = Math.ceil(mesh.vertexCount / 64);
      pass.setPipeline(this.morphPipe);
      pass.setBindGroup(0, this.morphBG);
      pass.dispatchWorkgroups(wg);
      pass.setPipeline(this.normalPipe);
      pass.setBindGroup(0, this.normalBG);
      pass.dispatchWorkgroups(wg);
      pass.end();
    }

    // procedural background into the HDR scene
    {
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.sceneTex.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
      pass.setPipeline(this.backgroundPipe); pass.setBindGroup(0, this.backgroundBG); pass.draw(3); pass.end();
    }

    // fixed face shadow over the background/effects, below the face mesh
    {
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.sceneTex.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'load', storeOp: 'store' }] });
      pass.setPipeline(this.shadowPipe); pass.setBindGroup(0, this.shadowBG); pass.draw(3); pass.end();
    }

    // face + points into HDR over the background
    {
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: this.sceneTex.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: 'load', storeOp: 'store',
        }],
        depthStencilAttachment: {
          view: this.depthTex.createView(),
          depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard',
        },
      });
      pass.setPipeline(this.mouthPipe);
      pass.setBindGroup(0, this.mouthBG);
      pass.setVertexBuffer(0, this.mouthVB);
      pass.draw(this.mouth.vertexCount);
      pass.setPipeline(this.facePipe);
      pass.setBindGroup(0, this.faceBG);
      pass.draw(mesh.renderTriCount * 3);
      pass.setPipeline(this.pointsPipe);
      pass.setBindGroup(0, this.pointsBG);
      pass.draw(4, mesh.vertexCount + 2);
      pass.end();
    }

    // bloom chain
    const fsPass = (pipe, bgroup, target, load = 'clear') => {
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: target.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: load, storeOp: 'store' }],
      });
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bgroup);
      pass.draw(3);
      pass.end();
    };
    fsPass(this.brightPipe, this.brightBG, this.bloomTex[0]);
    for (let i = 1; i < BLOOM_LEVELS; i++) fsPass(this.downPipe, this.downBG[i - 1], this.bloomTex[i]);
    for (let i = BLOOM_LEVELS - 2; i >= 0; i--) fsPass(this.upPipe, this.upBG[i], this.bloomTex[i], 'load');

    // composite to canvas
    {
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(this.compositePipe);
      pass.setBindGroup(0, this.compositeBG);
      pass.draw(3);
      pass.end();
    }

    device.queue.submit([enc.finish()]);
  }
}
