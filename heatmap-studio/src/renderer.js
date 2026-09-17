// WebGL2 mount for the heatmap shader — the parts of paper-design's ShaderMount
// that this app needs, plus deterministic time so exported frames are exact.

import { vertexShaderSource, heatmapFragmentShader, MAX_COLOR_COUNT } from './glsl.js';
import { resolveVertexShader, resolveFragmentShader } from './resolve-glsl.js';

const UNIFORM_NAMES = [
  'u_resolution', 'u_pixelRatio', 'u_imageAspectRatio', 'u_time',
  'u_originX', 'u_originY', 'u_worldWidth', 'u_worldHeight',
  'u_fit', 'u_scale', 'u_rotation', 'u_offsetX', 'u_offsetY',
  'u_image', 'u_colorBack', 'u_colors', 'u_colorsCount',
  'u_angle', 'u_noise', 'u_innerGlow', 'u_outerGlow', 'u_contour',
];

export const FIT = { none: 0, contain: 1, cover: 2 };

export class HeatmapRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      alpha: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
      desynchronized: false,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;

    this.program = createProgram(gl, vertexShaderSource, heatmapFragmentShader);
    gl.useProgram(this.program);

    this.locations = {};
    for (const name of UNIFORM_NAMES) {
      this.locations[name] = gl.getUniformLocation(this.program, name === 'u_colors' ? 'u_colors[0]' : name);
    }

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Float render targets let many sub-samples accumulate without clipping.
    this.floatOk = Boolean(gl.getExtension('EXT_color_buffer_float'));
    this.resolveProgram = createProgram(gl, resolveVertexShader, resolveFragmentShader);
    this.resolveLocations = {
      u_accum: gl.getUniformLocation(this.resolveProgram, 'u_accum'),
      u_invSamples: gl.getUniformLocation(this.resolveProgram, 'u_invSamples'),
      u_ssaa: gl.getUniformLocation(this.resolveProgram, 'u_ssaa'),
    };
    this.framebuffer = null;
    this.accumTexture = null;
    this.accumSize = { width: 0, height: 0 };

    this.texture = null;
    this.imageAspectRatio = 1;
    this.hasImage = false;
    this.colorBuffer = new Float32Array(MAX_COLOR_COUNT * 4);

    gl.uniform1i(this.locations.u_image, 0);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** @param {{data: ImageData, width: number, height: number, aspectRatio: number}|null} processed */
  setImage(processed) {
    const gl = this.gl;
    if (this.texture) gl.deleteTexture(this.texture);

    this.texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    if (processed) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, processed.data);
      // The shader samples with textureGrad, so it needs the mip chain.
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      this.imageAspectRatio = processed.aspectRatio;
      this.hasImage = true;
    } else {
      // Fully transparent pixel -> shader early-outs to the background colour.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      this.imageAspectRatio = 1;
      this.hasImage = false;
    }
  }

  /**
   * @param {object} p params
   * @param {number} time value of u_time (seconds of animation, speed already applied)
   * @param {number} width drawing buffer width in px
   * @param {number} height drawing buffer height in px
   * @param {number} pixelRatio
   */
  render(p, time, width, height, pixelRatio = 1) {
    const gl = this.gl;
    this.resizeCanvas(width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawPass(p, time, width, height, pixelRatio);
  }

  resizeCanvas(width, height) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /**
   * Average several sub-samples of one output frame: `samples` carries a
   * {params, time} pair per temporal sample, `ssaa` renders at that multiple and
   * boxes back down. Spatial supersampling cleans the hard edges; the temporal
   * samples are real motion blur, not a post-effect.
   */
  renderAccumulated(samples, width, height, ssaa = 1, pixelRatio = 1) {
    const gl = this.gl;
    const spatial = this.floatOk ? Math.min(4, Math.max(1, Math.round(ssaa))) : 1;
    const temporal = this.floatOk ? Math.max(1, samples.length) : 1;

    // Straight to the canvas when there is nothing to average. The resolve pass
    // dithers, but Paper's shader already adds ~2.5 levels of its own noise, so
    // measured banding is identical either way — not worth a full-screen copy.
    if (!this.floatOk || (spatial === 1 && temporal === 1)) {
      const only = samples[0];
      this.render(only.params, only.time, width, height, pixelRatio);
      return;
    }

    const innerW = width * spatial;
    const innerH = height * spatial;
    this.ensureAccumTarget(innerW, innerH);
    this.resizeCanvas(width, height);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, innerW, innerH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE); // straight sum; the resolve divides

    for (let i = 0; i < temporal; i++) {
      const sample = samples[i];
      this.drawPass(sample.params, sample.time, innerW, innerH, pixelRatio);
    }

    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.resolveProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accumTexture);
    gl.uniform1i(this.resolveLocations.u_accum, 0);
    gl.uniform1f(this.resolveLocations.u_invSamples, 1 / temporal);
    gl.uniform1i(this.resolveLocations.u_ssaa, spatial);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  ensureAccumTarget(width, height) {
    const gl = this.gl;
    if (this.accumSize.width === width && this.accumSize.height === height) return;

    if (this.accumTexture) gl.deleteTexture(this.accumTexture);
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);

    this.accumTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.accumTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);

    this.framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.accumTexture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      this.floatOk = false;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    this.accumSize = { width, height };
  }

  /** One pass of the heatmap shader into whatever target is currently bound. */
  drawPass(p, time, width, height, pixelRatio = 1) {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    const L = this.locations;
    gl.uniform2f(L.u_resolution, width, height);
    gl.uniform1f(L.u_pixelRatio, pixelRatio);
    gl.uniform1f(L.u_imageAspectRatio, this.imageAspectRatio);
    gl.uniform1f(L.u_time, time);

    gl.uniform1f(L.u_originX, 0.5);
    gl.uniform1f(L.u_originY, 0.5);
    gl.uniform1f(L.u_worldWidth, 0);
    gl.uniform1f(L.u_worldHeight, 0);
    gl.uniform1f(L.u_fit, FIT[p.fit] ?? FIT.contain);
    gl.uniform1f(L.u_scale, p.scale);
    gl.uniform1f(L.u_rotation, p.rotation);
    gl.uniform1f(L.u_offsetX, p.offsetX);
    gl.uniform1f(L.u_offsetY, p.offsetY);

    gl.uniform1f(L.u_angle, p.angle);
    gl.uniform1f(L.u_noise, p.noise);
    gl.uniform1f(L.u_innerGlow, p.innerGlow);
    gl.uniform1f(L.u_outerGlow, p.outerGlow);
    gl.uniform1f(L.u_contour, p.contour);

    const back = p.colorBack;
    gl.uniform4f(L.u_colorBack, back[0], back[1], back[2], back[3]);

    const colors = p.colors.slice(0, MAX_COLOR_COUNT);
    this.colorBuffer.fill(0);
    colors.forEach((c, i) => this.colorBuffer.set(c, i * 4));
    gl.uniform4fv(L.u_colors, this.colorBuffer);
    gl.uniform1f(L.u_colorsCount, colors.length);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  const vs = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    throw new Error(`Program link failed: ${log}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}
