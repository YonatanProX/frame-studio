// Frame Studio — app/ui-kit.js (owner: U)
// Small DOM + UX toolkit shared by U modules: h() builder, toasts, modal/confirm dialogs, menus,
// formatting (Hebrew), colors, safe localStorage, misc timing helpers.
import { icon } from './ui-icons.js';

// ---------------------------------------------------------------- DOM builder
/**
 * h('div.cls1.cls2#id', {attrs/props/on/style/dataset}, ...children)
 * props: class | className, style (object|string), dataset, on:{evt:fn}, html (innerHTML), any attribute/property.
 */
export function h(tag, props, ...children) {
  let t = tag; let id = null; const classes = [];
  const m = /^([a-z0-9-]*)((?:[.#][\w-]+)*)$/i.exec(tag);
  if (m) {
    t = m[1] || 'div';
    for (const part of (m[2] || '').match(/[.#][\w-]+/g) || []) {
      if (part[0] === '.') classes.push(part.slice(1)); else id = part.slice(1);
    }
  }
  const el = document.createElement(t);
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { children.unshift(props); props = null; }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class' || k === 'className') { el.className = [el.className, v].filter(Boolean).join(' '); }
      else if (k === 'style') { if (typeof v === 'string') el.style.cssText = v; else Object.assign(el.style, v); }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'on') { for (const [ev, fn] of Object.entries(v)) if (fn) el.addEventListener(ev, fn); }
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'icon') el.insertAdjacentHTML('afterbegin', icon(v, props.iconSize || 16));
      else if (k === 'iconSize') { /* handled with icon */ }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el && typeof v !== 'string' && k !== 'list') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  appendChildren(el, children);
  return el;
}
function appendChildren(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function iconBtn(name, title, onClick, { cls = '', size = 16, attrs = {} } = {}) {
  const b = h('button.btn-icon' + (cls ? '.' + cls.split(' ').join('.') : ''), { type: 'button', title, 'aria-label': title, on: { click: onClick }, ...attrs });
  b.innerHTML = icon(name, size);
  return b;
}

// ---------------------------------------------------------------- math/time
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export function round(v, d = 2) { const k = 10 ** d; return Math.round(v * k) / k; }
export function debounce(fn, ms = 200) {
  let tm = null;
  const d = (...a) => { clearTimeout(tm); tm = setTimeout(() => { tm = null; fn(...a); }, ms); };
  d.flush = (...a) => { clearTimeout(tm); tm = null; fn(...a); };
  d.cancel = () => { clearTimeout(tm); tm = null; };
  return d;
}
export function rafThrottle(fn) {
  let queued = false; let lastArgs = null;
  return (...a) => { lastArgs = a; if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; fn(...lastArgs); }); };
}

// ---------------------------------------------------------------- formatting (Hebrew)
export function fmtSec(t, d = 2) { if (!Number.isFinite(t)) return '—'; return `${round(t, d).toFixed(d)} ש׳`; }
export function fmtClock(t) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60); const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}
export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
export function fmtEta(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  if (sec < 60) return `${Math.ceil(sec)} שניות`;
  const m = Math.floor(sec / 60); const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')} דקות`;
}
export function relTime(iso) {
  const t = typeof iso === 'number' ? iso : Date.parse(iso || '');
  if (!t) return '';
  const d = (Date.now() - t) / 1000;
  if (d < 45) return 'עכשיו';
  if (d < 90) return 'לפני דקה';
  if (d < 3600) return `לפני ${Math.round(d / 60)} דקות`;
  if (d < 7200) return 'לפני שעה';
  if (d < 86400) return `לפני ${Math.round(d / 3600)} שעות`;
  if (d < 172800) return 'אתמול';
  if (d < 86400 * 30) return `לפני ${Math.round(d / 86400)} ימים`;
  try { return new Date(t).toLocaleDateString('he-IL'); } catch { return ''; }
}
export function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------------------------------------------------------------- colors
export function parseColor(str) {
  if (!str || typeof str !== 'string') return { r: 0, g: 0, b: 0, a: 1 };
  const s = str.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let x = m[1];
    if (x.length === 3 || x.length === 4) x = x.split('').map((c) => c + c).join('');
    const n = (i) => parseInt(x.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: x.length === 8 ? n(6) / 255 : 1 };
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0, a: p.length > 3 ? clamp(p[3], 0, 1) : 1 };
  }
  const named = { white: '#ffffff', black: '#000000', red: '#ff0000', transparent: '#00000000' };
  if (named[s]) return parseColor(named[s]);
  return { r: 0, g: 0, b: 0, a: 1 };
}
export function toHex({ r, g, b }) {
  const x = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${x(r)}${x(g)}${x(b)}`;
}
export function colorString({ r, g, b, a = 1 }) {
  if (a >= 0.999) return toHex({ r, g, b });
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${round(a, 3)})`;
}

