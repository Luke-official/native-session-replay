const STORAGE_KEY = 'latestInteraction';
const COLORS = { move: '#22d3ee', drag: '#ef4444' };
const CAPTURE = { capture: true };

const $ = (id) => document.getElementById(id);
const ui = {
  save: $('save-btn'), view: $('view-btn'), clearSaved: $('clear-saved-btn'),
  overlay: $('replay-overlay'), frame: $('replay-frame'), scrub: $('replay-scrub'),
  play: $('replay-play'), time: $('replay-time'), canvas: $('replay-draw'),
};
const ctx = ui.canvas.getContext('2d');

const recorder = {
  t0: performance.now(),
  events: [],
  snapshot: null,
  drawing: false,
  dragPoint: null,
  moveFrame: 0,
  pendingMove: null,
};

let replay = null;

const timestamp = () => Math.round(performance.now() - recorder.t0);
const isExcluded = (node) => node?.closest?.('[data-no-record]');
const isInteractive = (node) => node?.closest?.('button, input, textarea, select, a, [contenteditable]');

function domPath(element) {
  const path = [];
  for (let node = element; node && node !== document.body; node = node.parentElement) {
    path.unshift([...node.parentElement.children].indexOf(node));
  }
  return path;
}

function record(type, data = {}) {
  recorder.events.push({ t: timestamp(), type, ...data });
}

function takeSnapshot() {
  const body = document.body.cloneNode(true);
  body.querySelectorAll('[data-no-record]').forEach((el) => el.remove());
  return { html: body.innerHTML, head: document.head.innerHTML, w: innerWidth, h: innerHeight };
}

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

function queueMove(point) {
  recorder.pendingMove = point;
  if (recorder.moveFrame) return;
  recorder.moveFrame = requestAnimationFrame(() => {
    record('mm', recorder.pendingMove);
    recorder.moveFrame = 0;
  });
}

function dragTo(x, y, persist = true) {
  const { dragPoint } = recorder;
  if (dragPoint && persist) record('dr', { x0: dragPoint.x, y0: dragPoint.y, x1: x, y1: y });
  recorder.dragPoint = { x, y };
}

function breakTrail() {
  record('mb');
}

function strokeLine(x0, y0, x1, y1, color, width) {
  Object.assign(ctx, { strokeStyle: color, lineWidth: width, lineCap: 'round', lineJoin: 'round' });
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

function nodeAt(doc, path) {
  return path.reduce((node, index) => node.children[index], doc.body);
}

function clearCanvas(width, height) {
  ui.canvas.width = width;
  ui.canvas.height = height;
}

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

const replayHandlers = {
  mm(_doc, { x, y }) {
    if (replay.trail) strokeLine(replay.trail.x, replay.trail.y, x, y, COLORS.move, 2);
    replay.trail = { x, y };
  },
  mb: () => { replay.trail = null; },
  dr(_doc, { x0, y0, x1, y1 }) {
    strokeLine(x0, y0, x1, y1, COLORS.drag, 3);
  },
  dc: () => {
    clearCanvas(replay.snapshot.w, replay.snapshot.h);
    replay.trail = null;
  },
  sc(doc, { path, x, y }) {
    const target = path ? nodeAt(doc, path) : doc.documentElement;
    target.scrollLeft = x;
    target.scrollTop = y;
  },
  rs(_doc, { w, h }) {
    ui.frame.style.width = `${w}px`;
    ui.frame.style.height = `${h}px`;
  },
  mut(doc, event) {
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

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

function syncSavedState() {
  const hasSaved = !!localStorage.getItem(STORAGE_KEY);
  ui.view.disabled = ui.clearSaved.disabled = !hasSaved;
}

function pauseReplay() {
  if (!replay?.playing) return;
  replay.playing = false;
  replay.offset = Number(ui.scrub.value);
  cancelAnimationFrame(replay.frameId);
  ui.play.textContent = 'Play';
}

function startReplay() {
  replay.playing = true;
  replay.startedAt = performance.now();
  ui.play.textContent = 'Pause';
  tickReplay();
}

function seekReplay(ms, resume = false) {
  if (!replay) return;
  pauseReplay();
  mountReplayDocument(replay.snapshot, (doc) => {
    replay.doc = doc;
    applyEventsUpTo(doc, ms);
    if (resume) startReplay();
  });
}

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

function closeReplay() {
  pauseReplay();
  replay = null;
  ui.overlay.classList.remove('open');
  ui.frame.srcdoc = '';
}

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
