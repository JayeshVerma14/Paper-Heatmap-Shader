import { HeatmapRenderer } from './renderer.js';
import { processImage } from './preprocess.js';
import { exportVideo, exportPngSequence, isVideoExportSupported, suggestBitrate, downloadBlob } from './export.js';
import {
  ANIMATABLE_KEYS, anyKeys, buildTimeMap, hasKeys, keyAt, paramAt, removeKey, sampleTimeMap, setKey,
} from './timeline.js';
import { createTimelineUI } from './timeline-ui.js';

// The animation repeats every 10/3 seconds of u_time (three phase-shifted copies
// of a 10s cycle), which is what makes a seamless loop export possible.
const LOOP_TIME = 10 / 3;
const STORAGE_KEY = 'heatmap-studio.v1';
const DEFAULT_SHAPE = './assets/Logo.svg';

const PARAM_CONTROLS = [
  { key: 'angle', label: 'Angle', min: 0, max: 360, step: 1, format: 'deg', hard: [0, 360] },
  { key: 'noise', label: 'Noise', min: 0, max: 1, step: 0.01, format: 'pct', hard: [0, 1] },
  { key: 'innerGlow', label: 'Inner glow', min: 0, max: 1, step: 0.01, format: 'pct', hard: [0, 1] },
  { key: 'outerGlow', label: 'Outer glow', min: 0, max: 1, step: 0.01, format: 'pct', hard: [0, 1] },
  { key: 'contour', label: 'Contour', min: 0, max: 1, step: 0.01, format: 'pct', hard: [0, 1] },
  { key: 'speed', label: 'Speed', min: 0, max: 2, step: 0.01, format: 'pct', hard: [0, 4] },
  { key: 'scale', label: 'Scale', min: 0.1, max: 2, step: 0.01, format: 'pct', hard: [0.05, 4] },
];

// These change the pre-processed mask, so they debounce into a reprocess rather
// than just setting a uniform. 100% is exactly Paper on both.
const SHAPE_CONTROLS = [
  { key: 'edgeSoftness', label: 'Edge softness', min: 0, max: 2, step: 0.05, format: 'pct', hard: [0, 3], reprocess: true },
  { key: 'glowSpread', label: 'Glow spread', min: 0.1, max: 1.5, step: 0.05, format: 'pct', hard: [0.05, 2], reprocess: true },
];

const QUALITY_CONTROLS = [
  { key: 'shutter', label: 'Shutter', min: 0, max: 360, step: 5, format: 'deg', hard: [0, 360] },
];

const LAYOUT_CONTROLS = [
  { key: 'rotation', label: 'Rotation', min: 0, max: 360, step: 1, format: 'deg', hard: [0, 360] },
  { key: 'offsetX', label: 'Offset X', min: -1, max: 1, step: 0.01, format: 'num', hard: [-1, 1] },
  { key: 'offsetY', label: 'Offset Y', min: -1, max: 1, step: 0.01, format: 'num', hard: [-1, 1] },
];

const RESOLUTIONS = [
  { id: 'uhd', label: '4K UHD — 3840 × 2160', width: 3840, height: 2160 },
  { id: 'dci', label: '4K DCI — 4096 × 2160', width: 4096, height: 2160 },
  { id: 'square4k', label: '4K square — 2160 × 2160', width: 2160, height: 2160 },
  { id: 'vertical4k', label: '4K vertical — 2160 × 3840', width: 2160, height: 3840 },
  { id: 'qhd', label: '1440p — 2560 × 1440', width: 2560, height: 1440 },
  { id: 'fhd', label: '1080p — 1920 × 1080', width: 1920, height: 1080 },
  { id: 'custom', label: 'Custom…', width: 3840, height: 2160 },
];

const DEFAULTS = {
  angle: 0,
  noise: 0,
  innerGlow: 0.4,
  outerGlow: 0.34,
  contour: 0.5,
  speed: 0.61,
  scale: 0.75,
  rotation: 0,
  offsetX: 0,
  offsetY: 0,
  fit: 'contain',
  shapeSource: 'auto',
  edgeSoftness: 1,
  glowSpread: 1,
  // Displayed hottest first, the way Paper's Foreground list reads.
  colors: [
    { hex: '#FFFFFF', alpha: 1 },
    { hex: '#6078CA', alpha: 1 },
  ],
  background: { hex: '#000000', alpha: 1 },
  keyframes: {},
  timelineDuration: 0, // 0 = follow the shader's own loop length
  timelineCollapsed: false,
  theme: 'dark',
  ssaa: 2,
  motionSamples: 1,
  shutter: 180,
  exportPreset: 'uhd',
  exportWidth: 3840,
  exportHeight: 2160,
  fps: 30,
  duration: 5.5,
  snapLoop: true,
  format: 'mp4',
  quality: 'high',
};

