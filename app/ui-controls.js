// Frame Studio — app/ui-controls.js (owner: U)
// Generic inspector controls: slider, number field, scrub label, color (with alpha), switch,
// segmented, select, chip grid, collapsible section. Pure DOM; no knowledge of the project model.
import { h, clamp, round, parseColor, toHex, colorString, store, startDrag } from './ui-kit.js';
import { icon } from './ui-icons.js';

// ---------------------------------------------------------------- slider (supports log curve)
/**
 * slider({min,max,step,value,curve:'linear'|'log',centered,disabled,onInput(v),onChange(v)}) → {el,set(v),get()}
 * values are DISPLAY units.
 */
export function slider(o) {
  const log = o.curve === 'log' && o.min > 0;
  const toPos = (v) => (log ? (Math.log(v / o.min) / Math.log(o.max / o.min)) * 1000 : v);
  const fromPos = (p) => (log ? o.min * Math.pow(o.max / o.min, p / 1000) : p);
  const el = h('input.slider' + (o.centered ? '.centered' : ''), {
    type: 'range', min: log ? 0 : o.min, max: log ? 1000 : o.max, step: log ? 1 : (o.step ?? 'any'), disabled: !!o.disabled,
  });
  let cur = o.value ?? o.min;
  const paint = () => {
    const pos = Number(el.value); const lo = Number(el.min); const hi = Number(el.max);
    el.style.setProperty('--p', `${((pos - lo) / ((hi - lo) || 1)) * 100}%`);
  };
  const set = (v) => { if (!Number.isFinite(v)) return; cur = v; el.value = String(toPos(clamp(v, o.min, o.max))); paint(); };
  const read = () => { let v = fromPos(Number(el.value)); if (o.step && !log) v = Math.round(v / o.step) * o.step; return round(v, 4); };
  el.addEventListener('input', () => { paint(); cur = read(); o.onInput?.(cur); });
  el.addEventListener('change', () => { cur = read(); o.onChange?.(cur); });
  el.addEventListener('dblclick', () => { if (o.defaultValue != null) { set(o.defaultValue); o.onChange?.(o.defaultValue); } });
  set(cur);
  return { el, set, get: () => cur, busy: () => document.activeElement === el && el.matches(':active') };
}

// ---------------------------------------------------------------- number field
export function numField(o) {
  const el = h('input.input.num' + (o.wide ? '.wide' : ''), { type: 'text', inputmode: 'decimal', spellcheck: false, disabled: !!o.disabled, title: o.title || '' });
  const dec = o.decimals ?? 1;
  let cur = o.value;
  const fmt = (v) => (v == null || !Number.isFinite(v) ? '' : (o.format ? o.format(v) : String(round(v, dec))));
  const set = (v, mixed = false) => { cur = v; if (document.activeElement !== el) { el.value = mixed ? '' : fmt(v); el.placeholder = mixed ? '—' : ''; } };
  const parse = () => {
    const raw = el.value.trim().replace(',', '.').replace(/[^\d.\-+eE∞]/g, '');
    if (o.parse) return o.parse(el.value);
    if (raw === '' ) return null;
    if (/-?∞/.test(el.value)) return o.min ?? -Infinity;
    // allow simple arithmetic like 10+5
    if (/^[\d.\-+*/ ()]+$/.test(raw) && /[+*/]/.test(raw.slice(1))) { try { const r = Function(`"use strict";return (${raw})`)(); if (Number.isFinite(r)) return r; } catch { /* ignore */ } }
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  };
  const commit = () => {
    const v = parse();
    if (v == null) { el.value = fmt(cur); return; }
    const c = clamp(v, o.hardMin ?? -Infinity, o.hardMax ?? Infinity);
    cur = c; el.value = fmt(c);
    o.onChange?.(c);
  };
  el.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(); el.blur(); }
    else if (e.key === 'Escape') { el.value = fmt(cur); el.blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const st = (o.step || 1) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      const v = clamp((parse() ?? cur ?? 0) + st, o.hardMin ?? -Infinity, o.hardMax ?? Infinity);
      cur = round(v, 6); el.value = fmt(cur); o.onChange?.(cur);
    }
  });
  el.addEventListener('focus', () => el.select());
  el.addEventListener('blur', commit);
  set(cur);
  return { el, set, get: () => cur };
}

