// Frame Studio — context menus, popovers, prompt & confirm dialogs (Hebrew, RTL) for timeline / library (agent L).

import { h, icon, injectStyle, escapeHtml } from './tl-util.js';

const CSS = `
.fsm-menu{position:fixed;z-index:10000;min-width:200px;max-width:320px;background:#1d2127;border:1px solid #343b45;border-radius:9px;
  box-shadow:0 14px 44px rgba(0,0,0,.6),0 2px 8px rgba(0,0,0,.45);padding:5px;direction:rtl;font:12.5px/1.35 var(--font,"Segoe UI",Heebo,Arial,sans-serif);
  color:#e7e9ec;user-select:none;outline:none;animation:fsmIn .09s ease-out}
@keyframes fsmIn{from{opacity:0;transform:translateY(-3px) scale(.985)}to{opacity:1;transform:none}}
.fsm-item{display:flex;align-items:center;gap:9px;height:29px;padding:0 9px 0 10px;border-radius:6px;cursor:default;white-space:nowrap;position:relative}
.fsm-item .fsm-ic{width:16px;height:16px;color:#a9afb8;display:flex;align-items:center;justify-content:center;flex:none}
.fsm-item .fsm-label{flex:1;overflow:hidden;text-overflow:ellipsis}
.fsm-item .fsm-kbd{color:#6f7681;font-size:11px;direction:ltr;margin-inline-start:14px;font-family:var(--mono,Consolas,monospace)}
.fsm-item .fsm-sub{color:#6f7681;display:flex}
.fsm-item:hover,.fsm-item.fsm-active{background:rgba(19,182,228,.16);color:#fff}
.fsm-item:hover .fsm-ic,.fsm-item.fsm-active .fsm-ic{color:#3fcaf0}
.fsm-item.fsm-disabled{opacity:.38;pointer-events:none}
.fsm-item.fsm-danger:hover{background:rgba(255,92,99,.16);color:#ff8a8f}
.fsm-item.fsm-danger:hover .fsm-ic{color:#ff8a8f}
.fsm-item.fsm-checked .fsm-ic{color:#3fcaf0}
.fsm-sep{height:1px;background:#2c323b;margin:5px 4px}
.fsm-title{padding:6px 10px 4px;color:#6f7681;font-size:11px;font-weight:600;letter-spacing:.02em}
.fsm-swatches{display:flex;flex-wrap:wrap;gap:6px;padding:6px 10px 8px}
.fsm-swatch{width:20px;height:20px;border-radius:50%;cursor:pointer;border:2px solid rgba(255,255,255,.08);box-shadow:inset 0 0 0 1px rgba(0,0,0,.25)}
.fsm-swatch:hover{transform:scale(1.12);border-color:#fff}
.fsm-swatch.fsm-none{background:repeating-linear-gradient(45deg,#2a2f37 0 4px,#3a414b 4px 8px)}
.fsm-swatch.fsm-sel{border-color:#fff}
.fsm-pop{position:fixed;z-index:10000;background:#1b1f25;border:1px solid #343b45;border-radius:11px;box-shadow:0 18px 50px rgba(0,0,0,.6);
  direction:rtl;color:#e7e9ec;font:12.5px/1.35 var(--font,"Segoe UI",Heebo,Arial,sans-serif);animation:fsmIn .1s ease-out;outline:none}
.fsm-pop-head{display:flex;align-items:center;gap:8px;padding:10px 12px 8px;border-bottom:1px solid #272c34;font-weight:600}
.fsm-pop-head .fsm-x{margin-inline-start:auto;background:none;border:0;color:#8a919b;width:24px;height:24px;border-radius:6px;display:flex;align-items:center;justify-content:center;cursor:pointer}
.fsm-pop-head .fsm-x:hover{background:#2a3038;color:#fff}
.fsm-dialog-back{position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;animation:fsmFade .12s}
@keyframes fsmFade{from{opacity:0}to{opacity:1}}
.fsm-dialog{min-width:340px;max-width:460px;background:#1b1f25;border:1px solid #343b45;border-radius:12px;box-shadow:0 24px 70px rgba(0,0,0,.65);
  padding:18px 18px 14px;direction:rtl;color:#e7e9ec;font:13px/1.45 var(--font,"Segoe UI",Heebo,Arial,sans-serif)}
.fsm-dialog h3{margin:0 0 6px;font-size:15px}
.fsm-dialog p{margin:0 0 12px;color:#a9afb8}
.fsm-dialog input{width:100%;height:34px;border-radius:7px;border:1px solid #3b424c;background:#101317;color:#fff;padding:0 10px;font:inherit;outline:none;user-select:text}
.fsm-dialog input:focus{border-color:#13b6e4;box-shadow:0 0 0 3px rgba(19,182,228,.18)}
.fsm-btns{display:flex;gap:8px;justify-content:flex-start;margin-top:14px}
.fsm-btn{height:30px;padding:0 14px;border-radius:7px;border:1px solid #3b424c;background:#23282f;color:#e7e9ec;cursor:pointer;font:inherit}
.fsm-btn:hover{background:#2b313a}
.fsm-btn.fsm-primary{background:#13b6e4;border-color:#13b6e4;color:#06202b;font-weight:600}
.fsm-btn.fsm-primary:hover{background:#3fcaf0}
.fsm-btn.fsm-danger{background:#e5484d;border-color:#e5484d;color:#fff}
.fsm-tip{position:fixed;z-index:10002;pointer-events:none;background:#0b0d10;color:#e7e9ec;border:1px solid #2f353e;border-radius:6px;padding:3px 7px;
  font:11.5px/1.3 var(--mono,Consolas,monospace);white-space:nowrap;box-shadow:0 6px 18px rgba(0,0,0,.5);direction:ltr}
`;