const el = (id) => document.getElementById(id);
const topbarHeight = () => document.querySelector('.topbar')?.offsetHeight ?? 64;
const dom = {
  canvas: el('canvas'),
  frame: el('frame'),
  frameBusy: el('frameBusy'),
  stageInner: document.querySelector('.stage-inner'),
  params: el('params'),
  layout: el('layout'),
  colorList: el('colorList'),
  backgroundRow: el('backgroundRow'),
  thumb: el('thumb'),
  shapeName: el('shapeName'),
  shapeDims: el('shapeDims'),
  shapeHint: el('shapeHint'),
  shapeSource: el('shapeSource'),
  shapeParams: el('shapeParams'),
  fit: el('fit'),
  fileInput: el('fileInput'),
  pickImageBtn: el('pickImageBtn'),
  addColorBtn: el('addColorBtn'),
  flipColorsBtn: el('flipColorsBtn'),
  resetBtn: el('resetBtn'),
  stillBtn: el('stillBtn'),
  exportBtn: el('exportBtn'),
  cancelBtn: el('cancelBtn'),
  playBtn: el('playBtn'),
  playIcon: el('playIcon'),
  scrub: el('scrub'),
  timeLabel: el('timeLabel'),
  loopLabel: el('loopLabel'),
  sizeLabel: el('sizeLabel'),
  resPreset: el('resPreset'),
  customSize: el('customSize'),
  customW: el('customW'),
  customH: el('customH'),
  fps: el('fps'),
  duration: el('duration'),
  snapLoop: el('snapLoop'),
  format: el('format'),
  quality: el('quality'),
  exportHint: el('exportHint'),
  progress: el('progress'),
  progressFill: el('progressFill'),
  progressLabel: el('progressLabel'),
  status: el('status'),
  dropveil: el('dropveil'),
  themeBtn: el('themeBtn'),
  themeIcon: el('themeIcon'),
  timelineBody: el('timelineBody'),
  tlDuration: el('tlDuration'),
  tlClear: el('tlClear'),
  tlToggle: el('tlToggle'),
  ssaa: el('ssaa'),
  motionSamples: el('motionSamples'),
  qualityParams: el('qualityParams'),
  qualityHint: el('qualityHint'),
  timeline: document.querySelector('.timeline'),
  topbarHeight,
};

const state = { ...structuredClone(DEFAULTS), ...loadSaved() };

let renderer;
let lastTimestamp = 0;
let playing = true;
let scrubbing = false;
let rafHandle = 0;
let exporting = false;
let cancelRequested = false;
let sourceImage = null;
let sourceName = 'Logo.svg';
let previewSize = { width: 16, height: 9 };
let timelineUI = null;
let timeMap = null;
let playhead = 0;

/* ---------------------------------------------------------------- shader IO */

function hexToRgb(hex) {
  let value = hex.replace('#', '').trim();
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(value)) return [0, 0, 0];
  return [
    parseInt(value.slice(0, 2), 16) / 255,
    parseInt(value.slice(2, 4), 16) / 255,
    parseInt(value.slice(4, 6), 16) / 255,
  ];
}

/** Parameter values at a point on the timeline (keyframes win over the sliders). */
function shaderParams(time = playhead) {
  // The list reads hottest-first; the shader ramp runs coldest-first.
  const colors = [...state.colors]
    .reverse()
    .map(({ hex, alpha }) => [...hexToRgb(hex), alpha]);
  const p = {
    fit: state.fit,
    colorBack: [...hexToRgb(state.background.hex), state.background.alpha],
    colors: colors.length ? colors : [[0, 0, 0, 1]],
  };
  for (const key of ANIMATABLE_KEYS) p[key] = paramAt(state, key, time);
  return p;
}

/* ----------------------------------------------------------------- timeline */

/** Shader-clock length of one visual cycle at the current (static) speed. */
function loopSecondsFor(speed) {
  return speed > 0 ? LOOP_TIME / speed : 0;
}

function timelineDuration() {
  if (state.timelineDuration > 0) return state.timelineDuration;
  const loop = loopSecondsFor(state.speed);
  return loop > 0 ? loop : 5;
}

function rebuildTimeMap() {
  timeMap = buildTimeMap(state, timelineDuration());
}

function shaderTime(time = playhead) {
  return sampleTimeMap(timeMap, time);
}

function setPlayhead(time) {
  const duration = timelineDuration();
  playhead = Math.min(Math.max(time, 0), duration);
  syncAllSliders();
  timelineUI?.refresh();
}

/* ------------------------------------------------------------------ preview */

function exportSize() {
  const preset = RESOLUTIONS.find((r) => r.id === state.exportPreset) ?? RESOLUTIONS[0];
  if (preset.id === 'custom') {
    return {
      width: clamp(Math.round(state.exportWidth / 2) * 2, 16, 7680),
      height: clamp(Math.round(state.exportHeight / 2) * 2, 16, 7680),
    };
  }
  return { width: preset.width, height: preset.height };
}

let lastFrameSize = '';

