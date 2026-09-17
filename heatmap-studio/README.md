# Heatmap Studio

Paper's **heatmap** shader running locally, with a 4K video export that Paper's own
export doesn't give you. Drop in a shape, tune the parameters, export an MP4.

## Run it

```bash
node serve.mjs
```

`vendor/mp4-muxer.js` and `vendor/webm-muxer.js` must be present — the export
imports them. If the folder ever goes missing (some tools skip `vendor/` when
copying), refetch the two files:

```bash
curl -o vendor/mp4-muxer.js https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.mjs
curl -o vendor/webm-muxer.js https://cdn.jsdelivr.net/npm/webm-muxer@5.1.4/build/webm-muxer.mjs
```

Then open <http://localhost:5178> — Chrome or Edge (the export needs WebCodecs).
No install, no build step, no dependencies.

## How the effect works

The shader never reads your image directly. On load, the image is composited onto a
white field, padded, and blurred three ways into one RGB texture:

| channel | blur | what the shader uses it for |
| --- | --- | --- |
| R | 5px | the shape mask itself |
| G | 150px ×3 | the falloff for inner and outer glow |
| B | 18px ×3 | the tight band that draws the contour line |

Three phase-shifted copies of a travelling "shadow" blob sweep across the shape and
carve the heat out of it; the heat value is then mapped through your colour ramp.
Because the three copies are offset by exactly a third of the cycle, **the animation
repeats every 10/3 seconds of shader time** — i.e. `3.333 / speed` real seconds. That
is what "Snap to a seamless loop" uses.

Source of truth for the shader and the pre-processing:
[paper-design/shaders](https://github.com/paper-design/shaders) — `heatmap.ts`,
`vertex-shader.ts`. Both are ported verbatim, so a given set of parameters renders
the same here as it does in Paper.

## Controls

**Shape from** — Paper builds the mask from *luminance over white*, so dark artwork
becomes the shape and a white logo on transparency would disappear. `Auto` keeps
Paper's behaviour but switches to the alpha channel when the artwork is light.
Force either with `Alpha channel` or `Light artwork`.

**Edge softness / Glow spread** — the two knobs Paper does not expose, and the
only real answer to "it looks blurry". Paper's blur radii are relative to the mask
(5px shape, 18px contour, 150px glow on a 1000px canvas), so the softness scales
with output size: at 3840px wide that 150px falloff becomes ~575px of glow. Edge
softness scales the shape + contour radii, glow spread scales the falloff. 100% on
both is exactly Paper. Edge softness goes all the way to **0%**, which skips those
blur passes entirely — the mask is then the raw artwork, so edges are as hard as
the source's own antialiasing (and the contour band disappears with them). Changing either rebuilds the mask (a few hundred ms, off the
main thread).

Raising the mask resolution does *not* help — measured edge gradient at 4K is
identical at a 1000, 2000 or 3000px working canvas, because every radius is
proportional to it. That path was tried and removed.

**Parameters** — the same seven Paper exposes. Angle only has an effect when one of
the glows is above zero. Type a value into the box to go past a slider's range
(scale accepts up to 400%).

**Foreground** — the colour ramp, **hottest at the top**, the way Paper's panel reads
it. Internally the shader ramps coldest-first, so the list is reversed on the way in;
`Flip order` swaps it if your ramp looks inverted. Up to 10 colours.

## Timeline and keyframes

Every shader parameter is keyframable: angle, noise, inner glow, outer glow,
contour, speed, scale, rotation and both offsets. Press the **◆** beside a
parameter to key it at the playhead; once a parameter has keys, moving its slider
writes a key at the playhead instead of changing the static value (auto-key), and
the slider reads back the animated value as the playhead moves.

The strip collapses from its header when you want the preview back, the lane area
scrolls once more than a handful of parameters are keyed, and the preview is sized
around it — the timeline and the preview always fit on screen together.