function ensureCss() { injectStyle('fs-l-menu-css', CSS); }
export const ensureMenuCss = ensureCss;

let openMenus = [];
let openPop = null;

export function closeMenus() {
  for (const m of openMenus) m.remove();
  openMenus = [];
  document.removeEventListener('pointerdown', onDocDown, true);
  document.removeEventListener('keydown', onDocKey, true);
  window.removeEventListener('blur', closeMenus);
}
function onDocDown(e) {
  if (openMenus.some((m) => m.contains(e.target))) return;
  closeMenus();
}
function onDocKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenus(); }
}

function place(el, x, y, { alignRight = true, parentRect = null } = {}) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const r = el.getBoundingClientRect();
  let left, top;
  if (parentRect) {
    // submenu: open to the left of parent (RTL), else to the right
    left = parentRect.left - r.width + 4;
    if (left < 4) left = parentRect.right - 4;
    top = parentRect.top - 5;
  } else {
    left = alignRight ? x - r.width : x;
    if (left < 4) left = x;
    top = y;
  }
  if (left + r.width > vw - 4) left = vw - r.width - 4;
  if (left < 4) left = 4;
  if (top + r.height > vh - 4) top = Math.max(4, vh - r.height - 4);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

/**
 * Show a context menu.
 * items: [{label, icon?, kbd?, onClick?, disabled?, danger?, checked?, submenu?:[…], swatches?:{colors, value, onPick}} | "-" | {title}]
 */