function layoutFrame() {
  const { width: ew, height: eh } = exportSize();
  const box = dom.stageInner.getBoundingClientRect();
  const transport = document.querySelector('.transport').getBoundingClientRect();
  const availableW = Math.max(120, box.width);
  // The preview shares the stage column with the transport and the timeline, so
  // it is sized around them — you should never have to scroll the preview away
  // to reach a keyframe lane.
  const stacked = window.innerWidth <= 1080;
  const timelineH = dom.timeline?.offsetHeight ?? 0;
  const chrome = transport.height + timelineH + 32;
  const availableH = stacked
    ? Math.max(150, window.innerHeight - dom.topbarHeight() - chrome - 24)
    : Math.max(120, box.height - chrome);
  const scale = Math.min(availableW / ew, availableH / eh);
  // Derive the height from the width so the preview keeps the export's exact
  // aspect ratio — the shader composes against it.
  const width = Math.max(80, Math.floor(ew * scale));
  const height = Math.max(45, Math.round((width * eh) / ew));
  const signature = `${width}x${height}`;
  if (signature === lastFrameSize && dom.frame.style.width) {
    dom.frame.style.background = state.background.alpha > 0 ? state.background.hex : '#ffffff';
    return;
  }
  lastFrameSize = signature;
  dom.frame.style.width = `${width}px`;
  dom.frame.style.height = `${height}px`;
  dom.frame.style.background = state.background.alpha > 0 ? state.background.hex : '#ffffff';

  const density = Math.min(window.devicePixelRatio || 1, 2);
  let bufferW = Math.round(width * density);
  let bufferH = Math.round((bufferW * eh) / ew);
  const maxPixels = 8_300_000; // full 4K worth of preview on a large display
  if (bufferW * bufferH > maxPixels) {
    const k = Math.sqrt(maxPixels / (bufferW * bufferH));
    bufferW = Math.round(bufferW * k);
    bufferH = Math.round((bufferW * eh) / ew);
  }
  previewSize = { width: bufferW, height: bufferH, density };
}

/**
 * The sub-samples that make up one output frame: `count` slices of the shutter,
 * centred on the frame time. Each slice resolves its own parameters, so keyframed
 * motion blurs correctly too.
 */
function frameSamples(centerTime, frameDelta, count, shutterFraction) {
  const list = [];
  for (let k = 0; k < count; k++) {
    const offset = count === 1 ? 0 : ((k + 0.5) / count - 0.5) * shutterFraction * frameDelta;
    const t = centerTime + offset;
    list.push({ params: shaderParams(t), time: shaderTime(t) });
  }
  return list;
}

/**
 * One shader pass at preview size costs ~10-25ms, so playback gets a budget of
 * four passes; the full quality is rendered as soon as the playhead stops, which
 * is when you are actually judging the frame.
 */
const PLAYING_PASS_BUDGET = 4;

function previewQuality() {
  if (!playing || scrubbing) return { ssaa: state.ssaa, samples: Math.max(1, state.motionSamples) };
  const samples = Math.max(1, Math.min(state.motionSamples, PLAYING_PASS_BUDGET));
  return { ssaa: 1, samples };
}

function renderPreview() {
  const { ssaa, samples } = previewQuality();
  const fps = Number(state.fps) || 30;
  const list = frameSamples(playhead, 1 / fps, samples, state.shutter / 360);
  renderer.renderAccumulated(list, previewSize.width, previewSize.height, ssaa, previewSize.density ?? 1);
}

function tick(timestamp) {
  const animated = anyKeys(state);
  rafHandle = requestAnimationFrame(tick);
  if (exporting) return;

  const delta = lastTimestamp ? (timestamp - lastTimestamp) / 1000 : 0;
  lastTimestamp = timestamp;

  const duration = timelineDuration();
  if (playing && !scrubbing) {
    playhead = (playhead + Math.min(delta, 0.25)) % duration;
    if (animated) syncAllSliders();
    timelineUI?.refresh();
  }

  renderPreview();

  if (!scrubbing) dom.scrub.value = String(Math.round((playhead / duration) * 1000));
  dom.timeLabel.textContent = `${playhead.toFixed(2)}s`;
}

/* -------------------------------------------------------------------- image */

async function loadImageFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    sourceName = file.name;
    await applyImage(image, url);
  } catch {
    setStatus('That file could not be read as an image.', 'error');
    URL.revokeObjectURL(url);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.addEventListener('load', () => resolve(image));
    image.addEventListener('error', reject);
    image.src = src;
  });
}

async function applyImage(image, previewUrl) {
  sourceImage = image;
  dom.thumb.style.backgroundImage = `url("${previewUrl}")`;
  dom.shapeName.textContent = sourceName;
  dom.shapeDims.textContent = `${image.naturalWidth} × ${image.naturalHeight}`;
  await reprocess();
}

let reprocessToken = 0;

async function reprocess() {
  if (!sourceImage) return;
  const token = ++reprocessToken;

  dom.frameBusy.hidden = false;
  // Let the browser paint the busy state before the rasterise pass.
  await new Promise((resolve) => setTimeout(resolve, 16));
  try {
    const processed = await processImage(sourceImage, state.shapeSource, state.edgeSoftness, state.glowSpread);
    if (token !== reprocessToken) return; // a newer image won the race
    renderer.setImage(processed);
    calibrateCost();
    updateExportHint();
    dom.shapeHint.textContent =
      state.shapeSource === 'auto'
        ? `Auto picked the ${processed.mode === 'alpha' ? 'alpha channel' : 'artwork luminance'}.`
        : 'Drop an image anywhere to replace the shape.';
  } catch (error) {
    setStatus(`Could not process that image: ${error.message}`, 'error');
  } finally {
    if (token === reprocessToken) dom.frameBusy.hidden = true;
  }
}

/* ----------------------------------------------------------------- controls */

function formatValue(value, format) {
  if (format === 'pct') return `${Math.round(value * 100)}%`;
  if (format === 'deg') return `${Math.round(value)}°`;
  return value.toFixed(2);
}

