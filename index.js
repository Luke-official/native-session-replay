/**
 * @fileoverview Session recording and replay system.
 * Captures initial DOM state, mutations, and user interactions to be saved and replayed in an iframe.
 */

/** @constant {string} LocalStorage key for saving interactions */
const STORAGE_KEY = 'latestInteraction';

/** @constant {Object} Colors used for drawing interaction trails */
const COLORS = { move: '#22d3ee', drag: '#ef4444' };

/** @constant {Object} Event listener options for capturing phase */
const CAPTURE = { capture: true };

/**
 * Shorthand for document.getElementById.
 * @param {string} id
 * @returns {HTMLElement|null}
 */
const $ = (id) => document.getElementById(id);

/**
 * References to core UI elements used for recording controls and replay.
 * @type {Object<string, HTMLElement|HTMLCanvasElement>}
 */
const ui = {
  save: $('save-btn'), view: $('view-btn'), clearSaved: $('clear-saved-btn'),
  overlay: $('replay-overlay'), frame: $('replay-frame'), scrub: $('replay-scrub'),
  play: $('replay-play'), time: $('replay-time'), canvas: $('replay-draw'),
};

/** @type {CanvasRenderingContext2D} Context for the replay drawing canvas */
const ctx = ui.canvas.getContext('2d');

/**
 * State object for the active recording session.
 * @type {Object}
 * @property {number} t0 - Initial timestamp of the recording.
 * @property {Array<Object>} events - Array of captured interaction/mutation events.
 * @property {Object|null} snapshot - The initial HTML snapshot of the document.
 * @property {boolean} drawing - Whether the user is currently holding the mouse down to draw/drag.
 * @property {Object|null} dragPoint - The last recorded x/y coordinates of a drag.
 * @property {number} moveFrame - RequestAnimationFrame ID for throttling mouse moves.
 * @property {Object|null} pendingMove - The latest queued mouse movement.
 */
const recorder = {
  t0: performance.now(),
  events: [],
  snapshot: null,
  drawing: false,
  dragPoint: null,
  moveFrame: 0,
  pendingMove: null,
};

/**
 * State object for the active playback/replay session.
 * @type {Object|null}
 */
let replay = null;

/**
 * Calculates the elapsed time since the recording started.
 * @returns {number} Elapsed time in milliseconds.
 */
const timestamp = () => Math.round(performance.now() - recorder.t0);

/**
 * Checks if a node or its ancestors are marked to be excluded from recording.
 * @param {HTMLElement} node
 * @returns {boolean}
 */
const isExcluded = (node) => node?.closest?.('[data-no-record]');

/**
 * Checks if a node is an interactive element (buttons, inputs, etc.).
 * @param {HTMLElement} node
 * @returns {boolean}
 */
const isInteractive = (node) => node?.closest?.('button, input, textarea, select, a, [contenteditable]');

/**
 * Generates an array of child indices representing the tree path to a specific element.
 * Useful for locating the exact same element in the isolated replay iframe.
 * @param {HTMLElement} element
 * @returns {Array<number>}
 */
function domPath(element) {
  const path = [];
  for (let node = element; node && node !== document.body; node = node.parentElement) {
    path.unshift([...node.parentElement.children].indexOf(node));
  }
  return path;
}

/**
 * Pushes a new event to the recording timeline.
 * @param {string} type - The event type (e.g., 'mm', 'mut', 'sc').
 * @param {Object} [data={}] - Associated event data.
 */
function record(type, data = {}) {
  recorder.events.push({ t: timestamp(), type, ...data });
}

/**
 * Captures the current state of the DOM, filtering out excluded elements.
 * @returns {{html: string, head: string, w: number, h: number}} The snapshot payload.
 */
function takeSnapshot() {
  const body = document.body.cloneNode(true);
  body.querySelectorAll('[data-no-record]').forEach((el) => el.remove());
  return { html: body.innerHTML, head: document.head.innerHTML, w: innerWidth, h: innerHeight };
}

/**
 * Calculates the exact child node indices for removed elements in a MutationRecord.
 * @param {MutationRecord} record
 * @returns {Array<number>}
 */