export function showMenu(items, x, y, { level = 0, parentRect = null } = {}) {
  ensureCss();
  if (level === 0) closeMenus();
  else { for (const m of openMenus.splice(level)) m.remove(); }
  const menu = h('div.fsm-menu', { role: 'menu', tabindex: '-1' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { menu.appendChild(h('div.fsm-sep')); continue; }
    if (it.title) { menu.appendChild(h('div.fsm-title', { text: it.title })); continue; }
    if (it.swatches) {
      const row = h('div.fsm-swatches');
      for (const c of it.swatches.colors) {
        const sw = h('div.fsm-swatch', { title: c ? `צבע ${c}` : 'ללא צבע', style: c ? { background: c } : null });
        if (!c) sw.classList.add('fsm-none');
        if ((it.swatches.value || null) === c) sw.classList.add('fsm-sel');
        sw.addEventListener('click', (e) => { e.stopPropagation(); closeMenus(); it.swatches.onPick(c); });
        row.appendChild(sw);
      }
      menu.appendChild(row);
      continue;
    }
    const el = h('div.fsm-item', { role: 'menuitem' });
    if (it.disabled) el.classList.add('fsm-disabled');
    if (it.danger) el.classList.add('fsm-danger');
    if (it.checked) el.classList.add('fsm-checked');
    el.innerHTML = `<span class="fsm-ic">${it.checked ? icon('check', 14) : it.icon ? icon(it.icon, 15) : ''}</span><span class="fsm-label">${escapeHtml(it.label)}</span>${it.kbd ? `<span class="fsm-kbd">${escapeHtml(it.kbd)}</span>` : ''}${it.submenu ? `<span class="fsm-sub">${icon('chevronLeft', 13)}</span>` : ''}`;
    if (it.submenu) {
      let timer = null;
      const openSub = () => {
        menu.querySelectorAll('.fsm-active').forEach((x) => x.classList.remove('fsm-active'));
        el.classList.add('fsm-active');
        showMenu(it.submenu, 0, 0, { level: level + 1, parentRect: el.getBoundingClientRect() });
      };
      el.addEventListener('mouseenter', () => { clearTimeout(timer); timer = setTimeout(openSub, 120); });
      el.addEventListener('mouseleave', () => clearTimeout(timer));
      el.addEventListener('click', (e) => { e.stopPropagation(); openSub(); });
    } else {
      el.addEventListener('mouseenter', () => {
        for (const m of openMenus.splice(level + 1)) m.remove();
        menu.querySelectorAll('.fsm-active').forEach((x) => x.classList.remove('fsm-active'));
      });
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenus();
        if (it.onClick) it.onClick();
      });
    }
    menu.appendChild(el);
  }
  menu.addEventListener('contextmenu', (e) => e.preventDefault());
  document.body.appendChild(menu);
  place(menu, x, y, { parentRect });
  openMenus[level] = menu;
  if (level === 0) {
    setTimeout(() => {
      document.addEventListener('pointerdown', onDocDown, true);
      document.addEventListener('keydown', onDocKey, true);
      window.addEventListener('blur', closeMenus);
    }, 0);
  }
  return menu;
}

/** Popover anchored to a rect. content: HTMLElement. Returns {el, close}. */
export function showPopover(content, anchorRect, { title, width = 320, onClose } = {}) {
  ensureCss();
  closePopover();
  closeMenus();
  const pop = h('div.fsm-pop', { tabindex: '-1', style: { width: `${width}px` } });
  if (title) {
    const head = h('div.fsm-pop-head', null, h('span', { text: title }));
    const x = h('button.fsm-x', { title: 'סגירה', html: icon('x', 14) });
    x.addEventListener('click', () => closePopover());
    head.appendChild(x);
    pop.appendChild(head);
  }
  pop.appendChild(content);
  document.body.appendChild(pop);
  const r = pop.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = anchorRect.left + anchorRect.width / 2 - r.width / 2;
  let top = anchorRect.top - r.height - 8;
  if (top < 6) top = anchorRect.bottom + 8;
  if (top + r.height > vh - 6) top = Math.max(6, vh - r.height - 6);
  left = Math.max(6, Math.min(vw - r.width - 6, left));
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
  const down = (e) => { if (!pop.contains(e.target)) closePopover(); };
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopover(); } };
  setTimeout(() => { document.addEventListener('pointerdown', down, true); document.addEventListener('keydown', key, true); }, 0);
  openPop = { el: pop, close: () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key, true); pop.remove(); if (onClose) onClose(); } };
  return openPop;
}
export function closePopover() { if (openPop) { const p = openPop; openPop = null; p.close(); } }

