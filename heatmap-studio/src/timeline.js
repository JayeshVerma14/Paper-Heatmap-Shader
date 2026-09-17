// Keyframe evaluation. Tracks are sorted arrays of { t, v, ease }, where `ease`
// describes the segment leaving that key.

export const EASINGS = {
  linear: { label: 'Linear', fn: (u) => u },
  in: { label: 'Ease in', fn: (u) => u * u },
  out: { label: 'Ease out', fn: (u) => 1 - (1 - u) * (1 - u) },
  inout: { label: 'Ease in out', fn: (u) => (u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u)) },
  hold: { label: 'Hold', fn: () => 0 },
};

/** Parameters that are plain shader uniforms, so they can change every frame. */
export const ANIMATABLE = [
  { key: 'angle', label: 'Angle', format: 'deg' },
  { key: 'noise', label: 'Noise', format: 'pct' },
  { key: 'innerGlow', label: 'Inner glow', format: 'pct' },
  { key: 'outerGlow', label: 'Outer glow', format: 'pct' },
  { key: 'contour', label: 'Contour', format: 'pct' },
  { key: 'speed', label: 'Speed', format: 'pct' },
  { key: 'scale', label: 'Scale', format: 'pct' },
  { key: 'rotation', label: 'Rotation', format: 'deg' },
  { key: 'offsetX', label: 'Offset X', format: 'num' },
  { key: 'offsetY', label: 'Offset Y', format: 'num' },
];

export const ANIMATABLE_KEYS = ANIMATABLE.map((a) => a.key);

/** Value of a track at time t. Holds flat before the first and after the last key. */
export function sampleTrack(keys, t) {
  if (!keys || keys.length === 0) return null;
  if (keys.length === 1 || t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;

  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.t - a.t;
  if (span <= 0) return b.v;
  const u = (t - a.t) / span;
  const ease = (EASINGS[a.ease] ?? EASINGS.inout).fn;
  return a.v + (b.v - a.v) * ease(u);
}

/** Resolved value of one parameter: the track if it has keys, else the static value. */
export function paramAt(state, key, t) {
  const track = state.keyframes?.[key];
  const sampled = sampleTrack(track, t);
  return sampled === null ? state[key] : sampled;
}

export function hasKeys(state, key) {
  return Boolean(state.keyframes?.[key]?.length);
}

export function anyKeys(state) {
  return ANIMATABLE_KEYS.some((key) => hasKeys(state, key));
}

/** Insert or replace the key at `t` (within a frame's tolerance). */
export function setKey(state, key, t, value, ease = 'inout') {
  const track = (state.keyframes[key] ??= []);
  const existing = track.find((k) => Math.abs(k.t - t) < 1e-3);
  if (existing) {
    existing.v = value;
  } else {
    track.push({ t, v: value, ease });
    track.sort((a, b) => a.t - b.t);
  }
  return track;
}

export function removeKey(state, key, t) {
  const track = state.keyframes?.[key];
  if (!track) return;
  const index = track.findIndex((k) => Math.abs(k.t - t) < 1e-3);
  if (index >= 0) track.splice(index, 1);
  if (track.length === 0) delete state.keyframes[key];
}

export function keyAt(state, key, t) {
  return state.keyframes?.[key]?.find((k) => Math.abs(k.t - t) < 1e-3) ?? null;
}

/**
 * u_time is the integral of speed over timeline time, so a keyframed speed still
 * produces a continuous, monotonic shader clock. Sampled on a fixed grid so the
 * preview and the export agree exactly.
 */
export function buildTimeMap(state, duration, rate = 240) {
  const steps = Math.max(2, Math.ceil(duration * rate) + 1);
  const dt = duration / (steps - 1);
  const values = new Float32Array(steps);
  let acc = 0;
  let previous = Math.max(0, paramAt(state, 'speed', 0));
  for (let i = 1; i < steps; i++) {
    const speed = Math.max(0, paramAt(state, 'speed', i * dt));
    acc += 0.5 * (previous + speed) * dt;
    values[i] = acc;
    previous = speed;
  }
  return { values, dt, duration, total: acc };
}

export function sampleTimeMap(map, t) {
  if (!map) return 0;
  const clamped = Math.min(Math.max(t, 0), map.duration);
  const position = clamped / map.dt;
  const i = Math.min(map.values.length - 2, Math.floor(position));
  const u = position - i;
  return map.values[i] + (map.values[i + 1] - map.values[i]) * u;
}