function parseValue(text, format, fallback) {
  const numeric = Number.parseFloat(String(text).replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(numeric)) return fallback;
  return format === 'pct' ? numeric / 100 : numeric;
}

function buildSliders(container, controls) {
  container.textContent = '';
  for (const control of controls) {
    const wrap = document.createElement('div');
    wrap.className = 'control';

    const head = document.createElement('div');
    head.className = 'control-head';

    const label = document.createElement('label');
    label.className = 'control-label';
    label.textContent = control.label;
    label.htmlFor = `slider-${control.key}`;

    const value = document.createElement('input');
    value.className = 'control-value';
    value.type = 'text';
    value.setAttribute('aria-label', `${control.label} value`);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.id = `slider-${control.key}`;
    slider.min = String(control.min);
    slider.max = String(control.max);
    slider.step = String(control.step);

    // Keyframable parameters get a diamond: it adds a key at the playhead, and
    // shows filled when the playhead is sitting on one.
    const animatable = ANIMATABLE_KEYS.includes(control.key);
    let keyBtn = null;
    if (animatable) {
      keyBtn = document.createElement('button');
      keyBtn.type = 'button';
      keyBtn.className = 'key-btn';
      keyBtn.textContent = '◆';
      keyBtn.title = `Keyframe ${control.label} at the playhead`;
      keyBtn.setAttribute('aria-label', keyBtn.title);
    }

    const currentValue = () => (animatable ? paramAt(state, control.key, playhead) : state[control.key]);

    const sync = () => {
      const current = currentValue();
      slider.value = String(clamp(current, control.min, control.max));
      value.value = formatValue(current, control.format);
      const fill = ((clamp(current, control.min, control.max) - control.min) / (control.max - control.min)) * 100;
      slider.style.setProperty('--fill', `${fill}%`);
      if (keyBtn) {
        const onKey = Boolean(keyAt(state, control.key, playhead));
        keyBtn.classList.toggle('is-on', onKey);
        keyBtn.classList.toggle('is-animated', hasKeys(state, control.key));
        wrap.classList.toggle('is-animated', hasKeys(state, control.key));
      }
    };

    /** Writing a value: straight to state, or onto the track once it has keys. */
    const write = (next) => {
      if (animatable && hasKeys(state, control.key)) {
        setKey(state, control.key, snapTime(playhead), next);
        rebuildTimeMap();
        timelineUI?.refresh();
      } else {
        state[control.key] = next;
      }
      sync();
      onParamsChanged(control.key);
    };

    slider.addEventListener('input', () => write(Number(slider.value)));

    const commit = () => {
      const parsed = parseValue(value.value, control.format, currentValue());
      write(clamp(parsed, control.hard[0], control.hard[1]));
    };
    value.addEventListener('change', commit);
    value.addEventListener('blur', commit);
    value.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') value.blur();
    });

    keyBtn?.addEventListener('click', () => {
      const t = snapTime(playhead);
      if (keyAt(state, control.key, t)) {
        removeKey(state, control.key, t);
      } else {
        setKey(state, control.key, t, currentValue());
      }
      rebuildTimeMap();
      sync();
      timelineUI?.refresh();
      updateExportHint();
      layoutFrame();
      save();
    });

    head.append(label, value);
    if (keyBtn) head.append(keyBtn);
    wrap.append(head, slider);
    container.append(wrap);
    control.sync = sync;
    sync();
  }
}

function syncAllSliders() {
  for (const control of [...SHAPE_CONTROLS, ...QUALITY_CONTROLS, ...PARAM_CONTROLS, ...LAYOUT_CONTROLS]) control.sync?.();
}

function colorRow(entry, { onChange, onRemove }) {
  const row = document.createElement('div');
  row.className = 'color-row';

  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.background = entry.hex;
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.value = normalizeHex(entry.hex);
  picker.setAttribute('aria-label', 'Colour');
  swatch.append(picker);

  const hex = document.createElement('input');
  hex.className = 'hex';
  hex.type = 'text';
  hex.value = entry.hex.replace('#', '');
  hex.setAttribute('aria-label', 'Hex value');

  const alpha = document.createElement('input');
  alpha.className = 'alpha';
  alpha.type = 'text';
  alpha.value = `${Math.round(entry.alpha * 100)} %`;
  alpha.setAttribute('aria-label', 'Opacity');

  picker.addEventListener('input', () => {
    entry.hex = picker.value.toUpperCase();
    hex.value = entry.hex.replace('#', '');
    swatch.style.background = entry.hex;
    onChange();
  });

  const commitHex = () => {
    const normalized = normalizeHex(hex.value);
    entry.hex = normalized.toUpperCase();
    hex.value = entry.hex.replace('#', '');
    picker.value = normalized;
    swatch.style.background = entry.hex;
    onChange();
  };
  hex.addEventListener('change', commitHex);
  hex.addEventListener('blur', commitHex);

  const commitAlpha = () => {
    const parsed = Number.parseFloat(alpha.value.replace(/[^0-9.]/g, ''));
    entry.alpha = clamp(Number.isFinite(parsed) ? parsed / 100 : 1, 0, 1);
    alpha.value = `${Math.round(entry.alpha * 100)} %`;
    onChange();
  };
  alpha.addEventListener('change', commitAlpha);
  alpha.addEventListener('blur', commitAlpha);

  row.append(swatch, hex, alpha);

  if (onRemove) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn';
    remove.textContent = '−';
    remove.setAttribute('aria-label', `Remove ${entry.hex}`);
    remove.addEventListener('click', onRemove);
    row.append(remove);
  }

  return row;
}