// ---------------------------------------------------------------- storage
export const store = {
  get(key, fallback = null) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ } },
};

export function isTypingTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const t = (el.type || 'text').toLowerCase();
    return !['checkbox', 'radio', 'button', 'range', 'color', 'submit', 'reset'].includes(t);
  }
  return false;
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fallback */ }
  try {
    const ta = h('textarea', { style: 'position:fixed;opacity:0;left:-1000px' }); ta.value = text;
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}

// ---------------------------------------------------------------- toasts
let toastHost = null;
function hostEl() {
  if (toastHost && document.body.contains(toastHost)) return toastHost;
  toastHost = document.getElementById('toasts') || h('div#toasts.toasts');
  if (!toastHost.parentNode) document.body.appendChild(toastHost);
  return toastHost;
}
const TOAST_ICON = { info: 'info', success: 'check', error: 'alert', warn: 'alert', claude: 'sparkle' };
/** toast(message, {type:'info'|'success'|'error'|'warn'|'claude', timeout, title, action:{label, onClick}}) */
export function toast(message, opts = {}) {
  if (typeof opts === 'string') opts = { type: opts };
  const type = opts.type || 'info';
  const host = hostEl();
  const el = h('div.toast.toast-' + type, { role: type === 'error' ? 'alert' : 'status' });
  el.innerHTML = `<span class="toast-ic">${icon(opts.icon || TOAST_ICON[type] || 'info', 16)}</span>`;
  const body = h('div.toast-body');
  if (opts.title) body.appendChild(h('div.toast-title', opts.title));
  body.appendChild(h('div.toast-msg', String(message ?? '')));
  el.appendChild(body);
  if (opts.action) {
    el.appendChild(h('button.toast-action', { type: 'button', on: { click: (e) => { e.stopPropagation(); opts.action.onClick?.(); dismiss(); } } }, opts.action.label));
  }
  const dismiss = () => { el.classList.add('out'); setTimeout(() => el.remove(), 220); };
  el.addEventListener('click', dismiss);
  host.appendChild(el);
  while (host.children.length > 5) host.firstChild.remove();
  const timeout = opts.timeout ?? (type === 'error' ? 6500 : type === 'claude' ? 3000 : 3200);
  if (timeout > 0) setTimeout(dismiss, timeout);
  return { el, dismiss };
}

// ---------------------------------------------------------------- modal
let modalStack = [];
/**
 * modal({title, body:Node|Node[], actions:[{label, primary, danger, onClick(close)→false keeps open, icon}], width, onClose, closable=true, cls})
 * → { el, close, body, setActions }
 */
export function modal(opts) {
  const { title, width = 520, closable = true, cls = '' } = opts;
  const back = h('div.modal-back' + (cls ? '.' + cls : ''));
  const box = h('div.modal', { style: { width: typeof width === 'number' ? `${width}px` : width }, role: 'dialog', 'aria-modal': 'true' });
  const head = h('div.modal-head', h('div.modal-title', title || ''));
  if (closable) head.appendChild(iconBtn('close', 'סגירה', () => close()));
  const body = h('div.modal-body');
  appendChildren(body, [opts.body].flat());
  const foot = h('div.modal-foot');
  box.append(head, body, foot);
  back.appendChild(box);
  let closed = false;
  function close(result) {
    if (closed) return; closed = true;
    back.classList.add('out');
    modalStack = modalStack.filter((m) => m !== api);
    setTimeout(() => back.remove(), 160);
    opts.onClose?.(result);
  }
  function setActions(actions = []) {
    clear(foot);
    foot.style.display = actions.length ? '' : 'none';
    for (const a of actions) {
      const b = h('button.btn' + (a.primary ? '.btn-primary' : '') + (a.danger ? '.btn-danger' : '') + (a.ghost ? '.btn-ghost' : ''), {
        type: 'button', disabled: !!a.disabled,
        on: { click: async () => { const r = await a.onClick?.(close, b); if (r !== false && !a.keepOpen) close(a.value); } },
      });
      if (a.icon) b.insertAdjacentHTML('afterbegin', icon(a.icon, 15));
      b.appendChild(document.createTextNode(a.label));
      if (a.id) b.dataset.action = a.id;
      foot.appendChild(b);
    }
  }
  setActions(opts.actions || []);
  if (closable) back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  const api = { el: box, back, body, close, setActions, closable };
  modalStack.push(api);
  (document.getElementById('overlays') || document.body).appendChild(back);
  requestAnimationFrame(() => {
    back.classList.add('in');
    const f = box.querySelector('[autofocus]') || box.querySelector('input:not([type=hidden]),textarea,select');
    if (f) f.focus();
  });
  return api;
}
export function topModal() { return modalStack[modalStack.length - 1] || null; }
export function closeTopModal() { const m = topModal(); if (m && m.closable) { m.close(); return true; } return false; }

