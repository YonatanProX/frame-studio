// Frame Studio — app/ui-projects.js (owner: U)
// Project manager overlay: list / open / delete projects; a big "פרויקט חדש" button opens a small dialog
// (name + 4 formats; fps, custom size and default tracks under "הגדרות מתקדמות").
// Shown on start when there is no ?project= in the URL.
import { api, state } from './api.js';
import { h, clear, iconBtn, toast, confirmDialog, relTime, store, modal } from './ui-kit.js';
import { icon } from './ui-icons.js';
import * as M from './ui-model.js';
import { claudeCard } from './ui-claude.js';

const PRESETS = [
  { id: '9:16', w: 1080, h: 1920, label: 'ריילס · טיקטוק' },
  { id: '16:9', w: 1920, h: 1080, label: 'יוטיוב' },
  { id: '1:1', w: 1080, h: 1080, label: 'ריבוע' },
  { id: '4:5', w: 1080, h: 1350, label: 'פיד אינסטגרם' },
];

let openEl = null;

let escHandler = null;
export function closeProjectManager() {
  if (openEl) { openEl.remove(); openEl = null; }
  if (escHandler) { window.removeEventListener('keydown', escHandler, true); escHandler = null; }
}

export function openProjectManager({ closable = true, error = null } = {}) {
  closeProjectManager();
  const canClose = closable && !!state.project;
  const back = h('div.pm-back', { role: 'dialog', 'aria-label': 'מנהל הפרויקטים' });
  openEl = back;
  const close = () => closeProjectManager();

  // ---- top
  const top = h('div.pm-top',
    h('span', { html: icon('logo', 28) }),
    h('span.brand-name', { html: 'Frame <span>Studio</span>' }),
    h('div.tb-spacer'),
    canClose ? iconBtn('close', 'סגירה (Esc)', close) : null,
  );

  // ---- hero: one obvious action
  const newBtn = h('button.pm-new-btn', { type: 'button', title: 'יצירת פרויקט חדש', html: `<span class="pm-new-ic">${icon('plus', 22)}</span><span>פרויקט חדש</span>` });
  newBtn.addEventListener('click', () => openNewProjectDialog());
  const hero = h('div.pm-hero', newBtn, claudeCard());

  // ---- list
  const search = h('input.input.pm-search', { type: 'search', placeholder: 'חיפוש פרויקט…', dir: 'auto', 'aria-label': 'חיפוש פרויקט' });
  const grid = h('div.pgrid');
  const listHead = h('div.pm-list-head', h('h2.pm-h', 'הפרויקטים שלי'), h('div.tb-spacer'), search);
  const errBox = error ? h('div.ex-err', error) : null;
  const main = h('div.pm-main', errBox, hero, listHead, grid);

  back.append(top, main);
  (document.getElementById('overlays') || document.body).appendChild(back);
  escHandler = (e) => {
    if (e.key !== 'Escape' || !canClose || document.querySelector('.modal-back')) return; // a dialog on top handles its own Esc
    e.preventDefault(); e.stopPropagation(); close();
  };
  window.addEventListener('keydown', escHandler, true);

  let all = [];
  async function loadList() {
    clear(grid);
    grid.appendChild(h('div.mod-loading', h('span.spinner'), 'טוען פרויקטים…'));
    try {
      const res = await api.get('/api/projects');
      all = Array.isArray(res) ? res : (res?.projects || []);
      paint();
    } catch (e) {
      clear(grid);
      grid.appendChild(h('div.pm-empty', `לא ניתן לטעון את רשימת הפרויקטים: ${e.message}`));
    }
  }
  function paint() {
    clear(grid);
    const q = search.value.trim().toLowerCase();
    const items = all.filter((p) => !q || String(p.name || '').toLowerCase().includes(q) || String(p.id).includes(q))
      .sort((a, b) => (Date.parse(b.modified || 0) || 0) - (Date.parse(a.modified || 0) || 0));
    if (!items.length) {
      grid.appendChild(h('div.pm-empty', all.length ? 'לא נמצאו פרויקטים תואמים' : 'עוד אין פרויקטים — לחצו על "פרויקט חדש" כדי להתחיל, או בקשו מ-Claude לבנות לכם סרטון.'));
      return;
    }
    for (const p of items) grid.appendChild(card(p));
  }
  function card(p) {
    const w = p.width || 1080; const hh = p.height || 1920; const ratio = w / hh;
    const fw = ratio >= 1 ? 112 : Math.round(92 * ratio); const fh = ratio >= 1 ? Math.round(112 / ratio) : 92;
    const placeholder = h('div.pframe', { style: { width: `${fw}px`, height: `${fh}px` }, html: icon('film', 20) });
    const empty = p.clipCount === 0;
    const thumb = h('div.pthumb', placeholder, h('span.pdur' + (empty ? '.empty' : ''), { title: empty ? 'אין עדיין כלום בציר הזמן' : `אורך הסרטון: ${M.fmtLength(p.duration || 0)}` }, empty ? 'ריק' : M.fmtLength(p.duration || 0)));
    if (p.cover) {
      // a real frame from the project (GET /api/projects → cover); the placeholder stays if it fails to load
      const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', draggable: false });
      img.addEventListener('load', () => { placeholder.remove(); thumb.classList.add('has-img'); });
      img.addEventListener('error', () => img.remove());
      img.src = typeof api.url === 'function' ? api.url(p.cover) : p.cover;
      thumb.prepend(img);
    }
    const fmt = PRESETS.find((x) => x.w === w && x.h === hh)?.id || `${w}×${hh}`;
    const meta = h('div.pmeta', h('span', fmt), h('span', { style: 'direction:rtl' }, relTime(p.modified)));
    const el = h('div.pcard' + (p.id === state.projectId ? '.current' : ''), { title: `פתיחה: ${p.name || p.id}` }, thumb, h('div.pinfo', h('div.pname', p.name || p.id), meta));
    const del = iconBtn('trash', 'מחיקת פרויקט (מועבר לאשפה)', async (e) => {
      e.stopPropagation();
      const ok = await confirmDialog(`למחוק את "${p.name || p.id}"? התיקייה תועבר ל־projects/.trash ואפשר לשחזר אותה משם.`, { title: 'מחיקת פרויקט', okLabel: 'מחיקה', danger: true });
      if (!ok) return;
      try {
        await api.del(`/api/projects/${encodeURIComponent(p.id)}`);
        toast('הפרויקט הועבר לאשפה', { type: 'success' });
        if (p.id === state.projectId) { history.replaceState(null, '', location.pathname); location.reload(); return; }
        loadList();
      } catch (err) { toast(`המחיקה נכשלה: ${err.message}`, { type: 'error' }); }
    }, { cls: 'sm pdel' });
    el.appendChild(del);
    el.addEventListener('click', () => { if (p.id === state.projectId && canClose) close(); else goToProject(p.id); });
    return el;
  }
  search.addEventListener('input', paint);
  search.addEventListener('keydown', (e) => e.stopPropagation());
  loadList();
  setTimeout(() => newBtn.focus({ preventScroll: true }), 50);
  return { close };
}