function buildColors() {
  dom.colorList.textContent = '';
  state.colors.forEach((entry, index) => {
    dom.colorList.append(
      colorRow(entry, {
        onChange: () => onParamsChanged('colors'),
        onRemove:
          state.colors.length > 1
            ? () => {
                state.colors.splice(index, 1);
                buildColors();
                onParamsChanged('colors');
              }
            : null,
      })
    );
  });
  dom.addColorBtn.disabled = state.colors.length >= 10;

  dom.backgroundRow.textContent = '';
  dom.backgroundRow.append(colorRow(state.background, { onChange: () => onParamsChanged('background') }));
}

/* ------------------------------------------------------------------- export */

function loopSeconds() {
  return state.speed > 0 ? LOOP_TIME / state.speed : 0;
}

function exportPlan() {
  const { width, height } = exportSize();
  const fps = Number(state.fps);
  const animated = anyKeys(state);
  const loop = loopSeconds();
  let frameCount;
  let duration;
  let timeStep = 0;
  let fromTimeline = false;

  if (animated) {
    // The timeline is the authority: render exactly its length.
    duration = timelineDuration();
    frameCount = Math.max(1, Math.round(duration * fps));
    fromTimeline = true;
  } else if (state.snapLoop && loop > 0) {
    const loops = Math.max(1, Math.round(state.duration / loop));
    frameCount = Math.max(1, Math.round(loops * loop * fps));
    timeStep = (loops * LOOP_TIME) / frameCount;
    duration = frameCount / fps;
  } else {
    frameCount = Math.max(1, Math.round(state.duration * fps));
    timeStep = state.speed / fps;
    duration = frameCount / fps;
  }

  const bitrate = suggestBitrate(width, height, fps, state.quality);
  return { width, height, fps, frameCount, timeStep, duration, bitrate, animated: fromTimeline };
}

// Rough cost model, calibrated once against this GPU: a pass costs a fixed
// setup plus a per-megapixel rate. Used only for the estimate in the panel; the
// progress bar's own ETA takes over once an export is running.
let msPerMpxPass = 9;
let passOverheadMs = 15;
let calibrated = false;

function calibrateCost() {
  if (calibrated || !renderer?.hasImage) return;
  calibrated = true;
  try {
    const gl = renderer.gl;
    const pixel = new Uint8Array(4);
    const params = shaderParams(0);
    // readPixels forces the GPU to finish, otherwise the timings are fiction.
    const timeAt = (w, h, seed) => {
      renderer.render(params, seed, w, h, 1);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      const t0 = performance.now();
      renderer.render(params, seed + 0.1, w, h, 1);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return performance.now() - t0;
    };
    // Two points -> slope and fixed cost, so the estimate holds at both ends.
    const small = timeAt(1280, 720, 0);
    const large = timeAt(1920, 1080, 1);
    const smallMpx = (1280 * 720) / 1e6;
    const largeMpx = (1920 * 1080) / 1e6;
    const slope = (large - small) / (largeMpx - smallMpx);
    if (Number.isFinite(slope) && slope > 0.5) {
      msPerMpxPass = slope;
      passOverheadMs = Math.max(0, small - slope * smallMpx);
    }
  } catch {
    /* keep the default estimate */
  }
  layoutFrame();
}

function estimateExportSeconds(plan) {
  const megapixels = (plan.width * plan.height) / 1e6;
  const passes = Math.max(1, state.motionSamples) * state.ssaa * state.ssaa;
  const renderMs = passOverheadMs + msPerMpxPass * megapixels * passes;
  // Hardware H.264 runs ~110ms per 4K frame; PNG has to deflate the whole frame
  // on the CPU, which is several times slower.
  const encodeMs = (state.format === 'png' ? 55 : 13) * megapixels;
  return (plan.frameCount * (renderMs + encodeMs)) / 1000;
}

function formatDuration(seconds) {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  return minutes < 60 ? `${minutes.toFixed(minutes < 10 ? 1 : 0)} min` : `${(minutes / 60).toFixed(1)} h`;
}

function updateQualityHint() {
  const passes = Math.max(1, state.motionSamples) * state.ssaa * state.ssaa;
  const blur = state.motionSamples > 1 ? `${state.motionSamples}-step blur` : 'no motion blur';
  const parts = [`${passes} shader pass${passes === 1 ? '' : 'es'} per frame`];
  if (state.ssaa > 1) parts.push(`${state.ssaa}× supersampled`);
  if (state.motionSamples > 1) parts.push(blur);
  dom.qualityHint.textContent =
    `${parts.join(' · ')}. Motion blur only matters for fast keyframed moves — ` +
    'the base sweep advances under 1% of its cycle per frame.';
  dom.shutter?.toggleAttribute?.('disabled', state.motionSamples <= 1);
}