export function confirmDialog(message, { title = 'אישור', okLabel = 'אישור', cancelLabel = 'ביטול', danger = false } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    modal({
      title, width: 420,
      body: h('p.modal-text', message),
      actions: [
        { label: cancelLabel, ghost: true, onClick: () => { ok = false; } },
        { label: okLabel, primary: !danger, danger, onClick: () => { ok = true; } },
      ],
      onClose: () => resolve(ok),
    });
  });
}

export function promptDialog(message, { title = '', value = '', okLabel = 'אישור', placeholder = '', dir = 'auto' } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input.input', { type: 'text', value, placeholder, dir, autofocus: true });
    const m = modal({
      title, width: 440,
      body: [message ? h('p.modal-text', message) : null, input],
      actions: [
        { label: 'ביטול', ghost: true, onClick: () => { result = null; } },
        { label: okLabel, primary: true, onClick: () => { result = input.value; } },
      ],
      onClose: () => resolve(result),
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { result = input.value; m.close(); } });
  });
}

// ---------------------------------------------------------------- context / popover menu
let openMenu = null;
/** menu(anchorOrPoint, items:[{label, icon, onClick, danger, disabled, checked, sep, hint}]) */
export function menu(anchor, items) {
  closeMenu();
  const el = h('div.menu', { role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { el.appendChild(h('div.menu-sep')); continue; }
    if (it.header) { el.appendChild(h('div.menu-header', it.header)); continue; }
    const b = h('button.menu-item' + (it.danger ? '.danger' : '') + (it.checked ? '.checked' : ''), {
      type: 'button', disabled: !!it.disabled,
      on: { click: () => { closeMenu(); it.onClick?.(); } },
    });
    b.innerHTML = `<span class="menu-ic">${it.checked ? icon('check', 14) : (it.icon ? icon(it.icon, 14) : '')}</span><span class="menu-label"></span>${it.hint ? `<span class="menu-hint">${escapeHtml(it.hint)}</span>` : ''}`;
    b.querySelector('.menu-label').textContent = it.label;
    el.appendChild(b);
  }
  document.body.appendChild(el);
  let x; let y;
  if (anchor && anchor.getBoundingClientRect) { const r = anchor.getBoundingClientRect(); x = r.right; y = r.bottom + 4; }
  else { x = anchor.x; y = anchor.y; }
  const mr = el.getBoundingClientRect();
  x = clamp(x - mr.width, 6, window.innerWidth - mr.width - 6);
  if (anchor && !anchor.getBoundingClientRect) x = clamp(anchor.x - mr.width, 6, window.innerWidth - mr.width - 6);
  y = clamp(y, 6, window.innerHeight - mr.height - 6);
  el.style.left = `${x}px`; el.style.top = `${y}px`;
  openMenu = el;
  setTimeout(() => {
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escKey, true);
  });
  return el;
}
function outside(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
function escKey(e) { if (e.key === 'Escape' && openMenu) { e.preventDefault(); e.stopPropagation(); closeMenu(); } }
export function closeMenu() {
  if (!openMenu) return;
  openMenu.remove(); openMenu = null;
  window.removeEventListener('pointerdown', outside, true);
  window.removeEventListener('keydown', escKey, true);
}

// ---------------------------------------------------------------- pointer drag helper
/** drag(e, {move(dx,dy,ev), up(dx,dy,ev, moved), threshold}) — captures pointer on e.currentTarget */
export function startDrag(e, { move, up, threshold = 0, cursor } = {}) {
  const sx = e.clientX; const sy = e.clientY; let moved = false;
  const target = e.currentTarget || e.target;
  try { target.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
  if (cursor) document.body.style.cursor = cursor;
  const mv = (ev) => {
    const dx = ev.clientX - sx; const dy = ev.clientY - sy;
    if (!moved && Math.hypot(dx, dy) < threshold) return;
    moved = true; move?.(dx, dy, ev);
  };
  const end = (ev) => {
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    if (cursor) document.body.style.cursor = '';
    up?.(ev.clientX - sx, ev.clientY - sy, ev, moved);
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}
