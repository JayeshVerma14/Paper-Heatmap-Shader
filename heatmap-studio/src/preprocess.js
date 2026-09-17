// Image pre-processing — port of `toProcessedHeatmap` from paper-design/shaders.
//
// The shader does not read the source image directly. It reads a three-channel
// map built on the CPU:
//   R = luma, small blur        -> the shape mask itself (soft edge)
//   G = luma, 0.15 x size, x3   -> the big falloff used for inner + outer glow
//   B = luma, 0.018 x size, x3  -> the tight band that draws the contour line
// The image is drawn onto a white field and padded so the glow has room to fall
// off inside the texture.
//
// Paper hard-codes a 1000px working canvas. Everything here is proportional to
// `maskSize` instead: the padding stays at 1.75x the image (which the shader's
// hard-coded 0.5714 zoom depends on) and every radius scales with it, so a
// larger mask looks identical — it just holds more detail, which is what keeps a
// 4K export from going soft.

import { buildChannels } from './blur.js';

// Paper's working canvas. Raising it does not sharpen anything — measured: the
// edge gradient at 4K is identical at 1000, 2000 and 3000 — because every radius
// is relative to it. Edge crispness comes from EDGE_SOFTNESS instead.
export const MASK_SIZE = 1000;



let worker = null;
let workerJob = 0;

function getWorker() {
  if (worker === null && typeof Worker === 'function') {
    try {
      worker = new Worker(new URL('./preprocess-worker.js', import.meta.url), { type: 'module' });
    } catch {
      worker = false; // fall back to the main thread
    }
  }
  return worker || null;
}

/**
 * @param {HTMLImageElement|ImageBitmap} image
 * @param {'auto'|'luma'|'alpha'|'invert'} shapeSource
 * @param {number} maskSize working canvas size in px
 * @returns {Promise<{data: ImageData, width: number, height: number, aspectRatio: number, mode: string}>}
 */
export async function processImage(image, shapeSource = 'auto', softness = 1, glowSpread = 1, maskSize = MASK_SIZE) {
  const { gray, width, height, mode } = buildGray(image, shapeSource, maskSize);

  const activeWorker = getWorker();
  let rgba;
  if (activeWorker) {
    rgba = await runInWorker(activeWorker, gray, width, height, maskSize, softness, glowSpread);
  } else {
    rgba = buildChannels(gray, width, height, maskSize, softness, glowSpread);
  }

  return {
    data: new ImageData(rgba, width, height),
    width,
    height,
    aspectRatio: width / height,
    mode,
  };
}

function runInWorker(activeWorker, gray, width, height, maskSize, softness, glowSpread) {
  const id = ++workerJob;
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      if (event.data.id !== id) return;
      activeWorker.removeEventListener('message', onMessage);
      activeWorker.removeEventListener('error', onError);
      resolve(new Uint8ClampedArray(event.data.rgba));
    };
    const onError = (error) => {
      activeWorker.removeEventListener('message', onMessage);
      activeWorker.removeEventListener('error', onError);
      reject(error);
    };
    activeWorker.addEventListener('message', onMessage);
    activeWorker.addEventListener('error', onError);
    activeWorker.postMessage({ id, gray: gray.buffer, width, height, maskSize, softness, glowSpread }, [gray.buffer]);
  });
}

/** Rasterise the artwork and reduce it to the single grey channel the blurs run on. */
function buildGray(image, shapeSource, maskSize) {
  const naturalWidth = image.naturalWidth ?? image.width;
  const naturalHeight = image.naturalHeight ?? image.height;
  const ratio = naturalWidth / naturalHeight;

  let imgWidth = maskSize;
  let imgHeight = maskSize;
  if (ratio > 1) imgHeight = Math.floor(maskSize / ratio);
  else imgWidth = Math.floor(maskSize * ratio);

  const padding = Math.ceil(Math.floor(maskSize * 0.15) * 2.5);
  const width = imgWidth + 2 * padding;
  const height = imgHeight + 2 * padding;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Failed to get canvas 2d context');

  // Draw on transparent first so the source's own alpha and luma can be read.
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(image, padding, padding, imgWidth, imgHeight);
  const rawData = ctx.getImageData(0, 0, width, height).data;

  let mode = shapeSource;
  if (mode === 'auto') mode = pickMode(rawData, width * height);

  const total = width * height;
  const gray = new Uint8ClampedArray(total);

  if (mode === 'alpha') {
    // Shape = anything opaque, whatever colour it is.
    for (let i = 0; i < total; i++) gray[i] = 255 - rawData[i * 4 + 3];
  } else {
    // Paper's original path: composite over a flat field, then take luma.
    // 'luma'   -> white field, dark artwork becomes the shape.
    // 'invert' -> black field, light artwork becomes the shape.
    const onWhite = mode !== 'invert';
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = onWhite ? 'white' : 'black';
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';
    const src = ctx.getImageData(0, 0, width, height).data;
    for (let i = 0; i < total; i++) {
      const px = i * 4;
      const luma = (0.299 * src[px] + 0.587 * src[px + 1] + 0.114 * src[px + 2]) | 0;
      gray[i] = onWhite ? luma : 255 - luma;
    }
  }

  return { gray, width, height, mode };
}

/**
 * Luma-on-white is what Paper does, but it erases a light shape on a transparent
 * background. Fall back to the alpha channel only in that case.
 */
function pickMode(rawData, total) {
  let opaque = 0;
  let transparent = 0;
  let lumaSum = 0;
  let sampled = 0;
  const step = 7; // sparse scan, plenty for a yes/no decision
  for (let i = 0; i < total; i += step) {
    const px = i * 4;
    const a = rawData[px + 3];
    sampled++;
    if (a < 250) transparent++;
    if (a > 128) {
      opaque++;
      lumaSum += 0.299 * rawData[px] + 0.587 * rawData[px + 1] + 0.114 * rawData[px + 2];
    }
  }
  if (!opaque) return 'luma';
  const hasTransparency = transparent / sampled > 0.02;
  const meanLuma = lumaSum / opaque;
  return hasTransparency && meanLuma > 160 ? 'alpha' : 'luma';
}