function updateExportHint() {
  const plan = exportPlan();
  // PNG frames are roughly 1 byte per pixel on this kind of art; video is bitrate.
  const megabytes =
    state.format === 'png'
      ? (plan.width * plan.height * plan.frameCount) / 1e6
      : (plan.bitrate * plan.duration) / 8 / 1e6;
  dom.exportHint.textContent =
    `${plan.width} × ${plan.height} · ${plan.fps} fps · ${plan.frameCount} frames · ` +
    `${plan.duration.toFixed(2)}s · ~${megabytes.toFixed(0)} MB · ≈${formatDuration(estimateExportSeconds(plan))} to render`;
  dom.sizeLabel.textContent = `${plan.width} × ${plan.height}`;
  dom.loopLabel.textContent = plan.animated
    ? `timeline ${timelineDuration().toFixed(2)}s`
    : loopSeconds() > 0
      ? `loop ${loopSeconds().toFixed(2)}s`
      : 'paused';
  dom.duration.disabled = plan.animated;
  dom.snapLoop.disabled = plan.animated;
  if (plan.animated || state.snapLoop) dom.duration.value = String(Number(plan.duration.toFixed(2)));
  dom.tlDuration.value = String(Number(timelineDuration().toFixed(2)));
}

async function runExport() {
  if (exporting) return;
  if (!isVideoExportSupported()) {
    setStatus('This browser cannot encode video. Open the app in Chrome or Edge.', 'error');
    return;
  }

  const plan = exportPlan();
  exporting = true;
  cancelRequested = false;
  dom.exportBtn.disabled = true;
  dom.stillBtn.disabled = true;
  dom.progress.hidden = false;
  dom.progressFill.style.width = '0%';
  dom.progressLabel.textContent = 'Preparing…';
  setStatus('');

  const staticParams = shaderParams(0);
  const startTime = plan.animated ? 0 : shaderTime();
  const step = plan.animated ? plan.duration / plan.frameCount : plan.timeStep;
  const started = performance.now();

  // Keyframed: resolve every parameter and the shader clock per frame.
  // Otherwise: the old fixed-step path, which keeps the seamless-loop maths.
  const samples = Math.max(1, state.motionSamples);
  const shutterFraction = state.shutter / 360;
  const drawFrame = plan.animated
    ? (i) => {
        const list = frameSamples(i * step, step, samples, shutterFraction);
        renderer.renderAccumulated(list, plan.width, plan.height, state.ssaa, 1);
      }
    : (i) => {
        // No keyframes: parameters are fixed, only the shader clock moves.
        const list = [];
        for (let k = 0; k < samples; k++) {
          const offset = samples === 1 ? 0 : ((k + 0.5) / samples - 0.5) * shutterFraction;
          list.push({ params: staticParams, time: startTime + (i + offset) * step });
        }
        renderer.renderAccumulated(list, plan.width, plan.height, state.ssaa, 1);
      };

  try {
    const common = {
      canvas: dom.canvas,
      drawFrame,
      frameCount: plan.frameCount,
      fileName: exportFileName(plan),
      isCancelled: () => cancelRequested,
      onProgress: ({ frame, total, phase }) => {
        const ratio = frame / total;
        dom.progressFill.style.width = `${(ratio * 100).toFixed(1)}%`;
        const elapsed = (performance.now() - started) / 1000;
        const remaining = ratio > 0.01 ? elapsed / ratio - elapsed : 0;
        dom.progressLabel.textContent =
          phase === 'finishing'
            ? 'Writing file…'
            : `Frame ${frame} of ${total} · ${formatDuration(remaining)} left`;
      },
    };

    const result = state.format === 'png'
      ? await exportPngSequence(common)
      : await exportVideo({
      ...common,
      canvas: dom.canvas,
      drawFrame,
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      format: state.format,
      bitrate: plan.bitrate,
    });

    if (result.cancelled) setStatus('Export cancelled.');
    else if (result.written) setStatus(`Wrote ${result.written} PNG frames to ${result.folder}.`);
    else if (result.savedToDisk) setStatus(`Saved ${result.fileName}.`);
    else setStatus(`Downloaded ${result.fileName} (${(result.size / 1e6).toFixed(0)} MB).`);
  } catch (error) {
    setStatus(error.message ?? String(error), 'error');
  } finally {
    exporting = false;
    dom.exportBtn.disabled = false;
    dom.stillBtn.disabled = false;
    dom.progress.hidden = true;
    layoutFrame();
  }
}

function exportFileName(plan) {
  const base = sourceName.replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9-_ ]/gi, '').trim() || 'heatmap';
  return `${base} ${plan.height}p`.replace(/\s+/g, '-').toLowerCase();
}

async function exportStill() {
  if (exporting) return;
  const plan = exportPlan();
  // Hold the animation loop off the canvas until the PNG has been read back.
  exporting = true;
  try {
    const stillSamples = frameSamples(playhead, 1 / (Number(state.fps) || 30), Math.max(1, state.motionSamples), state.shutter / 360);
    renderer.renderAccumulated(stillSamples, plan.width, plan.height, state.ssaa, 1);
    const blob = await new Promise((resolve) => dom.canvas.toBlob(resolve, 'image/png'));
    if (blob) {
      downloadBlob(blob, `${exportFileName(plan)}.png`);
      setStatus(`Saved a ${plan.width} × ${plan.height} still.`);
    }
  } finally {
    exporting = false;
    layoutFrame();
  }
}

/* -------------------------------------------------------------------- utils */

/** Keyframes land on frame boundaries so they stay reproducible in the export. */
function snapTime(t) {
  const fps = Number(state.fps) || 30;
  return Math.round(t * fps) / fps;
}