/** Modal prompt; resolves the string or null. */
export function promptDialog({ title, message = '', value = '', placeholder = '', okLabel = 'אישור' }) {
  ensureCss();
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value, placeholder, dir: 'auto', spellcheck: false });
    const ok = h('button.fsm-btn.fsm-primary', { text: okLabel });
    const cancel = h('button.fsm-btn', { text: 'ביטול' });
    const dlg = h('div.fsm-dialog', { role: 'dialog' }, h('h3', { text: title }), message ? h('p', { text: message }) : null, input, h('div.fsm-btns', null, ok, cancel));
    const back = h('div.fsm-dialog-back', null, dlg);
    const done = (v) => { back.remove(); resolve(v); };
    ok.addEventListener('click', () => done(input.value));
    cancel.addEventListener('click', () => done(null));
    back.addEventListener('pointerdown', (e) => { if (e.target === back) done(null); });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); done(input.value); }
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
    });
    document.body.appendChild(back);
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

/** Modal confirm; resolves boolean. */
export function confirmDialog({ title, message = '', okLabel = 'אישור', danger = false }) {
  ensureCss();
  return new Promise((resolve) => {
    const ok = h('button.fsm-btn', { text: okLabel, class: danger ? 'fsm-danger' : 'fsm-primary' });
    const cancel = h('button.fsm-btn', { text: 'ביטול' });
    const dlg = h('div.fsm-dialog', { role: 'alertdialog' }, h('h3', { text: title }), message ? h('p', { text: message }) : null, h('div.fsm-btns', null, ok, cancel));
    const back = h('div.fsm-dialog-back', null, dlg);
    const done = (v) => { back.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); } };
    ok.addEventListener('click', () => done(true));
    cancel.addEventListener('click', () => done(false));
    back.addEventListener('pointerdown', (e) => { if (e.target === back) done(false); });
    document.addEventListener('keydown', key, true);
    document.body.appendChild(back);
    setTimeout(() => ok.focus(), 0);
  });
}

let tipEl = null;
/** Small floating tooltip near the pointer (timecodes while dragging). */
export function showTip(text, x, y) {
  ensureCss();
  if (!tipEl) { tipEl = h('div.fsm-tip'); document.body.appendChild(tipEl); }
  tipEl.textContent = text;
  tipEl.style.display = 'block';
  const r = tipEl.getBoundingClientRect();
  let left = x + 14, top = y - r.height - 10;
  if (left + r.width > window.innerWidth - 4) left = x - r.width - 14;
  if (top < 4) top = y + 18;
  tipEl.style.left = `${Math.round(left)}px`;
  tipEl.style.top = `${Math.round(top)}px`;
}
export function hideTip() { if (tipEl) tipEl.style.display = 'none'; }

/** Lightweight toast inside the app (falls back when main.js toasts are not reachable). */
export function toast(msg, kind = 'info') {
  try {
    let box = document.getElementById('toasts');
    if (!box) { box = h('div.toasts', { id: 'toasts' }); document.body.appendChild(box); }
    const ic = kind === 'error' || kind === 'warn' ? 'info' : kind === 'success' ? 'check' : 'info';
    const t = h('div.toast', { class: `toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' });
    t.innerHTML = `<span class="toast-ic">${icon(ic, 16)}</span>`;
    t.appendChild(h('div.toast-body', null, h('div.toast-msg', { text: msg })));
    const dismiss = () => { t.classList.add('out'); setTimeout(() => t.remove(), 220); };
    t.addEventListener('click', dismiss);
    box.appendChild(t);
    while (box.children.length > 5) box.firstChild.remove();
    setTimeout(dismiss, kind === 'error' ? 6000 : 3000);
    return;
  } catch { /* ignore */ }
  console.log('[frame-studio]', msg);
}