// ---------------------------------------------------------------- new project dialog
export function openNewProjectDialog() {
  const lastPreset = store.get('fs.lastPreset', '9:16');
  let preset = PRESETS.find((p) => p.id === lastPreset) || PRESETS[0];
  let fpsVal = 30;
  const name = h('input.input', { type: 'text', dir: 'auto', value: 'פרויקט חדש', spellcheck: false, autofocus: true, 'aria-label': 'שם הפרויקט' });

  // advanced (collapsed): fps, custom size, default tracks
  const customSw = h('input', { type: 'checkbox' });
  const aspects = h('div.aspects');
  const aspectBtns = [];
  const paintAspects = () => { for (const { b, p } of aspectBtns) b.classList.toggle('on', !customSw.checked && p.id === preset.id); };
  for (const p of PRESETS) {
    const ratio = p.w / p.h;
    const sw = ratio >= 1 ? 34 : Math.round(34 * ratio); const sh = ratio >= 1 ? Math.round(34 / ratio) : 34;
    const b = h('button.aspect', { type: 'button', title: `${p.id} · ${p.w}×${p.h}` },
      h('span.shape-box', h('span.shape', { style: { width: `${sw}px`, height: `${sh}px` } })),
      h('b', p.id),
      h('span', p.label));
    b.addEventListener('click', () => { preset = p; customSw.checked = false; customRow.hidden = true; paintAspects(); });
    aspectBtns.push({ b, p });
    aspects.appendChild(b);
  }
  const fpsSeg = h('div.seg');
  for (const v of [24, 25, 30, 60]) {
    const b = h('button' + (v === fpsVal ? '.on.accent' : ''), { type: 'button', title: `${v} פריימים לשנייה` }, `${v}`);
    b.addEventListener('click', () => { fpsVal = v; for (const x of fpsSeg.children) x.classList.remove('on', 'accent'); b.classList.add('on', 'accent'); });
    fpsSeg.appendChild(b);
  }
  const cw = h('input.input.mono', { type: 'number', value: 1080, min: 16, max: 8192, step: 2, dir: 'ltr', 'aria-label': 'רוחב' });
  const ch = h('input.input.mono', { type: 'number', value: 1920, min: 16, max: 8192, step: 2, dir: 'ltr', 'aria-label': 'גובה' });
  const customRow = h('div.field-row', { hidden: true }, h('label.field', h('span', 'רוחב'), cw), h('label.field', h('span', 'גובה'), ch));
  customSw.addEventListener('change', () => { customRow.hidden = !customSw.checked; paintAspects(); });
  paintAspects();
  const defTracks = h('input', { type: 'checkbox', checked: true });
  const adv = h('details.pm-adv',
    h('summary', 'הגדרות מתקדמות'),
    h('div.pm-adv-body',
      h('div.row', h('span.lbl', 'קצב פריימים'), fpsSeg),
      h('label.row', { style: 'cursor:pointer' }, h('span.switch', customSw, h('span.track')), h('span', 'גודל מותאם')),
      customRow,
      h('label.row', { style: 'cursor:pointer' }, h('span.switch', defTracks, h('span.track')), h('span', { title: 'טקסט, שכבה, ראשי, קריינות, מוזיקה, אפקטים קוליים (רצועות ריקות לא מוצגות בציר הזמן)' }, 'רצועות ברירת מחדל')),
    ));
  for (const el of [name, cw, ch]) el.addEventListener('keydown', (e) => e.stopPropagation());

  const create = async (btn) => {
    const nm = name.value.trim() || 'פרויקט חדש';
    let w = preset.w; let hh = preset.h;
    if (customSw.checked) { w = Math.round(Number(cw.value) / 2) * 2; hh = Math.round(Number(ch.value) / 2) * 2; }
    if (!(w >= 16 && hh >= 16 && w <= 8192 && hh <= 8192)) { toast('גודל הפריים לא תקין', { type: 'error' }); return; }
    store.set('fs.lastPreset', preset.id);
    if (btn) btn.disabled = true;
    try {
      const p = await api.post('/api/projects', { name: nm, width: w, height: hh, fps: fpsVal, tracks: defTracks.checked ? 'default' : 'empty' });
      const pid = p?.id || p?.project?.id;
      if (!pid) throw new Error('השרת לא החזיר מזהה פרויקט');
      goToProject(pid);
    } catch (e) {
      toast(`יצירת הפרויקט נכשלה: ${e.message}`, { type: 'error' });
      if (btn) btn.disabled = false;
    }
  };
  const dlg = modal({
    title: 'פרויקט חדש', width: 460, cls: 'pm-dialog',
    body: [h('label.field', h('span', 'שם'), name), h('div.field', h('span.field-lbl', 'פורמט'), aspects), adv],
    actions: [
      { label: 'ביטול', ghost: true },
      { label: 'יצירה', primary: true, icon: 'plus', id: 'create', onClick: async (closeDlg, btn) => { await create(btn); return false; } },
    ],
  });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') dlg.el.querySelector('[data-action="create"]')?.click(); });
  setTimeout(() => name.select(), 60);
  return dlg;
}

export function goToProject(id) {
  const u = new URL(location.href);
  u.searchParams.set('project', id);
  location.href = u.toString();
}