function applyTimelineCollapsed() {
  dom.timeline.classList.toggle('is-collapsed', state.timelineCollapsed);
  dom.tlToggle.setAttribute('aria-expanded', String(!state.timelineCollapsed));
}

function applyTheme() {
  const theme = state.theme === 'auto' ? '' : state.theme;
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const dark =
    state.theme === 'dark' ||
    (state.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  dom.themeIcon.textContent = dark ? '☀' : '☾';
  dom.themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeHex(input) {
  let value = String(input).replace('#', '').trim();
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(value)) return '#000000';
  return `#${value.toLowerCase()}`;
}

function setStatus(message, tone) {
  dom.status.textContent = message;
  if (tone) dom.status.dataset.tone = tone;
  else delete dom.status.dataset.tone;
}

let reprocessTimer = 0;
function scheduleReprocess() {
  clearTimeout(reprocessTimer);
  reprocessTimer = setTimeout(reprocess, 180);
}

function onParamsChanged(key) {
  if (key === 'edgeSoftness' || key === 'glowSpread') scheduleReprocess();
  if (key === 'background') layoutFrame();
  if (key === 'speed') {
    rebuildTimeMap();
    updateExportHint();
  }
  if (key === 'shutter') updateQualityHint();
  save();
}

function save() {
  const snapshot = {};
  for (const key of Object.keys(DEFAULTS)) snapshot[key] = state[key];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* private mode, not worth surfacing */
  }
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    // 'auto' was the old default and the toggle never writes it, so a stored
    // 'auto' is a leftover rather than a choice — let the dark default win.
    if (parsed.theme === 'auto') delete parsed.theme;
    return parsed;
  } catch {
    return {};
  }
}

/* --------------------------------------------------------------------- boot */

function buildResolutionOptions() {
  dom.resPreset.textContent = '';
  for (const preset of RESOLUTIONS) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.label;
    dom.resPreset.append(option);
  }
  dom.resPreset.value = state.exportPreset;
  dom.customSize.hidden = state.exportPreset !== 'custom';
}

