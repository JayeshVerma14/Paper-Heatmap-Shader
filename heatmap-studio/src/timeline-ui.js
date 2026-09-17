// The timeline strip: ruler, playhead, one lane per animated parameter, and
// direct manipulation of keys (click to select, drag to retime, Delete to remove).

import { ANIMATABLE, EASINGS, hasKeys, removeKey } from './timeline.js';

const TICK_TARGET = 90; // px between ruler labels

export function createTimelineUI(options) {
  const {
    root,
    state,
    getDuration,
    getPlayhead,
    setPlayhead,
    getFps,
    onChange,
    formatValue,
  } = options;

  const lanes = new Map();
  let selected = null; // { key, t }

  // The ruler is indented by the label gutter so it shares one time axis with
  // the lanes, and the playhead overlays that same axis across every row.
  root.innerHTML = `
    <div class="tl-grid">
      <div class="tl-axis"><div class="tl-playhead" id="tlPlayhead"></div></div>
      <div class="tl-ruler" id="tlRuler">
        <div class="tl-ticks" id="tlTicks"></div>
      </div>
      <div class="tl-tracks" id="tlTracks"></div>
    </div>
    <div class="tl-inspector" id="tlInspector" hidden>
      <span class="tl-inspector-label" id="tlSelLabel"></span>
      <label class="tl-inspector-field">
        <span class="field-label">Easing</span>
        <select class="select select-sm" id="tlEase"></select>
      </label>
      <button type="button" class="btn btn-sm" id="tlDelete">Delete key</button>
    </div>
    <p class="hint tl-empty" id="tlEmpty">
      No keyframes yet — press the ◆ next to any parameter to key it at the playhead.
    </p>
  `;

  const ruler = root.querySelector('#tlRuler');
  const ticks = root.querySelector('#tlTicks');
  const playhead = root.querySelector('#tlPlayhead');
  const tracks = root.querySelector('#tlTracks');
  const inspector = root.querySelector('#tlInspector');
  const selLabel = root.querySelector('#tlSelLabel');
  const easeSelect = root.querySelector('#tlEase');
  const deleteBtn = root.querySelector('#tlDelete');
  const empty = root.querySelector('#tlEmpty');

  for (const [value, { label }] of Object.entries(EASINGS)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    easeSelect.append(option);
  }

  /* ---------------------------------------------------------------- seeking */

  const seekFromEvent = (event, element) => {
    const box = element.getBoundingClientRect();
    const ratio = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
    setPlayhead(ratio * getDuration());
  };

  let seeking = false;
  const startSeek = (event, element) => {
    seeking = true;
    element.setPointerCapture?.(event.pointerId);
    seekFromEvent(event, element);
  };
  ruler.addEventListener('pointerdown', (event) => startSeek(event, ruler));
  ruler.addEventListener('pointermove', (event) => {
    if (seeking) seekFromEvent(event, ruler);
  });
  window.addEventListener('pointerup', () => {
    seeking = false;
  });

  /* ------------------------------------------------------------ key dragging */

  let dragging = null;

  const onPointerMove = (event) => {
    if (!dragging) return;
    const box = dragging.lane.getBoundingClientRect();
    const duration = getDuration();
    const fps = getFps();
    const ratio = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
    const snapped = Math.round(ratio * duration * fps) / fps;
    const track = state.keyframes[dragging.key];
    const node = track?.find((k) => Math.abs(k.t - dragging.t) < 1e-3);
    if (!node) return;
    // Don't let two keys land on the same frame.
    if (track.some((k) => k !== node && Math.abs(k.t - snapped) < 1e-3)) return;
    node.t = snapped;
    dragging.t = snapped;
    track.sort((a, b) => a.t - b.t);
    selected = { key: dragging.key, t: snapped };
    setPlayhead(snapped);
    onChange();
    refresh();
  };

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', () => {
    dragging = null;
  });

  window.addEventListener('keydown', (event) => {
    if (!selected) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      removeKey(state, selected.key, selected.t);
      selected = null;
      onChange();
      refresh();
    }
  });

  easeSelect.addEventListener('change', () => {
    if (!selected) return;
    const node = state.keyframes[selected.key]?.find((k) => Math.abs(k.t - selected.t) < 1e-3);
    if (node) {
      node.ease = easeSelect.value;
      onChange();
      refresh();
    }
  });

  deleteBtn.addEventListener('click', () => {
    if (!selected) return;
    removeKey(state, selected.key, selected.t);
    selected = null;
    onChange();
    refresh();
  });

  /* ------------------------------------------------------------------ render */

  function buildTicks(duration) {
    const width = ruler.clientWidth || 600;
    const targetCount = Math.max(2, Math.round(width / TICK_TARGET));
    const raw = duration / targetCount;
    const nice = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60].find((n) => n >= raw) ?? 60;
    ticks.textContent = '';
    for (let t = 0; t <= duration + 1e-6; t += nice) {
      const tick = document.createElement('span');
      tick.className = 'tl-tick';
      tick.style.left = `${(t / duration) * 100}%`;
      tick.textContent = `${t.toFixed(nice < 1 ? 1 : 0)}s`;
      ticks.append(tick);
    }
  }

  function laneFor(entry) {
    let lane = lanes.get(entry.key);
    if (lane) return lane;

    const row = document.createElement('div');
    row.className = 'tl-track';
    const name = document.createElement('span');
    name.className = 'tl-name';
    name.textContent = entry.label;
    const strip = document.createElement('div');
    strip.className = 'tl-lane';
    strip.addEventListener('pointerdown', (event) => {
      if (event.target === strip) {
        selected = null;
        startSeek(event, strip);
        refresh();
      }
    });
    strip.addEventListener('pointermove', (event) => {
      if (seeking) seekFromEvent(event, strip);
    });
    row.append(name, strip);
    lane = { row, strip };
    lanes.set(entry.key, lane);
    return lane;
  }

  function refresh() {
    const duration = getDuration();
    const time = getPlayhead();
    playhead.style.left = `${(time / duration) * 100}%`;
    buildTicks(duration);

    let visible = 0;
    for (const entry of ANIMATABLE) {
      const lane = laneFor(entry);
      if (!hasKeys(state, entry.key)) {
        lane.row.remove();
        continue;
      }
      visible++;
      if (!lane.row.isConnected) tracks.append(lane.row);

      lane.strip.textContent = '';
      for (const node of state.keyframes[entry.key]) {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'tl-key';
        if (selected && selected.key === entry.key && Math.abs(selected.t - node.t) < 1e-3) {
          dot.classList.add('is-selected');
        }
        dot.style.left = `${(node.t / duration) * 100}%`;
        dot.title = `${entry.label} ${formatValue(node.v, entry.format)} @ ${node.t.toFixed(2)}s`;
        dot.setAttribute('aria-label', dot.title);
        dot.addEventListener('pointerdown', (event) => {
          event.stopPropagation();
          selected = { key: entry.key, t: node.t };
          dragging = { key: entry.key, t: node.t, lane: lane.strip };
          setPlayhead(node.t);
          refresh();
        });
        lane.strip.append(dot);
      }
    }

    empty.hidden = visible > 0;
    tracks.hidden = visible === 0;

    if (selected) {
      const entry = ANIMATABLE.find((a) => a.key === selected.key);
      const node = state.keyframes[selected.key]?.find((k) => Math.abs(k.t - selected.t) < 1e-3);
      if (entry && node) {
        inspector.hidden = false;
        selLabel.textContent = `${entry.label} · ${formatValue(node.v, entry.format)} @ ${node.t.toFixed(2)}s`;
        easeSelect.value = node.ease ?? 'inout';
      } else {
        selected = null;
        inspector.hidden = true;
      }
    } else {
      inspector.hidden = true;
    }
  }

  function select(key, t) {
    selected = key ? { key, t } : null;
    refresh();
  }

  return { refresh, select };
}
