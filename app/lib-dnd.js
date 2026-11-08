// Shared drag & drop payload between the library panel (source) and the timeline / other drop targets.
// HTML5 DnD hides dataTransfer data during `dragover`, so the source also keeps the payload here.
// Payload: { kind:"media"|"sound"|"text"|"caption"|"sticker"|"shape"|"effect"|"transition"|"filter"|"anim"|"lut", … }

export const DND_MIME = 'application/x-frame-studio';

let current = null;
let currentAt = 0;

/** Called by drag sources on dragstart. Also writes the JSON into dataTransfer. */
export function startDrag(ev, payload, { label, image } = {}) {
  current = payload;
  currentAt = Date.now();
  try {
    ev.dataTransfer.effectAllowed = 'copy';
    ev.dataTransfer.setData(DND_MIME, JSON.stringify(payload));
    ev.dataTransfer.setData('text/plain', label || payload.name || payload.kind);
    if (image) ev.dataTransfer.setDragImage(image, 16, 16);
  } catch { /* some sources (synthetic events) have no dataTransfer */ }
}

/** Called by drag sources on dragend. */
export function endDrag() {
  current = null;
}

/** Payload of the drag in progress (null when the drag did not start in Frame Studio). */
export function getDragPayload(ev) {
  if (current && Date.now() - currentAt < 10 * 60 * 1000) return current;
  if (ev && ev.dataTransfer) {
    try {
      const s = ev.dataTransfer.getData(DND_MIME);
      if (s) return JSON.parse(s);
    } catch { /* only readable on drop */ }
  }
  return null;
}

/** True when the drag carries a Frame Studio payload. */
export function isStudioDrag(ev) {
  if (current) return true;
  const types = ev && ev.dataTransfer ? [...ev.dataTransfer.types] : [];
  return types.includes(DND_MIME);
}

/** True when the drag carries files from the OS (Explorer). */
export function isFileDrag(ev) {
  const types = ev && ev.dataTransfer ? [...ev.dataTransfer.types] : [];
  return types.includes('Files');
}