function wireEvents() {
  dom.pickImageBtn.addEventListener('click', () => dom.fileInput.click());
  dom.fileInput.addEventListener('change', () => {
    const file = dom.fileInput.files?.[0];
    if (file) loadImageFile(file);
    dom.fileInput.value = '';
  });

  // The veil follows the drag directly instead of counting enter/leave pairs,
  // which drop out of balance whenever a drag ends off-window.
  let dragTimer = 0;
  const hideVeil = () => {
    clearTimeout(dragTimer);
    dragTimer = 0;
    dom.dropveil.hidden = true;
  };
  const showVeil = (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    dom.dropveil.hidden = false;
    clearTimeout(dragTimer);
    // No dragover for a moment means the drag left the window or was cancelled.
    dragTimer = setTimeout(hideVeil, 300);
  };
  window.addEventListener('dragenter', showVeil);
  window.addEventListener('dragover', showVeil);
  window.addEventListener('dragleave', () => {
    clearTimeout(dragTimer);
    dragTimer = setTimeout(hideVeil, 300);
  });
  window.addEventListener('dragend', hideVeil);
  window.addEventListener('blur', hideVeil);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideVeil();
  });
  window.addEventListener('drop', (event) => {
    event.preventDefault();
    hideVeil();
    const file = event.dataTransfer?.files?.[0];
    if (file) loadImageFile(file);
  });

  dom.fit.addEventListener('change', () => {
    state.fit = dom.fit.value;
    save();
  });

  dom.shapeSource.addEventListener('change', () => {
    state.shapeSource = dom.shapeSource.value;
    save();
    reprocess();
  });

  dom.addColorBtn.addEventListener('click', () => {
    if (state.colors.length >= 10) return;
    state.colors.push({ hex: '#6078CA', alpha: 1 });
    buildColors();
    onParamsChanged('colors');
  });

  dom.flipColorsBtn.addEventListener('click', () => {
    state.colors.reverse();
    buildColors();
    onParamsChanged('colors');
  });

  dom.resetBtn.addEventListener('click', () => {
    const theme = state.theme;
    Object.assign(state, structuredClone(DEFAULTS));
    state.theme = theme;
    playhead = 0;
    rebuildTimeMap();
    buildSliders(dom.shapeParams, SHAPE_CONTROLS);
    buildSliders(dom.qualityParams, QUALITY_CONTROLS);
    buildSliders(dom.params, PARAM_CONTROLS);
    buildSliders(dom.layout, LAYOUT_CONTROLS);
    buildColors();
    buildResolutionOptions();
    syncExportInputs();
    dom.shapeSource.value = state.shapeSource;
    timelineUI?.refresh();
    layoutFrame();
    updateExportHint();
    save();
    reprocess();
    setStatus('Back to the reference settings.');
  });

  dom.playBtn.addEventListener('click', () => {
    playing = !playing;
    dom.playIcon.textContent = playing ? 'Pause' : 'Play';
    dom.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  });

  dom.scrub.addEventListener('pointerdown', () => {
    scrubbing = true;
  });
  window.addEventListener('pointerup', () => {
    scrubbing = false;
  });
  dom.scrub.addEventListener('input', () => {
    setPlayhead((Number(dom.scrub.value) / 1000) * timelineDuration());
  });

  dom.resPreset.addEventListener('change', () => {
    state.exportPreset = dom.resPreset.value;
    dom.customSize.hidden = state.exportPreset !== 'custom';
    layoutFrame();
    updateExportHint();
    save();
  });

  for (const [input, key] of [
    [dom.customW, 'exportWidth'],
    [dom.customH, 'exportHeight'],
  ]) {
    input.addEventListener('change', () => {
      state[key] = clamp(Number(input.value) || DEFAULTS[key], 16, 7680);
      input.value = String(state[key]);
      layoutFrame();
      updateExportHint();
      save();
    });
  }

  dom.fps.addEventListener('change', () => {
    state.fps = Number(dom.fps.value);
    updateExportHint();
    save();
  });

  dom.duration.addEventListener('change', () => {
    state.duration = clamp(Number(dom.duration.value) || 1, 0.1, 600);
    updateExportHint();
    save();
  });

  dom.snapLoop.addEventListener('change', () => {
    state.snapLoop = dom.snapLoop.checked;
    updateExportHint();
    save();
  });

  dom.format.addEventListener('change', () => {
    state.format = dom.format.value;
    dom.quality.disabled = state.format === 'png';
    updateExportHint();
    save();
  });

  dom.quality.addEventListener('change', () => {
    state.quality = dom.quality.value;
    updateExportHint();
    save();
  });

  dom.themeBtn.addEventListener('click', () => {
    const dark =
      state.theme === 'dark' ||
      (state.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    state.theme = dark ? 'light' : 'dark';
    applyTheme();
    save();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.theme === 'auto') applyTheme();
  });

  dom.tlDuration.addEventListener('change', () => {
    const value = Number(dom.tlDuration.value);
    state.timelineDuration = Number.isFinite(value) && value > 0 ? clamp(value, 0.2, 600) : 0;
    rebuildTimeMap();
    setPlayhead(Math.min(playhead, timelineDuration()));
    updateExportHint();
    save();
  });

  dom.tlClear.addEventListener('click', () => {
    state.keyframes = {};
    rebuildTimeMap();
    syncAllSliders();
    timelineUI?.refresh();
    updateExportHint();
    save();
    setStatus('Keyframes cleared.');
  });

  for (const [input, key] of [
    [dom.ssaa, 'ssaa'],
    [dom.motionSamples, 'motionSamples'],
  ]) {
    input.addEventListener('change', () => {
      state[key] = Number(input.value);
      updateQualityHint();
      updateExportHint();
      save();
    });
  }

  dom.exportBtn.addEventListener('click', runExport);
  dom.stillBtn.addEventListener('click', exportStill);
  dom.cancelBtn.addEventListener('click', () => {
    cancelRequested = true;
  });

  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (event.code === 'Space') {
      event.preventDefault();
      dom.playBtn.click();
    }
  });

  dom.tlToggle.addEventListener('click', () => {
    state.timelineCollapsed = !state.timelineCollapsed;
    applyTimelineCollapsed();
    layoutFrame();
    save();
  });

  const observer = new ResizeObserver(() => layoutFrame());
  observer.observe(dom.stageInner);
  observer.observe(dom.timeline);
  window.addEventListener('resize', layoutFrame);
}

function syncExportInputs() {
  dom.customW.value = String(state.exportWidth);
  dom.customH.value = String(state.exportHeight);
  dom.fps.value = String(state.fps);
  dom.ssaa.value = String(state.ssaa);
  dom.motionSamples.value = String(state.motionSamples);
  dom.duration.value = String(state.duration);
  dom.snapLoop.checked = state.snapLoop;
  dom.format.value = state.format;
  dom.quality.value = state.quality;
  dom.shapeSource.value = state.shapeSource;
  dom.fit.value = state.fit;
}

async function boot() {
  try {
    renderer = new HeatmapRenderer(dom.canvas);
  } catch (error) {
    setStatus(error.message, 'error');
    return;
  }
  renderer.setImage(null);

  if (!state.keyframes || typeof state.keyframes !== 'object') state.keyframes = {};
  applyTheme();
  applyTimelineCollapsed();
  rebuildTimeMap();

  buildSliders(dom.shapeParams, SHAPE_CONTROLS);
  buildSliders(dom.qualityParams, QUALITY_CONTROLS);
  buildSliders(dom.params, PARAM_CONTROLS);
  buildSliders(dom.layout, LAYOUT_CONTROLS);
  buildColors();
  buildResolutionOptions();
  syncExportInputs();

  timelineUI = createTimelineUI({
    root: dom.timelineBody,
    state,
    getDuration: timelineDuration,
    getPlayhead: () => playhead,
    setPlayhead,
    getFps: () => Number(state.fps) || 30,
    formatValue,
    onChange: () => {
      rebuildTimeMap();
      syncAllSliders();
      updateExportHint();
      layoutFrame();
      save();
    },
  });
  timelineUI.refresh();

  wireEvents();
  layoutFrame();
  updateExportHint();
  updateQualityHint();
  rafHandle = requestAnimationFrame(tick);

  try {
    const image = await loadImage(DEFAULT_SHAPE);
    await applyImage(image, DEFAULT_SHAPE);
  } catch {
    setStatus('Default shape failed to load — drop an image to start.', 'error');
  }
}

boot();