/** drag a label horizontally to scrub a value (Premiere-style hot text) */
export function scrubLabel(labelEl, { get, step = 1, min = -Infinity, max = Infinity, onPreview, onCommit }) {
  labelEl.classList.add('scrub');
  labelEl.title = (labelEl.title ? labelEl.title + ' · ' : '') + 'גרירה לשינוי ערך';
  labelEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = get() ?? 0; let v = start;
    startDrag(e, {
      threshold: 2, cursor: 'ew-resize',
      move: (dx, dy, ev) => {
        const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
        // RTL layout: dragging right still increases (matches slider direction)
        v = clamp(round(start + dx * step * mult, 6), min, max);
        onPreview?.(v);
      },
      up: (dx, dy, ev, moved) => { if (moved) onCommit?.(v); },
    });
  });
}

// ---------------------------------------------------------------- color (hex + alpha)
export function colorField(o) {
  const wrap = h('div.color-ctl');
  const btn = h('label.color-btn', { title: o.title || 'בחירת צבע' });
  const fill = h('span.fill');
  const picker = h('input', { type: 'color' });
  btn.append(fill, picker);
  const hex = h('input.input.color-hex', { type: 'text', spellcheck: false, maxlength: 9 });
  const alpha = o.alpha ? h('input.input.num.alpha-num', { type: 'text', title: 'אטימות %' }) : null;
  wrap.append(btn, hex);
  if (alpha) wrap.append(alpha);
  if (o.eyedropper && 'EyeDropper' in window) {
    const ed = h('button.btn-icon.sm', { type: 'button', title: 'דגימת צבע מהמסך', html: icon('eyedropper', 14) });
    ed.addEventListener('click', async () => {
      try { const r = await new window.EyeDropper().open(); const c = parseColor(r.sRGBHex); cur = { ...c, a: cur.a }; paint(); o.onChange?.(colorString(cur)); } catch { /* cancelled */ }
    });
    wrap.append(ed);
  }
  let cur = parseColor(o.value || '#ffffff');
  const paint = () => {
    fill.style.background = colorString(cur);
    picker.value = toHex(cur);
    if (document.activeElement !== hex) hex.value = toHex(cur).toUpperCase();
    if (alpha && document.activeElement !== alpha) alpha.value = String(Math.round(cur.a * 100));
  };
  picker.addEventListener('input', () => { const c = parseColor(picker.value); cur = { ...c, a: cur.a }; paint(); o.onInput?.(colorString(cur)); });
  picker.addEventListener('change', () => { o.onChange?.(colorString(cur)); });
  hex.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') hex.blur(); });
  hex.addEventListener('blur', () => {
    let v = hex.value.trim(); if (v && v[0] !== '#') v = '#' + v;
    if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) { const c = parseColor(v); cur = v.length === 9 ? c : { ...c, a: cur.a }; paint(); o.onChange?.(colorString(cur)); }
    else paint();
  });
  if (alpha) {
    alpha.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') alpha.blur(); });
    alpha.addEventListener('blur', () => {
      const v = Number(alpha.value); if (Number.isFinite(v)) { cur = { ...cur, a: clamp(v / 100, 0, 1) }; paint(); o.onChange?.(colorString(cur)); } else paint();
    });
  }
  paint();
  return {
    el: wrap,
    set: (v) => { if (typeof v !== 'string') return; cur = parseColor(v); paint(); },
    get: () => colorString(cur),
  };
}

export function swatches(colors, onPick, current) {
  const el = h('div.swatches');
  for (const c of colors) {
    const b = h('button.swatch', { type: 'button', title: `צבע ${c}`, 'aria-label': `צבע ${c}`, style: { background: c } });
    if (current && current.toLowerCase() === c.toLowerCase()) b.classList.add('on');
    b.addEventListener('click', () => onPick(c));
    el.appendChild(b);
  }
  return el;
}

// ---------------------------------------------------------------- switch / select / segmented
export function switchField(o) {
  const input = h('input', { type: 'checkbox', checked: !!o.value, disabled: !!o.disabled });
  const el = h('label.switch', { title: o.title || '' }, input, h('span.track'));
  input.addEventListener('change', () => o.onChange?.(input.checked));
  return { el, set: (v) => { input.checked = !!v; }, get: () => input.checked, input };
}