function removedIndices(record) {
  const indices = [];
  let offset = 0;
  for (const node of record.removedNodes) {
    if (node.nodeType !== 1) continue;
    const index = record.nextSibling
      ? [...record.target.childNodes].indexOf(record.nextSibling) + offset
      : record.target.childNodes.length + offset;
    indices.push(index);
    offset++;
  }
  return indices;
}

/**
 * Handles DOM changes observed by the MutationObserver and records them.
 * @param {MutationRecord} record
 */
function recordMutation(record) {
  if (isExcluded(record.target)) return;
  const path = domPath(record.target);

  if (record.type === 'childList') {
    const added = [...record.addedNodes]
      .filter((node) => node.nodeType === 1 && !isExcluded(node))
      .map((node) => ({ i: [...record.target.children].indexOf(node), h: node.outerHTML }));
    const removed = removedIndices(record);
    if (added.length || removed.length) record('mut', { kind: 'child', path, added, removed });
    return;
  }

  if (record.type === 'attributes') {
    record('mut', { kind: 'attr', path, name: record.attributeName, value: record.target.getAttribute(record.attributeName) });
    return;
  }

  if (record.type === 'characterData') {
    record('mut', { kind: 'text', path: domPath(record.target.parentElement), value: record.target.data });
  }
}

/**
 * Queues a mouse movement for recording, throttling it via requestAnimationFrame.
 * @param {{x: number, y: number}} point
 */
function queueMove(point) {
  recorder.pendingMove = point;
  if (recorder.moveFrame) return;
  recorder.moveFrame = requestAnimationFrame(() => {
    record('mm', recorder.pendingMove);
    recorder.moveFrame = 0;
  });
}

/**
 * Records a dragging/drawing motion.
 * @param {number} x
 * @param {number} y
 * @param {boolean} [persist=true] - Whether to record the action permanently.
 */
function dragTo(x, y, persist = true) {
  const { dragPoint } = recorder;
  if (dragPoint && persist) record('dr', { x0: dragPoint.x, y0: dragPoint.y, x1: x, y1: y });
  recorder.dragPoint = { x, y };
}

/**
 * Records a break in the mouse trail (e.g., mouseout or mouseup).
 */
function breakTrail() {
  record('mb');
}

/**
 * Helper to draw a stroke on the replay canvas.
 * @param {number} x0
 * @param {number} y0
 * @param {number} x1
 * @param {number} y1
 * @param {string} color
 * @param {number} width
 */
