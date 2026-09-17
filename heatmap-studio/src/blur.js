// Blur passes for the shape pre-processing. Shared by the main thread and the
// worker, so the heavy part can run off the UI thread.

/** Box blur via an integral image — O(n) per pass regardless of radius. */
export function blurGray(gray, width, height, radius) {
  if (radius <= 0) return gray.slice();

  const out = new Uint8ClampedArray(width * height);
  const integral = new Uint32Array(width * height);

  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      rowSum += gray[idx];
      integral[idx] = rowSum + (y > 0 ? integral[idx - width] : 0);
    }
  }

  for (let y = 0; y < height; y++) {
    const y1 = Math.max(0, y - radius);
    const y2 = Math.min(height - 1, y + radius);
    const rowA = y2 * width;
    const rowC = (y1 - 1) * width;
    for (let x = 0; x < width; x++) {
      const x1 = Math.max(0, x - radius);
      const x2 = Math.min(width - 1, x + radius);

      const A = integral[rowA + x2];
      const B = x1 > 0 ? integral[rowA + x1 - 1] : 0;
      const C = y1 > 0 ? integral[rowC + x2] : 0;
      const D = x1 > 0 && y1 > 0 ? integral[rowC + x1 - 1] : 0;

      const area = (x2 - x1 + 1) * (y2 - y1 + 1);
      out[y * width + x] = Math.round((A - B - C + D) / area);
    }
  }

  return out;
}

/** Repeated box blurs approximate a gaussian. */
export function multiPassBlurGray(gray, width, height, radius, passes) {
  if (radius <= 0 || passes <= 1) return blurGray(gray, width, height, radius);
  let input = gray;
  let tmp = gray;
  for (let p = 0; p < passes; p++) {
    tmp = blurGray(input, width, height, radius);
    input = tmp;
  }
  return tmp;
}

/**
 * Turn the grayscale shape into the RGBA texture the shader samples:
 *   R = shape mask (small blur)
 *   G = glow falloff (large blur, 3 passes)
 *   B = contour band (medium blur, 3 passes)
 * Radii are proportional to `maskSize`, so raising the resolution sharpens the
 * mask without changing how the effect looks.
 */
export function buildChannels(gray, width, height, maskSize, softness = 1, glowSpread = 1) {
  const scale = maskSize / 1000;
  const maxBlur = Math.floor(maskSize * 0.15);
  // `glowSpread` scales the big falloff (the dominant softness in the whole
  // effect); `softness` scales the shape mask and the contour band. Both are 1
  // at Paper's constants. The padding around the artwork is fixed by the
  // shader's hard-coded zoom, so spreads above ~1.5 start clipping.
  // A radius of 0 means "don't blur this channel at all" — at softness 0 the shape
  // mask is the raw artwork, so edges are as hard as the source allows.
  const bigBlurGray = multiPassBlurGray(gray, width, height, Math.max(0, Math.round(maxBlur * glowSpread)), 3);
  const innerBlurGray = multiPassBlurGray(gray, width, height, Math.max(0, Math.round(0.12 * maxBlur * softness)), 3);
  const contourGray = multiPassBlurGray(gray, width, height, Math.max(0, Math.round(5 * scale * softness)), 1);

  const total = width * height;
  const rgba = new Uint8ClampedArray(total * 4);
  for (let i = 0; i < total; i++) {
    const px = i * 4;
    rgba[px] = contourGray[i];
    rgba[px + 1] = bigBlurGray[i];
    rgba[px + 2] = innerBlurGray[i];
    rgba[px + 3] = 255;
  }
  return rgba;
}
