// Runs the blur passes off the UI thread so the preview keeps animating while a
// high-detail mask is built.

import { buildChannels } from './blur.js';

self.onmessage = (event) => {
  const { gray, width, height, maskSize, softness, glowSpread, id } = event.data;
  const rgba = buildChannels(new Uint8ClampedArray(gray), width, height, maskSize, softness, glowSpread);
  self.postMessage({ id, rgba: rgba.buffer, width, height }, [rgba.buffer]);
};