function strokeLine(x0, y0, x1, y1, color, width) {
  Object.assign(ctx, { strokeStyle: color, lineWidth: width, lineCap: 'round', lineJoin: 'round' });
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

/**
 * Resolves a DOM node from an array of child indices within a specific document.
 * @param {Document} doc - The target document (usually the replay iframe).
 * @param {Array<number>} path - The domPath array.
 * @returns {HTMLElement}
 */
function nodeAt(doc, path) {
  return path.reduce((node, index) => node.children[index], doc.body);
}

/**
 * Clears the canvas and updates its dimensions.
 * @param {number} width
 * @param {number} height
 */
function clearCanvas(width, height) {
  ui.canvas.width = width;
  ui.canvas.height = height;
}

/**
 * Loads the initial HTML snapshot into the replay iframe.
 * @param {Object} snapshot
 * @param {Function} onReady - Callback executed once the iframe is loaded.
 */
function mountReplayDocument(snapshot, onReady) {
  ui.frame.srcdoc = `<!DOCTYPE html><html><head>${snapshot.head}</head><body>${snapshot.html}</body></html>`;
  ui.frame.onload = () => {
    const doc = ui.frame.contentDocument;
    doc.querySelectorAll('[data-no-record]').forEach((el) => el.remove());
    ui.frame.style.width = `${snapshot.w}px`;
    ui.frame.style.height = `${snapshot.h}px`;
    clearCanvas(snapshot.w, snapshot.h);
    onReady(doc);
  };
}

/**
 * Handlers mapping event types to their corresponding replay actions.
 * @type {Object<string, Function>}
 */
const replayHandlers = {
  mm(_doc, { x, y }) { // Mouse Move
    if (replay.trail) strokeLine(replay.trail.x, replay.trail.y, x, y, COLORS.move, 2);
    replay.trail = { x, y };
  },
  mb: () => { replay.trail = null; }, // Mouse Break
  dr(_doc, { x0, y0, x1, y1 }) { // Drag
    strokeLine(x0, y0, x1, y1, COLORS.drag, 3);
  },
  dc: () => { // Draw Clear
    clearCanvas(replay.snapshot.w, replay.snapshot.h);
    replay.trail = null;
  },
  sc(doc, { path, x, y }) { // Scroll
    const target = path ? nodeAt(doc, path) : doc.documentElement;
    target.scrollLeft = x;
    target.scrollTop = y;
  },
  rs(_doc, { w, h }) { // Resize
    ui.frame.style.width = `${w}px`;
    ui.frame.style.height = `${h}px`;
  },
  mut(doc, event) { // DOM Mutation
    if (event.kind === 'child') {
      const parent = nodeAt(doc, event.path);
      for (const index of [...event.removed].sort((a, b) => b - a)) parent.children[index]?.remove();
      for (const { i, h } of event.added) {
        const wrapper = doc.createElement('div');
        wrapper.innerHTML = h;
        parent.insertBefore(wrapper.firstElementChild, parent.children[i] ?? null);
      }
      return;
    }
    const el = nodeAt(doc, event.path);
    if (event.kind === 'attr') {
      event.value == null ? el.removeAttribute(event.name) : el.setAttribute(event.name, event.value);
      return;
    }
    if (event.kind === 'text' && el?.firstChild) el.firstChild.data = event.value;
  },
};

/**
 * Applies all recorded events up to a specific timestamp in the replay iframe.
 * @param {Document} doc - The iframe document.
 * @param {number} ms - Target timestamp in milliseconds.
 */
function applyEventsUpTo(doc, ms) {
  replay.index = 0;
  replay.trail = null;
  clearCanvas(replay.snapshot.w, replay.snapshot.h);

  for (const event of replay.events) {
    if (event.t > ms) break;
    replayHandlers[event.type]?.(doc, event);
    replay.index++;
  }

  replay.offset = ms;
  ui.scrub.value = ms;
  ui.time.textContent = `${formatTime(ms)} / ${formatTime(replay.duration)}`;
}

/**
 * Formats milliseconds into an M:SS string.
 * @param {number} ms
 * @returns {string}
 */
function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

/**
 * Syncs the disabled states of UI buttons depending on whether a recording exists in localStorage.
 */
function syncSavedState() {
  const hasSaved = !!localStorage.getItem(STORAGE_KEY);
  ui.view.disabled = ui.clearSaved.disabled = !hasSaved;
}

/**
 * Pauses the ongoing replay playback.
 */
function pauseReplay() {
  if (!replay?.playing) return;
  replay.playing = false;
  replay.offset = Number(ui.scrub.value);
  cancelAnimationFrame(replay.frameId);
  ui.play.textContent = 'Play';
}

/**
 * Starts or resumes the replay playback.
 */
function startReplay() {
  replay.playing = true;
  replay.startedAt = performance.now();
  ui.play.textContent = 'Pause';
  tickReplay();
}

/**
 * Seeks to a specific point in the replay timeline.
 * Reloads the base document and fast-forwards events up to the target time.
 * @param {number} ms
 * @param {boolean} [resume=false] - Whether to immediately play after seeking.
 */
function seekReplay(ms, resume = false) {
  if (!replay) return;
  pauseReplay();
  mountReplayDocument(replay.snapshot, (doc) => {
    replay.doc = doc;
    applyEventsUpTo(doc, ms);
    if (resume) startReplay();
  });
}

/**
 * The main playback loop, driven by requestAnimationFrame.
 */
function tickReplay() {
  if (!replay?.playing) return;

  const ms = performance.now() - replay.startedAt + replay.offset;
  if (ms >= replay.duration) {
    replay.playing = false;
    ui.play.textContent = 'Play';
    applyEventsUpTo(replay.doc, replay.duration);
    return;
  }

  const { doc, events } = replay;
  while (replay.index < events.length && events[replay.index].t <= ms) {
    replayHandlers[events[replay.index].type]?.(doc, events[replay.index]);
    replay.index++;
  }

  ui.scrub.value = ms;
  ui.time.textContent = `${formatTime(ms)} / ${formatTime(replay.duration)}`;
  replay.frameId = requestAnimationFrame(tickReplay);
}

/**
 * Closes the replay overlay and halts playback.
 */
function closeReplay() {
  pauseReplay();
  replay = null;
  ui.overlay.classList.remove('open');
  ui.frame.srcdoc = '';
}

// ----------------------------------------------------------------------------
// Initialization & Event Listeners
// ----------------------------------------------------------------------------

recorder.snapshot = takeSnapshot();

new MutationObserver((records) => records.forEach(recordMutation)).observe(document.body, {
  childList: true, subtree: true, attributes: true, characterData: true,
});

document.addEventListener('mousemove', (event) => {
  if (isExcluded(event.target)) return;
  if (recorder.drawing) return dragTo(event.clientX, event.clientY);
  queueMove({ x: event.clientX, y: event.clientY });
}, CAPTURE);

document.addEventListener('mouseout', (event) => {
  if (!event.relatedTarget) breakTrail();
});

document.addEventListener('scroll', (event) => {
  if (isExcluded(event.target)) return;
  const target = event.target === document ? document.documentElement : event.target;
  record('sc', {
    path: event.target === document ? null : domPath(target),
    x: target.scrollLeft,
    y: target.scrollTop,
  });
}, CAPTURE);

document.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || isExcluded(event.target) || isInteractive(event.target)) return;
  recorder.drawing = true;
  recorder.dragPoint = null;
  breakTrail();
  dragTo(event.clientX, event.clientY, false);
}, CAPTURE);