export function selectField(o) {
  const el = h('select.select', { title: o.title || '', disabled: !!o.disabled });
  const fill = (options) => {
    el.innerHTML = '';
    for (const opt of options) {
      if (opt.group) {
        const g = h('optgroup', { label: opt.group });
        for (const sub of opt.options) g.appendChild(h('option', { value: String(sub.value) }, sub.label));
        el.appendChild(g);
      } else el.appendChild(h('option', { value: String(opt.value) }, opt.label));
    }
  };
  fill(o.options || []);
  const set = (v) => {
    const s = String(v ?? '');
    if (![...el.options].some((op) => op.value === s) && v != null && o.allowCustom !== false) el.appendChild(h('option', { value: s }, o.customLabel ? o.customLabel(s) : s));
    el.value = s;
  };
  set(o.value);
  el.addEventListener('change', () => o.onChange?.(o.numeric ? Number(el.value) : el.value));
  el.addEventListener('keydown', (e) => e.stopPropagation());
  return { el, set, get: () => el.value, fill };
}

/** seg(options:[{value,label,icon,title}], {value, onChange, block, accent}) */
export function segField(options, o = {}) {
  const el = h('div.seg' + (o.block ? '.block' : '') + (o.icons ? '.icons' : ''));
  const btns = new Map();
  for (const opt of options) {
    const b = h('button', { type: 'button', title: opt.title || opt.label || '' });
    if (opt.icon) b.insertAdjacentHTML('afterbegin', icon(opt.icon, 14));
    if (opt.label && !o.icons) b.appendChild(document.createTextNode(opt.label));
    b.addEventListener('click', () => { set(opt.value); o.onChange?.(opt.value); });
    btns.set(String(opt.value), b);
    el.appendChild(b);
  }
  const set = (v) => { for (const [k, b] of btns) { b.classList.toggle('on', k === String(v)); b.classList.toggle('accent', k === String(v) && !!o.accent); } };
  set(o.value);
  return { el, set };
}

/** chip grid: items [{id,name,icon?,swatch?}], value = selected id */
export function chipGrid(items, o = {}) {
  const el = h('div.chips' + (o.wide ? '.wide' : ''));
  const map = new Map();
  for (const it of items) {
    const b = h('button.chip' + (o.small ? '.sm' : ''), { type: 'button', title: it.title || it.name || it.id });
    if (it.swatch) b.appendChild(h('span.swatch-big', { style: { background: it.swatch } }));
    else if (it.icon) b.insertAdjacentHTML('beforeend', `<span class="chip-ic">${icon(it.icon, 18)}</span>`);
    b.appendChild(h('span', it.name || it.id));
    b.addEventListener('click', () => { set(it.id); o.onPick?.(it.id, it); });
    map.set(String(it.id), b);
    el.appendChild(b);
  }
  const set = (v) => { for (const [k, b] of map) b.classList.toggle('on', k === String(v)); };
  set(o.value);
  return { el, set };
}

// ---------------------------------------------------------------- collapsible section
export function section(title, o = {}) {
  const key = o.key ? `fs.sec.${o.key}` : null;
  const openSaved = key ? store.get(key, null) : null;
  const open = openSaved == null ? o.open !== false : !!openSaved;
  const el = h('div.sec' + (open ? '' : '.closed'));
  const actions = h('div.sec-actions');
  const head = h('div.sec-head', { html: `<span class="chev">${icon('chevDown', 14)}</span>` });
  if (o.icon) head.insertAdjacentHTML('beforeend', icon(o.icon, 14));
  head.appendChild(h('span.sec-title', title));
  if (o.toggle) { const tg = h('span.sec-toggle', o.toggle); tg.addEventListener('click', (e) => e.stopPropagation()); head.appendChild(tg); }
  head.appendChild(actions);
  actions.addEventListener('click', (e) => e.stopPropagation());
  for (const a of o.actions || []) actions.appendChild(a);
  head.addEventListener('click', () => {
    const closed = el.classList.toggle('closed');
    if (key) store.set(key, !closed);
  });
  const body = h('div.sec-body');
  el.append(head, body);
  return { el, body, head, actions };
}

export function row(label, ...controls) {
  const lbl = h('span.lbl', { title: label }, label);
  const el = h('div.row', lbl, ...controls);
  return { el, lbl };
}