On the timeline strip: drag the ruler or a lane to scrub, drag a key to retime it
(snapped to the frame grid), click one to pick its easing — linear, ease in, ease
out, ease in out, hold — and Delete to remove it. **Length** sets the timeline
duration; it defaults to one shader loop.

Edge softness and glow spread are *not* keyframable: they rebuild the mask on the
CPU, which is far too slow for per-frame animation.

`speed` is special. It scales the shader clock, so `u_time` is the integral of
speed over timeline time, sampled on a fixed 240 Hz grid that the preview and the
export both read — a keyframed speed ramps the animation smoothly instead of
jumping, and the export matches the preview exactly.

Once any key exists the export follows the timeline: duration comes from the
timeline length and every frame resolves its own parameters. With no keys, the
old fixed-step path runs, so seamless-loop snapping still works.

## Theme

Light, dark, or whatever the OS asks for. The button in the top bar cycles
light/dark and the choice is remembered; with nothing chosen it follows
`prefers-color-scheme`. Dark neutrals keep the warm bias (R > B) rather than going
blue-grey.

## Quality

**Supersampling** renders each frame at 2×/3×/4× and boxes it back down. With edge
softness at 0 the mask edge is hard, and a hard edge aliases at 4K — measured edge
roughness drops 42% at 2× and 54% at 3×. This is the setting that matters.

**Motion blur** accumulates N sub-frames across a shutter angle into a float
buffer, each sub-frame resolving its own keyframed parameters. It is real temporal
sampling, not a post-effect — but measure before you pay for it: the base sweep
advances less than 1% of its cycle per frame, so blur changes nothing there
(measured: identical inter-frame difference at 1 and 8 steps). On a fast keyframed
move (rotation at 12°/frame) 8 steps cut the inter-frame jump by 10%. Default off.

Cost is real: one 4K pass is ~90ms on integrated graphics, so passes multiply
directly. The panel estimates total render time from a two-point calibration of
this GPU, and playback drops to a four-pass budget so the preview stays live —
full quality renders the moment the playhead stops.

Rejected after measuring: an extra dither in the resolve pass (Paper's shader
already adds ~2.5 levels of noise, so banding was unchanged) and AV1 4:4:4
(`isConfigSupported` reports it, then `configure()` throws — it is not really
there).

## Export

- **Resolution** — 4K UHD by default; the preview frame always matches the export
  aspect ratio, so what you see is what gets written.
- **Snap to a seamless loop** — rounds the duration to a whole number of cycles and
  nudges the per-frame time step so the last frame lands exactly one period from the
  first. Turn it off for an arbitrary length.
- **Format** — MP4/H.264 for editors, WebM/VP9 as a fallback, or **PNG frames** for
  a lossless master: no codec, no chroma subsampling, and alpha survives if you drop
  the background opacity. Pick a folder and it writes `name_0001.png` per frame
  (~1.4 GB for a 5.5s 4K loop). If the browser offers a
  save dialog the file is streamed straight to disk; otherwise it downloads.
- **Export still** — a PNG at the export resolution, alpha preserved if you drop the
  background opacity.

Every frame is rendered and encoded in turn — nothing is screen-captured, so no frames
are dropped and the motion is identical to the preview. Expect roughly 100 ms per 4K
frame (about 20 s for a 5.5 s loop) on integrated graphics.

## Layout

```
index.html        UI shell
styles.css        design tokens + controls
src/glsl.js       vertex + fragment shader (verbatim port)
src/preprocess.js image -> 3-channel blur texture (Paper's port + softness knobs)
src/blur.js       integral-image box blurs
src/preprocess-worker.js  runs the blurs off the UI thread
src/timeline.js   keyframe sampling, easings, the speed integral
src/timeline-ui.js ruler, lanes, key dragging
src/renderer.js   WebGL2 mount, deterministic time
src/export.js     WebCodecs encode + MP4/WebM muxing
vendor/           mp4-muxer, webm-muxer (ESM builds)
```