document.addEventListener('mouseup', () => {
  if (recorder.drawing) breakTrail();
  recorder.drawing = false;
  recorder.dragPoint = null;
});

addEventListener('resize', () => record('rs', { w: innerWidth, h: innerHeight }));

// UI Bindings
$('demo-btn').addEventListener('click', (event) => {
  const count = Number(event.target.dataset.count || 0) + 1;
  event.target.dataset.count = count;
  event.target.textContent = `Clicked ${count}x`;
});

$('reset-btn').addEventListener('click', () => record('dc'));

ui.save.addEventListener('click', () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    snapshot: recorder.snapshot,
    events: recorder.events,
  }));
  syncSavedState();
  ui.save.textContent = 'Saved!';
  setTimeout(() => { ui.save.textContent = 'Save interaction'; }, 1500);
});

ui.clearSaved.addEventListener('click', () => {
  localStorage.removeItem(STORAGE_KEY);
  syncSavedState();
  if (ui.overlay.classList.contains('open')) closeReplay();
});

ui.view.addEventListener('click', () => {
  const session = JSON.parse(localStorage.getItem(STORAGE_KEY));
  if (!session) return;

  const duration = session.events.at(-1)?.t ?? 0;
  ui.overlay.classList.add('open');
  ui.scrub.max = duration;
  ui.scrub.value = 0;
  ui.time.textContent = `0:00 / ${formatTime(duration)}`;

  replay = {
    snapshot: session.snapshot,
    events: session.events,
    duration,
    doc: null,
    index: 0,
    offset: 0,
    playing: false,
    startedAt: 0,
    frameId: 0,
    trail: null,
  };

  mountReplayDocument(session.snapshot, (doc) => {
    replay.doc = doc;
    applyEventsUpTo(doc, 0);
  });
});

ui.play.addEventListener('click', () => {
  if (!replay) return;
  replay.playing ? pauseReplay() : seekReplay(Number(ui.scrub.value), true);
});

ui.scrub.addEventListener('input', () => {
  if (!replay) return;
  seekReplay(Number(ui.scrub.value), replay.playing);
});

$('replay-close').addEventListener('click', closeReplay);

syncSavedState();
