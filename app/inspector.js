// Frame Studio — app/inspector.js (owner: U)
// Property panels for the selected clip(s) / project settings (SPEC §6).
// Every numeric field = scrub label + slider + number. Keyframes: one "add keyframe" diamond per section header
// (adds keyframes for that section's props at the playhead); a per-row ‹ ◆ › appears only on rows that already have
// keyframes. At most 4 tabs per clip type; rarely used controls sit in collapsed "מתקדם" / "עוד" areas.
// Live feedback via previewOps (local only), commit on release via applyOps (one history entry).
import { state, on, applyOps, previewOps } from './api.js';
import { h, clear, iconBtn, toast, clamp, round, store, menu, confirmDialog, fmtSec } from './ui-kit.js';
import { icon } from './ui-icons.js';
import * as C from './ui-controls.js';
import * as M from './ui-model.js';
import { loadCatalog, getCatalogSync, groupBy } from './ui-catalog.js';
import { getClipBounds } from './viewer.js';

// ---------------------------------------------------------------- static labels
const TABS = {
  edit: { label: 'עריכה', icon: 'basic' },
  anim: { label: 'אנימציה', icon: 'anim' },
  colorfx: { label: 'צבע ופילטר', icon: 'color' },
  effects: { label: 'אפקטים', icon: 'effect' },
  speed: { label: 'מהירות', icon: 'speed' },
  audio: { label: 'אודיו', icon: 'volume' },
  text: { label: 'טקסט', icon: 'text' },
  caption: { label: 'כתוביות', icon: 'caption' },
  shape: { label: 'צורה', icon: 'shape' },
  sticker: { label: 'מדבקה', icon: 'sticker' },
};
// old tab ids (showTab callers, remembered tabs) → new ones
const TAB_ALIAS = { basic: 'edit', color: 'colorfx', mask: 'colorfx', chroma: 'colorfx' };
const TYPE_ICON = { video: 'video', image: 'image', audio: 'audio', text: 'text', caption: 'caption', shape: 'shape', sticker: 'sticker', effect: 'effect', adjustment: 'adjust' };
const BLENDS = [['normal', 'רגיל'], ['multiply', 'הכפלה'], ['screen', 'מסך'], ['overlay', 'שכבת־על'], ['add', 'הוספה'], ['darken', 'הכהיה'], ['lighten', 'הבהרה'], ['softlight', 'אור רך'], ['difference', 'הפרש']];
const FITS = [{ value: 'contain', label: 'התאמה' }, { value: 'cover', label: 'מילוי' }, { value: 'fill', label: 'מתיחה' }, { value: 'none', label: 'מקורי' }];
const COLOR_KEYS = [
  ['exposure', 'חשיפה'], ['brightness', 'בהירות'], ['contrast', 'ניגודיות'], ['saturation', 'רוויה'], ['vibrance', 'חיוניות'],
  ['temperature', 'טמפרטורה'], ['tint', 'טינט'], ['highlights', 'הבהרות'], ['shadows', 'צללים'], ['hue', 'סיבוב גוון'],
  ['vignette', 'וינייטה'], ['sharpen', 'חדות'], ['grain', 'גרעיניות'], ['fade', 'דהייה'],
];
const COLOR_MAIN = ['brightness', 'contrast', 'saturation', 'temperature', 'highlights', 'shadows'];
const MASKS = [{ id: 'none', name: 'ללא', icon: 'close' }, { id: 'rect', name: 'מלבן', icon: 'rect' }, { id: 'ellipse', name: 'אליפסה', icon: 'ellipse' }, { id: 'linear', name: 'ליניארית', icon: 'minus' }, { id: 'mirror', name: 'מראה', icon: 'flipH' }];
const SHAPE_KINDS = [['rect', 'מלבן'], ['roundrect', 'מלבן מעוגל'], ['ellipse', 'אליפסה'], ['line', 'קו'], ['arrow', 'חץ'], ['star', 'כוכב'], ['triangle', 'משולש'], ['heart', 'לב'], ['burst', 'פיצוץ'], ['progress', 'פס התקדמות']];
// Must match EQ_PRESETS ids in render/audio-engine.js (the engine ignores unknown ids).
const EQ_PRESETS = [['none', 'ללא'], ['voiceClear', 'קול ברור'], ['voiceWarm', 'קול חם'], ['deepVoice', 'קול עמוק'], ['bright', 'בהיר'], ['warm', 'חמים'], ['bassBoost', 'הגברת בס'], ['telephone', 'טלפון'], ['radio', 'רדיו'], ['muffled', 'עמום'], ['musicUnderVoice', 'מוזיקה מתחת לקול'], ['sfxUnderVoice', 'אפקטים מתחת לקול']];
const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 5];
const TEXT_SWATCHES = ['#ffffff', '#000000', '#f2ede4', '#13b6e4', '#ff8a66', '#f5c518', '#ff3b5c', '#2fd27a'];
const TINT_SWATCHES = ['#3a7bd5', '#2fd27a', '#f5c518', '#ff8a66', '#ff3b5c', '#9b6bff', '#13b6e4', '#8a8f98'];
const ASPECTS = [{ value: '1080x1920', label: '9:16' }, { value: '1920x1080', label: '16:9' }, { value: '1080x1080', label: '1:1' }, { value: '1080x1350', label: '4:5' }];
const ROLE_OPTIONS = { video: [['main', 'ראשי'], ['overlay', 'שכבה'], ['text', 'טקסט'], ['effects', 'אפקטים']], audio: [['voice', 'קריינות'], ['music', 'מוזיקה'], ['sfx', 'אפקטים קוליים']] };
const DEF = { 'transform.x': 0, 'transform.y': 0, 'transform.scale': 1, 'transform.scaleX': 1, 'transform.scaleY': 1, 'transform.rotation': 0, 'transform.opacity': 1, volume: 1 };

// ---------------------------------------------------------------- module state
const I = {
  el: null, headEl: null, tabsEl: null, bodyEl: null,
  structKey: '', tab: null, tabType: null, controls: [], catalog: getCatalogSync(),
  lastTabByType: store.get('fs.inspTabs', {}) || {},
  queued: false, busyUntil: 0,
};

export function mount(el) {
  I.el = el;
  el.innerHTML = '';
  I.headEl = h('div.insp-head');
  I.tabsEl = h('div.tabs', { role: 'tablist' });
  I.bodyEl = h('div.insp-body');
  el.append(h('div.insp', I.headEl, I.tabsEl, I.bodyEl));
  on(['project', 'selection'], () => schedule());
  on('playhead', () => schedule());
  loadCatalog().then((cat) => { I.catalog = cat; I.structKey = ''; schedule(); }).catch(() => {});
  render();
}

function schedule() {
  if (I.queued) return;
  I.queued = true;
  requestAnimationFrame(() => { I.queued = false; render(); });
}

// ---------------------------------------------------------------- context helpers
const fps = () => state.project?.settings?.fps || 30;
function selectedClips() {
  const p = state.project; if (!p) return [];
  return [...state.selection].map((id) => p.clips?.[id]).filter(Boolean);
}
const hasKf = (c, prop) => !!c?.keyframes?.[prop]?.length;
const localT = (c, t = state.playhead) => clamp(M.snapToFrame(t - c.start, fps()), 0, c.duration);
const inClip = (c, t = state.playhead) => t >= c.start - 1e-6 && t <= M.clipEnd(c) + 1e-6;
function kfPath(prop) { const m = /^effects\.(\d+)\.(\w+)$/.exec(prop); return m ? `effects.${m[1]}.params.${m[2]}` : prop; }
function baseVal(c, prop, def) { const v = M.getPath(c, kfPath(prop)); return v ?? def ?? DEF[prop]; }
function valAt(c, prop, def, t = state.playhead) {
  const b = baseVal(c, prop, def);
  if (hasKf(c, prop)) return M.evalKeyframed(c, prop, clamp(t - c.start, 0, c.duration), Number.isFinite(b) ? b : 0);
  return b;
}
function kfAt(c, prop, t = state.playhead) {
  const lt = t - c.start; const eps = 0.5 / fps() + 1e-6;
  return (c.keyframes?.[prop] || []).find((k) => Math.abs(k.t - lt) <= eps) || null;
}
/** ops to set a (possibly keyframed) numeric prop at the playhead */
function setNumOps(c, prop, v) {
  if (M.KEYFRAMABLE(prop) && hasKf(c, prop)) return [{ op: 'setKeyframe', id: c.id, prop, t: localT(c), v }];
  const m = /^effects\.(\d+)\.(\w+)$/.exec(prop);
  if (m) return [{ op: 'updateEffect', id: c.id, index: Number(m[1]), params: { [m[2]]: v } }];
  return [{ op: 'updateClip', id: c.id, set: { [prop]: v } }];
}
const setOps = (clips, setMap) => clips.map((c) => ({ op: 'updateClip', id: c.id, set: { ...setMap } }));
const commit = (ops, summary) => { I.busyUntil = 0; return applyOps(ops, summary); };
const preview = (ops) => { I.busyUntil = performance.now() + 400; previewOps(ops); };
function clipName(c) {
  if (!c) return '';
  if (c.name) return c.name;
  if (c.type === 'text' && c.text?.content) return c.text.content.split('\n')[0].slice(0, 40);
  if (c.type === 'caption') return (c.caption?.words || []).map((w) => w.w).join(' ').slice(0, 40) || 'כתובית';
  const m = state.project?.media?.[c.mediaId];
  if (m?.name) return m.name;
  return M.CLIP_TYPE_LABELS[c.type] || c.type;
}

// ---------------------------------------------------------------- render
function render() {
  const p = state.project;
  if (!I.el) return;
  if (!p) { I.structKey = 'none'; clear(I.headEl); clear(I.tabsEl); I.bodyEl.innerHTML = `<div class="insp-empty">טוען פרויקט…</div>`; return; }
  const clips = selectedClips();
  const key = structKeyFor(p, clips);
  if (key === I.structKey) { updateAll(); return; }
  rebuild(p, clips);
  I.structKey = structKeyFor(p, clips); // the chosen tab is part of the key
}

function tabsFor(c, p) {
  void p;
  // "אפקטים" shows up for text / shapes / stickers only once they actually have effects (added from the library)
  const fx = (c.effects || []).length ? ['effects'] : [];
  switch (c.type) {
    case 'video': case 'image': return ['edit', 'anim', 'colorfx', 'effects'];
    case 'audio': return ['audio', 'speed'];
    case 'text': return ['text', 'anim', ...fx];
    case 'caption': return ['caption', 'text', 'anim'];
    case 'shape': return ['shape', 'edit', 'anim', ...fx];
    case 'sticker': return ['sticker', 'edit', 'anim', ...fx];
    case 'effect': return ['effects'];
    case 'adjustment': return ['colorfx', 'effects'];
    default: return ['edit'];
  }
}
function tabsForSelection(clips, p) {
  let tabs = tabsFor(clips[0], p);
  for (const c of clips.slice(1)) { const t = new Set(tabsFor(c, p)); tabs = tabs.filter((x) => t.has(x)); }
  return tabs;
}

function structKeyFor(p, clips) {
  if (!clips.length) {
    return JSON.stringify(['project', (p.tracks || []).map((t) => [t.id, t.kind]), (p.markers || []).map((m) => m.id), I.catalog.loaded]);
  }
  const c0 = clips[0];
  const tabs = tabsForSelection(clips, p);
  const typeKey = clips.length === 1 ? c0.type : 'multi';
  const tab = I.tabType === typeKey && I.tab && tabs.includes(I.tab) ? I.tab : null;
  return JSON.stringify(['clips', clips.map((c) => [c.id, c.type, (c.effects || []).map((e) => e.id).join(','), c.mask?.type, c.shape?.kind, !!c.text?.gradient,
    c.caption?.words?.length, c.caption?.style, c.chroma?.enabled, Object.keys(c.keyframes || {}).filter((k) => c.keyframes[k]?.length).sort().join(','), c.transitionOut?.id, c.sticker?.kind, c.type === 'video' ? M.clipHasAudio(c, p) : 0, c.text?.font, c.filter?.id === 'none']),
  tab, tabs.join(','), I.catalog.loaded, M.trackOf(p, c0)?.locked, nextClip(p, c0)?.id || '']);
}

function rebuild(p, clips) {
  I.controls = [];
  clear(I.headEl); clear(I.tabsEl); clear(I.bodyEl);
  if (!clips.length) {
    const keep = I.scrollKey === 'project' ? I.bodyEl.scrollTop : 0; I.scrollKey = 'project';
    buildProjectHead(p); I.tabsEl.hidden = true; buildProjectPanel(p); updateAll(); I.bodyEl.scrollTop = keep; return;
  }
  I.tabsEl.hidden = false;
  const tabs = tabsForSelection(clips, p);
  const typeKey = clips.length === 1 ? clips[0].type : 'multi';
  // keep the current tab while the same kind of clip stays selected; switching type restores that type's last tab
  let tab = I.tabType === typeKey && I.tab && tabs.includes(I.tab) ? I.tab : null;
  if (!tab) { const r = I.lastTabByType[typeKey]; const remembered = TAB_ALIAS[r] || r; tab = tabs.includes(remembered) ? remembered : tabs[0]; }
  I.tab = tab; I.tabType = typeKey;
  buildClipHead(p, clips);
  if (!tabs.length) { I.bodyEl.innerHTML = '<div class="insp-empty">אין מאפיינים משותפים לקליפים שנבחרו</div>'; return; }
  for (const id of tabs) {
    const t = TABS[id];
    const b = h('button.tab' + (id === tab ? '.on' : ''), { type: 'button', role: 'tab', html: `${icon(t.icon, 14)}<span>${t.label}</span>` });
    b.addEventListener('click', () => { I.tab = id; I.lastTabByType[typeKey] = id; store.set('fs.inspTabs', I.lastTabByType); I.structKey = ''; render(); });
    I.tabsEl.appendChild(b);
  }
  const scrollKey = `${clips.map((c) => c.id).join(',')}|${tab}`;
  const keepScroll = scrollKey === I.scrollKey ? I.bodyEl.scrollTop : 0;
  I.scrollKey = scrollKey;
  const ctx = makeCtx(clips);
  const builder = BUILDERS[tab];
  try { builder(ctx, I.bodyEl); }
  catch (e) { console.error('[inspector] build', tab, e); I.bodyEl.appendChild(h('div.insp-empty', `שגיאה בבניית הלשונית: ${e.message}`)); }
  updateAll();
  I.bodyEl.scrollTop = keepScroll;
}

function updateAll() {
  for (const u of I.controls) { try { u(); } catch (e) { console.warn('[inspector] update', e); } }
}

function makeCtx(clips) {
  return {
    get clips() { const p = state.project; return clips.map((c) => p.clips?.[c.id]).filter(Boolean); },
    get primary() { return state.project.clips?.[clips[0].id] || clips[0]; },
    multi: clips.length > 1,
    reg: (fn) => I.controls.push(fn),
  };
}

// ---------------------------------------------------------------- header
function buildClipHead(p, clips) {
  const c = clips[0];
  const multi = clips.length > 1;
  const typeIc = h('div.insp-type', { html: icon(multi ? 'layers' : TYPE_ICON[c.type] || 'film', 16) });
  const name = h('input.insp-name', { type: 'text', dir: 'auto', spellcheck: false, disabled: multi });
  name.value = multi ? `${clips.length} קליפים נבחרו` : clipName(c);
  name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); if (e.key === 'Escape') { name.value = clipName(state.project.clips[c.id]); name.blur(); } });
  name.addEventListener('change', () => commit([{ op: 'updateClip', id: c.id, set: { name: name.value.trim() } }], 'שינוי שם קליפ'));
  const sub = h('div.insp-sub');
  const titles = h('div.insp-titles', name, sub);
  const disBtn = iconBtn('eye', 'הפעלה / כיבוי קליפ', () => {
    const cl = selectedClips(); const dis = !cl.every((x) => x.disabled);
    commit(setOps(cl, { disabled: dis }), dis ? 'כיבוי קליפ' : 'הפעלת קליפ');
  }, { cls: 'sm' });
  const delBtn = iconBtn('trash', 'מחיקה (Delete)', () => {
    const ids = selectedClips().map((x) => x.id);
    commit([{ op: 'removeClips', ids }], ids.length > 1 ? `מחיקת ${ids.length} קליפים` : 'מחיקת קליפ');
  }, { cls: 'sm' });
  I.headEl.append(typeIc, titles, disBtn, delBtn);

  // timing row (single clip)
  if (!multi) {
    const startF = C.numField({ value: c.start, decimals: 2, step: 1 / fps(), hardMin: 0, title: 'התחלה (ש׳)', onChange: (v) => commit([{ op: 'moveClip', id: c.id, start: M.snapToFrame(v, fps()) }], 'שינוי התחלה') });
    const durF = C.numField({ value: c.duration, decimals: 2, step: 1 / fps(), hardMin: 1 / fps(), title: 'משך (ש׳)', onChange: (v) => { const cc = state.project.clips[c.id]; commit([{ op: 'trimClip', id: c.id, end: M.snapToFrame(cc.start + v, fps()) }], 'שינוי משך'); } });
    const timing = h('div.pair', { style: 'margin-top:4px' }, h('span.lbl', 'התחלה'), startF.el, h('span.lbl', 'משך'), durF.el);
    titles.appendChild(timing);
    I.controls.push(() => {
      const cc = state.project.clips[c.id]; if (!cc) return;
      startF.set(round(cc.start, 2)); durF.set(round(cc.duration, 2));
      const tr = M.trackOf(state.project, cc);
      sub.textContent = `${M.CLIP_TYPE_LABELS[cc.type] || cc.type}${tr ? ' · ' + (tr.name || M.ROLE_LABELS[tr.role] || '') : ''}${tr?.locked ? ' · נעולה' : ''}`;
      if (document.activeElement !== name) name.value = clipName(cc);
      disBtn.innerHTML = icon(cc.disabled ? 'eyeOff' : 'eye', 16);
      disBtn.classList.toggle('on', !cc.disabled ? false : true);
    });
  } else {
    I.controls.push(() => {
      const cl = selectedClips();
      const types = [...new Set(cl.map((x) => M.CLIP_TYPE_LABELS[x.type] || x.type))];
      sub.textContent = types.join(' · ');
      disBtn.innerHTML = icon(cl.every((x) => x.disabled) ? 'eyeOff' : 'eye', 16);
    });
  }
}

function buildProjectHead(p) {
  const ic = h('div.insp-type', { html: icon('gear', 16) });
  const t = h('div.insp-titles', h('div', { style: 'font-weight:600;font-size:13px' }, 'הגדרות פרויקט'), h('div.insp-sub', 'לא נבחר קליפ — בחרו קליפ כדי לערוך אותו'));
  I.headEl.append(ic, t);
}

// ---------------------------------------------------------------- generic numeric row
/**
 * spec: {label, prop, min, max, step, unit, decimals, toD, fromD, curve, centered, kf (bool), def, summary,
 *        get(c)→value (custom read, no keyframes), ops(clips, v)→ops (custom write), group (kfGroup of the section)}
 */
function numRow(ctx, parent, spec) {
  const toD = spec.toD || ((v) => v); const fromD = spec.fromD || ((d) => d);
  const kfEnabled = spec.kf ?? (M.KEYFRAMABLE(spec.prop) && !spec.ops && !spec.get);
  const read = (c) => (spec.get ? spec.get(c) : valAt(c, spec.prop, spec.def));
  const build = (v) => (spec.ops ? spec.ops(ctx.clips, v) : ctx.clips.flatMap((c) => setNumOps(c, spec.prop, v)));
  const dMin = spec.min; const dMax = spec.max;
  const dec = spec.decimals ?? (spec.step && spec.step < 1 ? 2 : 0);
  let lastD = null;
  const sl = C.slider({
    min: dMin, max: dMax, step: spec.step, curve: spec.curve, centered: spec.centered, defaultValue: spec.defaultD,
    onInput: (d) => { num.set(d); preview(build(fromD(d))); },
    onChange: (d) => commit(build(fromD(d)), `${spec.summary || spec.label}: ${round(d, dec)}${spec.unit || ''}`),
  });
  const num = C.numField({
    value: 0, decimals: dec, step: spec.step || 1, hardMin: spec.hardMin ?? (spec.clampNum ? dMin : -Infinity), hardMax: spec.hardMax ?? (spec.clampNum ? dMax : Infinity),
    onChange: (d) => { sl.set(d); commit(build(fromD(d)), `${spec.summary || spec.label}: ${round(d, dec)}${spec.unit || ''}`); },
  });
  const parts = [sl.el, num.el];
  if (spec.unit) parts.push(h('span.unit', spec.unit));
  const r = C.row(spec.label, ...parts);
  C.scrubLabel(r.lbl, {
    get: () => lastD, step: spec.scrubStep || spec.step || ((dMax - dMin) / 300), min: spec.hardMin ?? -Infinity, max: spec.hardMax ?? Infinity,
    onPreview: (d) => { sl.set(d); num.set(d); preview(build(fromD(d))); },
    onCommit: (d) => commit(build(fromD(d)), `${spec.summary || spec.label}: ${round(d, dec)}${spec.unit || ''}`),
  });
  let kfUi = null;
  if (kfEnabled && spec.group) spec.group.add(spec.prop, spec.def);
  if (kfEnabled && ctx.clips.some((c) => hasKf(c, spec.prop))) { kfUi = kfControl(ctx, spec.prop, () => read(ctx.primary)); r.el.appendChild(kfUi.el); }
  parent.appendChild(r.el);
  if (kfUi) parent.appendChild(kfUi.easeRow);
  ctx.reg(() => {
    const cl = ctx.clips; if (!cl.length) return;
    let v = read(cl[0]);
    if (!Number.isFinite(v) && spec.defaultD != null) v = fromD(spec.defaultD);
    const d = Number.isFinite(v) ? toD(v) : null;
    const mixed = cl.length > 1 && cl.some((c) => { const o = read(c); return !Number.isFinite(o) || Math.abs(toD(o) - d) > 1e-6; });
    if (d != null && d !== lastD && !sl.el.matches(':active')) { sl.set(d); }
    if (d !== lastD || mixed) num.set(d, mixed);
    lastD = d;
    r.el.classList.toggle('mixed', mixed);
    if (kfUi) { kfUi.update(); r.el.classList.toggle('kf-on', hasKf(cl[0], spec.prop)); }
  });
  return r;
}

/** ‹ ◆ › keyframe control (rows that already have keyframes) + ease selector when a keyframe sits under the playhead */
function kfControl(ctx, prop, readCurrent) {
  const prev = iconBtn('chevRight', 'מפתח קודם', () => jump(-1), { cls: 'kf-nav', size: 12 });
  const dia = iconBtn('diamond', 'הוספה / הסרה של מפתח (keyframe) בסמן', () => toggle(), { cls: 'kf-dia', size: 13 });
  const next = iconBtn('chevLeft', 'מפתח הבא', () => jump(1), { cls: 'kf-nav', size: 12 });
  const ease = h('select.select.ease-sel', { title: 'עקומת האצה בכניסה למפתח שבסמן' });
  for (const [id, label] of Object.entries(M.EASING_LABELS)) ease.appendChild(h('option', { value: id }, label));
  ease.addEventListener('keydown', (e) => e.stopPropagation());
  ease.addEventListener('change', () => {
    const ops = [];
    for (const c of ctx.clips) { const k = kfAt(c, prop); if (k) ops.push({ op: 'setKeyframe', id: c.id, prop, t: k.t, v: k.v, ease: ease.value }); }
    if (ops.length) commit(ops, `עקומת מפתח: ${M.EASING_LABELS[ease.value]}`);
  });
  const el = h('div.kf', prev, dia, next);
  const easeRow = h('div.row.ease-row', { hidden: true }, h('span.lbl', 'עקומה'), h('span.ease-ic', { html: icon('diamondFill', 10) }), ease);
  function toggle() {
    const cl = ctx.clips; const c0 = cl[0];
    if (!inClip(c0)) { toast('הסמן מחוץ לקליפ — הזיזו את הסמן לתוך הקליפ כדי להוסיף מפתח', { type: 'warn' }); return; }
    const existing = kfAt(c0, prop);
    const ops = [];
    for (const c of cl) {
      if (!inClip(c)) continue;
      const k = kfAt(c, prop);
      if (existing) { if (k) ops.push({ op: 'removeKeyframe', id: c.id, prop, t: k.t }); }
      else {
        const v = valAt(c, prop, DEF[prop]);
        ops.push({ op: 'setKeyframe', id: c.id, prop, t: localT(c), v: Number.isFinite(v) ? v : 0, ease: 'easeInOut' });
      }
    }
    commit(ops, existing ? 'הסרת מפתח' : 'הוספת מפתח');
  }
  function jump(dir) {
    const c = ctx.primary; const kfs = [...(c.keyframes?.[prop] || [])].sort((a, b) => a.t - b.t);
    const lt = state.playhead - c.start; const eps = 0.5 / fps();
    const k = dir < 0 ? [...kfs].reverse().find((x) => x.t < lt - eps) : kfs.find((x) => x.t > lt + eps);
    if (k) state.set({ playhead: c.start + k.t });
  }
  return {
    el, easeRow,
    update() {
      const c = ctx.primary; const kfs = c.keyframes?.[prop] || [];
      const at = kfAt(c, prop);
      const lt = state.playhead - c.start; const eps = 0.5 / fps();
      dia.disabled = !inClip(c);
      dia.classList.toggle('has', kfs.length > 0);
      dia.classList.toggle('at', !!at);
      const want = at ? 'diamondFill' : 'diamond';
      if (dia.dataset.ic !== want) { dia.innerHTML = icon(want, 13); dia.dataset.ic = want; }
      prev.disabled = !kfs.some((x) => x.t < lt - eps);
      next.disabled = !kfs.some((x) => x.t > lt + eps);
      const first = [...kfs].sort((a, b) => a.t - b.t)[0];
      easeRow.hidden = !at || at === first;
      if (at && document.activeElement !== ease) ease.value = at.ease || 'linear';
    },
  };
}

// generic select/color/switch rows bound to a clip path
function selectRow(ctx, parent, label, path, options, summary, { onValue, numeric } = {}) {
  const sel = C.selectField({
    options: options.map(([value, lab]) => ({ value, label: lab })), numeric,
    onChange: (v) => commit(onValue ? onValue(ctx.clips, v) : setOps(ctx.clips, { [path]: v }), `${summary || label}: ${options.find((o) => String(o[0]) === String(v))?.[1] ?? v}`),
  });
  const r = C.row(label, sel.el);
  parent.appendChild(r.el);
  ctx.reg(() => { if (document.activeElement !== sel.el) sel.set(M.getPath(ctx.primary, path) ?? options[0][0]); });
  return sel;
}
function colorRow(ctx, parent, label, path, { alpha = false, swatchList = null, eyedropper = false, summary, def = '#ffffff' } = {}) {
  const cf = C.colorField({
    value: M.getPath(ctx.primary, path) || def, alpha, eyedropper,
    onInput: (v) => preview(setOps(ctx.clips, { [path]: v })),
    onChange: (v) => commit(setOps(ctx.clips, { [path]: v }), summary || label),
  });
  const r = C.row(label, cf.el);
  parent.appendChild(r.el);
  if (swatchList) {
    const sw = h('div', { style: 'padding-inline-start:82px' });
    parent.appendChild(sw);
    const paintSw = () => { clear(sw); sw.appendChild(C.swatches(swatchList, (c) => commit(setOps(ctx.clips, { [path]: c }), summary || label), M.getPath(ctx.primary, path))); };
    paintSw();
    let lastSw = M.getPath(ctx.primary, path);
    ctx.reg(() => { const v = M.getPath(ctx.primary, path); if (v !== lastSw) { lastSw = v; paintSw(); } });
  }
  ctx.reg(() => cf.set(M.getPath(ctx.primary, path) || def));
  return cf;
}
function switchRow(ctx, parent, label, path, summaryOn, summaryOff) {
  const sw = C.switchField({ value: !!M.getPath(ctx.primary, path), onChange: (v) => commit(setOps(ctx.clips, { [path]: v }), v ? (summaryOn || label) : (summaryOff || `${label} כבוי`)) });
  const r = C.row(label, h('span.grow'), sw.el);
  r.el.classList.add('switch-row');
  parent.appendChild(r.el);
  ctx.reg(() => sw.set(!!M.getPath(ctx.primary, path)));
  return sw;
}
const pct = { toD: (v) => v * 100, fromD: (d) => d / 100, unit: '%' };
const signedPct = { toD: (v) => v * 100, fromD: (d) => d / 100, unit: '' };
function emptyCat(parent, text) { parent.appendChild(h('div.empty-cat', text)); }

// ---------------------------------------------------------------- keyframe group (one diamond per section header)
/**
 * Collects the keyframable props of one section. The first prop adds a small diamond button to `host`
 * (section actions / effect card head): click → keyframe every prop of the group at the playhead
 * (or remove them when all already have a keyframe there).
 */
function kfGroup(ctx, host) {
  const props = [];
  let btn = null;
  const allAt = () => { const c = ctx.primary; return props.length > 0 && props.every(({ prop }) => !!kfAt(c, prop)); };
  function toggle() {
    const cl = ctx.clips; const c0 = cl[0];
    if (!c0 || !inClip(c0)) { toast('הזיזו את סמן הניגון לתוך הקליפ כדי להוסיף קיפריים', { type: 'warn' }); return; }
    const remove = allAt();
    const ops = [];
    for (const c of cl) {
      if (!inClip(c)) continue;
      for (const { prop, def } of props) {
        const k = kfAt(c, prop);
        if (remove) { if (k) ops.push({ op: 'removeKeyframe', id: c.id, prop, t: k.t }); }
        else if (!k) {
          const v = valAt(c, prop, def ?? DEF[prop]);
          ops.push({ op: 'setKeyframe', id: c.id, prop, t: localT(c), v: Number.isFinite(v) ? v : 0, ease: 'easeInOut' });
        }
      }
    }
    if (ops.length) commit(ops, remove ? 'הסרת קיפריים' : 'הוספת קיפריים');
  }
  return {
    add(prop, def) {
      props.push({ prop, def });
      if (btn) return;
      btn = iconBtn('diamondPlus', 'הוסף קיפריים — לכל המאפיינים כאן, בנקודת הסמן', () => toggle(), { cls: 'xs kf-sec', size: 14 });
      host.prepend(btn);
      ctx.reg(() => {
        const at = allAt();
        btn.disabled = !inClip(ctx.primary);
        btn.classList.toggle('at', at);
        const want = at ? 'diamondFill' : 'diamondPlus';
        if (btn.dataset.ic !== want) { btn.innerHTML = icon(want, 14); btn.dataset.ic = want; }
        const t = at ? 'הסרת הקיפריים שבנקודת הסמן' : 'הוסף קיפריים — לכל המאפיינים כאן, בנקודת הסמן';
        if (btn.title !== t) { btn.title = t; btn.setAttribute('aria-label', t); }
      });
    },
  };
}

/** "עוד" disclosure inside a section: rarely used rows stay out of the way. force → open (e.g. a hidden value is set). */
function more(parent, key, { force = false, label = 'עוד' } = {}) {
  const k = `fs.more.${key}`;
  const saved = store.get(k, null);
  let isOpen = force || !!saved;
  const btn = h('button.more-btn', { type: 'button' });
  const body = h('div.more-body');
  const paint = () => {
    btn.innerHTML = `<span>${isOpen ? 'פחות' : label}</span>${icon(isOpen ? 'chevUp' : 'chevDown', 12)}`;
    btn.setAttribute('aria-expanded', String(isOpen));
    btn.title = isOpen ? 'הסתרת האפשרויות הנוספות' : 'אפשרויות נוספות';
    body.hidden = !isOpen;
  };
  btn.addEventListener('click', () => { isOpen = !isOpen; store.set(k, isOpen); paint(); });
  paint();
  parent.append(btn, body);
  return body;
}
const subTitle = (parent, text, ...extra) => { const el = h('div.sub-head', h('span.sub-title', text), ...extra); parent.appendChild(el); return el; };

// ---------------------------------------------------------------- tab: edit (video / image / shape / sticker)
function buildEdit(ctx, body) {
  const media = ctx.clips.every((c) => c.type === 'video' || c.type === 'image');
  buildTransformSection(ctx, body, { fit: media });
  if (ctx.clips.every((c) => c.type === 'video')) {
    const s = C.section('מהירות', { icon: 'speed', key: 'edit.speed' });
    body.appendChild(s.el);
    speedControls(ctx, s.body, { compact: true });
  }
  if (ctx.clips.every((c) => c.type === 'video' && M.clipHasAudio(c, state.project))) {
    const s = C.section('שמע', { icon: 'volume', key: 'edit.audio' });
    body.appendChild(s.el);
    volumeRows(ctx, s.body, s.actions);
    switchRow(ctx, s.body, 'השתקת קול הווידאו', 'muteAudio', 'השתקת קול הווידאו', 'הפעלת קול הווידאו');
    const s2 = C.section('שיפור קול', { icon: 'mic', key: 'edit.audiofx', open: false });
    body.appendChild(s2.el);
    audioFxRows(ctx, s2.body);
  }
  if (!media) buildAdvanced(ctx, body, { mask: true, blend: true });
  clipSection(ctx, body);
}

function buildTransformSection(ctx, body, { fit = false, open = true, key = 'edit.transform' } = {}) {
  const p = state.project; const W = p.settings?.width || 1080; const H = p.settings?.height || 1920;
  const c0 = ctx.primary;
  const s1 = C.section('מיקום וגודל', { icon: 'move', key, open, actions: [iconBtn('reset', 'איפוס מיקום וגודל', () => resetTransform(ctx), { cls: 'xs', size: 13 })] });
  body.appendChild(s1.el);
  const g = kfGroup(ctx, s1.actions);
  numRow(ctx, s1.body, { label: 'מיקום X', prop: 'transform.x', min: -W, max: W, step: 1, unit: 'px', centered: true, defaultD: 0, group: g });
  numRow(ctx, s1.body, { label: 'מיקום Y', prop: 'transform.y', min: -H, max: H, step: 1, unit: 'px', centered: true, defaultD: 0, group: g });
  numRow(ctx, s1.body, { label: 'גודל', prop: 'transform.scale', min: 1, max: 400, step: 1, ...pct, hardMin: 1, defaultD: 100, scrubStep: 0.5, group: g });
  numRow(ctx, s1.body, { label: 'סיבוב', prop: 'transform.rotation', min: -360, max: 360, step: 0.5, unit: '°', centered: true, decimals: 1, defaultD: 0, group: g });
  numRow(ctx, s1.body, { label: 'שקיפות', prop: 'transform.opacity', min: 0, max: 100, step: 1, ...pct, hardMin: 0, hardMax: 100, defaultD: 100, group: g });

  // rarely used: separate width / height scale, fit, align, flip
  const odd = ctx.clips.some((c) => (c.transform?.scaleX ?? 1) !== 1 || (c.transform?.scaleY ?? 1) !== 1 || hasKf(c, 'transform.scaleX') || hasKf(c, 'transform.scaleY'));
  const mb = more(s1.body, key, { force: odd });
  numRow(ctx, mb, { label: 'רוחב (X)', prop: 'transform.scaleX', min: 1, max: 400, step: 1, ...pct, hardMin: 1, defaultD: 100, scrubStep: 0.5 });
  numRow(ctx, mb, { label: 'גובה (Y)', prop: 'transform.scaleY', min: 1, max: 400, step: 1, ...pct, hardMin: 1, defaultD: 100, scrubStep: 0.5 });
  if (fit) {
    const fitSeg = C.segField(FITS, { block: true, accent: true, value: c0.fit, onChange: (v) => commit(setOps(ctx.clips, { fit: v }), `התאמה: ${FITS.find((f) => f.value === v)?.label}`) });
    mb.appendChild(C.row('התאמה', fitSeg.el).el);
    ctx.reg(() => fitSeg.set(ctx.primary.fit || 'cover'));
  }
  const flipH = iconBtn('flipH', 'היפוך אופקי', () => { const v = !ctx.primary.transform?.flipX; commit(setOps(ctx.clips, { 'transform.flipX': v }), 'היפוך אופקי'); });
  const flipV = iconBtn('flipV', 'היפוך אנכי', () => { const v = !ctx.primary.transform?.flipY; commit(setOps(ctx.clips, { 'transform.flipY': v }), 'היפוך אנכי'); });
  const align = (mode) => alignClips(ctx, mode);
  mb.appendChild(h('div.row',
    h('span.lbl', 'יישור'),
    h('div.seg.icons',
      mkSegBtn('alignRight', 'יישור לקצה הימני של הפריים', () => align('right')), mkSegBtn('alignCenter', 'מרכוז אופקי', () => align('hcenter')), mkSegBtn('alignLeft', 'יישור לקצה השמאלי', () => align('left')),
      mkSegBtn('arrowUp', 'יישור לקצה העליון', () => align('top')), mkSegBtn('move', 'מרכוז מלא', () => align('center')), mkSegBtn('arrowDown', 'יישור לקצה התחתון', () => align('bottom')),
    )));
  mb.appendChild(h('div.row', h('span.lbl', 'היפוך'), flipH, flipV));
  ctx.reg(() => { flipH.classList.toggle('on', !!ctx.primary.transform?.flipX); flipV.classList.toggle('on', !!ctx.primary.transform?.flipY); });
  return s1;
}

/** collapsed "מתקדם": LUT, chroma key, mask, blend, crop — whichever apply */
function buildAdvanced(ctx, body, { lut = false, chroma = false, mask = false, blend = false, crop = false } = {}) {
  const c0 = ctx.primary;
  const s = C.section('מתקדם', { icon: 'gear', key: 'adv', open: false });
  body.appendChild(s.el);
  const b = s.body;
  if (lut) {
    const luts = I.catalog.luts;
    subTitle(b, 'LUT');
    const sel = C.selectField({
      options: [{ value: '', label: 'ללא LUT' }, ...luts.map((l) => ({ value: l.file, label: l.name }))],
      onChange: (v) => commit(setOps(ctx.clips, { 'lut.file': v || null }), v ? `LUT: ${luts.find((l) => l.file === v)?.name || v}` : 'הסרת LUT'),
    });
    b.appendChild(C.row('קובץ', sel.el).el);
    ctx.reg(() => sel.set(ctx.primary.lut?.file || ''));
    if (!luts.length) b.appendChild(h('div.note', 'לא נמצאו קובצי ‎.cube בתיקיית library/luts'));
    if (c0.lut?.file) numRow(ctx, b, { label: 'עוצמה', prop: 'lut.amount', min: 0, max: 100, step: 1, ...pct, kf: false, defaultD: 100 });
  }
  if (chroma) {
    const sw = C.switchField({ value: !!c0.chroma?.enabled, title: 'הפעלה / כיבוי', onChange: (v) => commit(setOps(ctx.clips, { 'chroma.enabled': v }), v ? 'הפעלת מפתח כרום' : 'כיבוי מפתח כרום') });
    subTitle(b, 'מפתח כרום (מסך ירוק)', h('span.grow'), sw.el);
    ctx.reg(() => sw.set(!!ctx.primary.chroma?.enabled));
    if (c0.chroma?.enabled) {
      colorRow(ctx, b, 'צבע מפתח', 'chroma.color', { eyedropper: true, swatchList: ['#00ff00', '#00b140', '#0047bb', '#0000ff'], summary: 'צבע מפתח כרום', def: '#00ff00' });
      numRow(ctx, b, { label: 'דמיון', prop: 'chroma.similarity', min: 0, max: 100, step: 0.5, ...pct, kf: false, decimals: 1, defaultD: 35 });
      numRow(ctx, b, { label: 'החלקה', prop: 'chroma.smoothness', min: 0, max: 100, step: 0.5, ...pct, kf: false, decimals: 1, defaultD: 8 });
      numRow(ctx, b, { label: 'דיכוי זליגה', prop: 'chroma.spill', min: 0, max: 100, step: 0.5, ...pct, kf: false, decimals: 1, defaultD: 50 });
    }
  }
  if (mask) {
    subTitle(b, 'מסכה');
    const g = C.chipGrid(MASKS, { small: true, value: c0.mask?.type || 'none', onPick: (id) => commit(setOps(ctx.clips, { 'mask.type': id }), `מסכה: ${MASKS.find((m) => m.id === id)?.name}`) });
    b.appendChild(g.el);
    ctx.reg(() => g.set(ctx.primary.mask?.type || 'none'));
    const mt = c0.mask?.type || 'none';
    if (mt !== 'none') {
      numRow(ctx, b, { label: 'מרכז X', prop: 'mask.x', min: -100, max: 100, step: 0.5, ...pct, centered: true, kf: false, decimals: 1, defaultD: 0 });
      numRow(ctx, b, { label: 'מרכז Y', prop: 'mask.y', min: -100, max: 100, step: 0.5, ...pct, centered: true, kf: false, decimals: 1, defaultD: 0 });
      if (mt !== 'linear' && mt !== 'mirror') {
        numRow(ctx, b, { label: 'רוחב', prop: 'mask.w', min: 1, max: 200, step: 0.5, ...pct, kf: false, decimals: 1, defaultD: 60 });
        numRow(ctx, b, { label: 'גובה', prop: 'mask.h', min: 1, max: 200, step: 0.5, ...pct, kf: false, decimals: 1, defaultD: 60 });
      } else numRow(ctx, b, { label: mt === 'mirror' ? 'רוחב הרצועה' : 'מיקום', prop: 'mask.w', min: 1, max: 200, step: 0.5, ...pct, kf: false, decimals: 1, defaultD: 60 });
      numRow(ctx, b, { label: 'סיבוב', prop: 'mask.rotation', min: -180, max: 180, step: 0.5, unit: '°', centered: true, kf: false, decimals: 1, defaultD: 0 });
      numRow(ctx, b, { label: 'ריכוך', prop: 'mask.feather', min: 0, max: 100, step: 0.5, ...pct, kf: false, decimals: 1, defaultD: 5 });
      switchRow(ctx, b, 'היפוך מסכה', 'mask.invert', 'היפוך מסכה', 'ביטול היפוך מסכה');
    }
  }
  if (blend) {
    subTitle(b, 'מיזוג ועוגן');
    selectRow(ctx, b, 'מצב מיזוג', 'blend', BLENDS, 'מצב מיזוג');
    numRow(ctx, b, { label: 'עוגן X', prop: 'transform.anchorX', min: 0, max: 100, step: 1, ...pct, kf: false, defaultD: 50 });
    numRow(ctx, b, { label: 'עוגן Y', prop: 'transform.anchorY', min: 0, max: 100, step: 1, ...pct, kf: false, defaultD: 50 });
  }
  if (crop) {
    const head = subTitle(b, 'חיתוך', h('span.grow'));
    const g = kfGroup(ctx, head);
    for (const k of ['l', 'r', 't', 'b']) {
      // NOTE: crop.l is the source's left edge; in the RTL panel we label by visual side for clarity
      const label = k === 'l' ? 'חיתוך שמאל' : k === 'r' ? 'חיתוך ימין' : k === 't' ? 'חיתוך עליון' : 'חיתוך תחתון';
      numRow(ctx, b, { label, prop: `crop.${k}`, min: 0, max: 90, step: 0.5, ...pct, hardMin: 0, hardMax: 95, decimals: 1, defaultD: 0, group: g });
    }
  }
  return s;
}

/** collapsed "קליפ": timeline colour, enabled, clear keyframes */
function clipSection(ctx, body) {
  const c0 = ctx.primary;
  const s4 = C.section('קליפ', { icon: 'film', key: 'edit.clip', open: false });
  body.appendChild(s4.el);
  const tint = h('div.row', h('span.lbl', 'צבע בציר'), C.swatches(TINT_SWATCHES, (col) => commit(setOps(ctx.clips, { tint: col }), 'צבע קליפ בציר הזמן'), c0.tint || ''),
    iconBtn('close', 'ללא צבע', () => commit(setOps(ctx.clips, { tint: null }), 'ניקוי צבע קליפ'), { cls: 'xs', size: 12 }));
  s4.body.appendChild(tint);
  switchRow(ctx, s4.body, 'כבוי', 'disabled', 'כיבוי קליפ', 'הפעלת קליפ');
  if (Object.keys(c0.keyframes || {}).some((k) => c0.keyframes[k]?.length)) {
    s4.body.appendChild(h('div.btn-row', h('button.btn.btn-sm', { type: 'button', on: { click: () => commit(ctx.clips.map((c) => ({ op: 'clearKeyframes', id: c.id })), 'ניקוי כל הקיפריימים') } }, 'ניקוי כל הקיפריימים')));
  }
}
function mkSegBtn(ic, title, fn) { const b = h('button', { type: 'button', title, 'aria-label': title, html: icon(ic, 14) }); b.addEventListener('click', fn); return b; }

function resetTransform(ctx) {
  const ops = [];
  for (const c of ctx.clips) {
    for (const prop of ['transform.x', 'transform.y', 'transform.scale', 'transform.scaleX', 'transform.scaleY', 'transform.rotation', 'transform.opacity']) {
      if (hasKf(c, prop)) ops.push({ op: 'clearKeyframes', id: c.id, prop });
    }
    ops.push({ op: 'updateClip', id: c.id, set: { 'transform.x': 0, 'transform.y': 0, 'transform.scale': 1, 'transform.scaleX': 1, 'transform.scaleY': 1, 'transform.rotation': 0, 'transform.opacity': 1, 'transform.flipX': false, 'transform.flipY': false } });
  }
  commit(ops, 'איפוס טרנספורם');
}

function alignClips(ctx, mode) {
  const p = state.project; const W = p.settings?.width || 1080; const H = p.settings?.height || 1920;
  const ops = [];
  for (const c of ctx.clips) {
    const x = valAt(c, 'transform.x'); const y = valAt(c, 'transform.y');
    const b = getClipBounds(c.id, state.playhead);
    let nx = x; let ny = y;
    if (mode === 'center') { nx = 0; ny = 0; }
    else if (mode === 'hcenter') nx = 0;
    else if (b) {
      const xs = b.corners.map((q) => q[0]); const ys = b.corners.map((q) => q[1]);
      const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys);
      if (mode === 'left') nx = x - minX;
      if (mode === 'right') nx = x + (W - maxX);
      if (mode === 'top') ny = y - minY;
      if (mode === 'bottom') ny = y + (H - maxY);
    } else { toast('לא ניתן לחשב גבולות לקליפ בזמן הנוכחי', { type: 'warn' }); return; }
    ops.push(...setNumOps(c, 'transform.x', Math.round(nx)), ...setNumOps(c, 'transform.y', Math.round(ny)));
  }
  commit(ops, 'יישור קליפ');
}

// ---------------------------------------------------------------- tab: animation
function animChips(ctx, parent, list, current, onPick) {
  if (!list.length) { emptyCat(parent, 'הקטלוג לא נטען — אין אנימציות זמינות'); return null; }
  const items = list.map((a) => ({ id: a.id, name: a.name || a.id, icon: a.id === 'none' ? 'close' : undefined }));
  if (!items.some((x) => x.id === 'none')) items.unshift({ id: 'none', name: 'ללא', icon: 'close' });
  const g = C.chipGrid(items, { value: current(), onPick, small: false });
  parent.appendChild(g.el);
  ctx.reg(() => g.set(current()));
  return g;
}

function buildAnim(ctx, body) {
  const cat = I.catalog;
  const s1 = C.section('כניסה', { icon: 'arrowDown', key: 'anim.in' });
  body.appendChild(s1.el);
  animChips(ctx, s1.body, cat.clipAnims.in, () => ctx.primary.animIn?.id || 'none', (id) => commit(setOps(ctx.clips, { 'animIn.id': id }), `אנימציית כניסה: ${nameOf(cat.clipAnims.in, id)}`));
  numRow(ctx, s1.body, { label: 'משך', prop: 'animIn.duration', min: 0.1, max: 3, step: 0.05, unit: 'ש׳', decimals: 2, kf: false, defaultD: 0.4 });
  const s2 = C.section('יציאה', { icon: 'arrowUp', key: 'anim.out' });
  body.appendChild(s2.el);
  animChips(ctx, s2.body, cat.clipAnims.out, () => ctx.primary.animOut?.id || 'none', (id) => commit(setOps(ctx.clips, { 'animOut.id': id }), `אנימציית יציאה: ${nameOf(cat.clipAnims.out, id)}`));
  numRow(ctx, s2.body, { label: 'משך', prop: 'animOut.duration', min: 0.1, max: 3, step: 0.05, unit: 'ש׳', decimals: 2, kf: false, defaultD: 0.4 });
  const s3 = C.section('לולאה', { icon: 'loop', key: 'anim.loop', open: false });
  body.appendChild(s3.el);
  animChips(ctx, s3.body, cat.clipAnims.loop, () => ctx.primary.animLoop?.id || 'none', (id) => commit(setOps(ctx.clips, { 'animLoop.id': id }), `אנימציית לולאה: ${nameOf(cat.clipAnims.loop, id)}`));
  numRow(ctx, s3.body, { label: 'מהירות', prop: 'animLoop.speed', min: 0.1, max: 4, step: 0.05, unit: '×', decimals: 2, kf: false, defaultD: 1 });
  numRow(ctx, s3.body, { label: 'עוצמה', prop: 'animLoop.intensity', min: 0, max: 200, step: 1, ...pct, kf: false, defaultD: 100 });

  if (ctx.clips.every((c) => c.type === 'text' || c.type === 'caption')) {
    const s4 = C.section('אנימציית טקסט (מילים / אותיות)', { icon: 'text', key: 'anim.text' });
    body.appendChild(s4.el);
    for (const [slot, label] of [['in', 'כניסה'], ['out', 'יציאה'], ['loop', 'לולאה']]) {
      s4.body.appendChild(h('div.sub-title', label));
      animChips(ctx, s4.body, cat.textAnims[slot], () => ctx.primary.textAnim?.[slot] || 'none', (id) => commit(setOps(ctx.clips, { [`textAnim.${slot}`]: id }), `אנימציית טקסט (${label}): ${nameOf(cat.textAnims[slot], id)}`));
    }
    numRow(ctx, s4.body, { label: 'משך כניסה', prop: 'textAnim.inDuration', min: 0.05, max: 3, step: 0.05, unit: 'ש׳', decimals: 2, kf: false, defaultD: 0.4 });
    numRow(ctx, s4.body, { label: 'משך יציאה', prop: 'textAnim.outDuration', min: 0.05, max: 3, step: 0.05, unit: 'ש׳', decimals: 2, kf: false, defaultD: 0.3 });
    switchRow(ctx, s4.body, 'לפי מילה', 'textAnim.perWord', 'אנימציה לפי מילה', 'אנימציה לכל הטקסט');
  }

  if (!ctx.multi) buildTransitionSection(ctx, body);
}
function nameOf(list, id) { return list.find((x) => x.id === id)?.name || (id === 'none' ? 'ללא' : id); }

function nextClip(p, c) {
  if (!c) return null;
  const mm = M.modelModule;
  if (mm.nextClipOnTrack) { try { return mm.nextClipOnTrack(p, c); } catch { /* fallthrough */ } }
  const end = M.clipEnd(c); const fr = 1 / (p.settings?.fps || 30);
  return Object.values(p.clips || {}).filter((x) => x.trackId === c.trackId && x.id !== c.id && Math.abs(x.start - end) <= fr + 1e-6).sort((a, b) => a.start - b.start)[0] || null;
}

function buildTransitionSection(ctx, body) {
  const c = ctx.primary; const p = state.project;
  const s = C.section('מעבר לקליפ הבא', { icon: 'transition', key: 'anim.transition' });
  body.appendChild(s.el);
  const nx = nextClip(p, c);
  if (!nx) { s.body.appendChild(h('div.note', 'אין קליפ צמוד אחרי הקליפ הזה באותה רצועה. הצמידו קליפ כדי להוסיף מעבר.')); return; }
  s.body.appendChild(h('div.note', `אל: ${clipName(nx)}`));
  const list = I.catalog.transitions;
  if (!list.length) { emptyCat(s.body, 'הקטלוג לא נטען — אין מעברים זמינים'); return; }
  const groups = [...groupBy(list, 'category', 'כללי')].map(([g, items]) => ({ group: g, options: items.map((t) => ({ value: t.id, label: t.name || t.id })) }));
  const sel = C.selectField({
    options: [{ value: 'none', label: 'ללא מעבר' }, ...groups],
    onChange: (v) => {
      if (v === 'none') commit([{ op: 'removeTransition', id: c.id }], 'הסרת מעבר');
      else { const def = list.find((t) => t.id === v); commit([{ op: 'setTransition', id: c.id, transition: v, duration: ctx.primary.transitionOut?.duration && ctx.primary.transitionOut.id !== 'none' ? ctx.primary.transitionOut.duration : (def?.defaultDuration || 0.5) }], `מעבר: ${def?.name || v}`); }
    },
  });
  s.body.appendChild(C.row('מעבר', sel.el).el);
  ctx.reg(() => sel.set(ctx.primary.transitionOut?.id || 'none'));
  const cur = c.transitionOut;
  if (cur && cur.id && cur.id !== 'none') {
    numRow(ctx, s.body, {
      label: 'משך', prop: 'transitionOut.duration', min: 0.1, max: 3, step: 0.05, unit: 'ש׳', decimals: 2, kf: false,
      ops: (clips, v) => clips.map((cl) => ({ op: 'setTransition', id: cl.id, transition: cl.transitionOut?.id || cur.id, duration: v, params: cl.transitionOut?.params || {} })),
      get: (cl) => cl.transitionOut?.duration ?? 0.5,
    });
    const def = list.find((t) => t.id === cur.id);
    for (const prm of def?.params || []) paramControl(ctx, s.body, prm,
      () => ctx.primary.transitionOut?.params?.[prm.key] ?? prm.default,
      (v) => [{ op: 'setTransition', id: c.id, transition: cur.id, duration: ctx.primary.transitionOut?.duration, params: { ...(ctx.primary.transitionOut?.params || {}), [prm.key]: v } }],
      `פרמטר מעבר: ${prm.name || prm.key}`);
    s.body.appendChild(h('div.btn-row', h('button.btn.btn-sm', { type: 'button', on: { click: () => commit([{ op: 'removeTransition', id: c.id }], 'הסרת מעבר') } }, 'הסרת המעבר')));
  }
}

/** control for a catalog param def {key,name,type:number|color|select,min,max,default,options} */
function paramControl(ctx, parent, prm, read, opsFor, summary, kfProp = null, group = null) {
  const type = prm.type || 'number';
  if (type === 'color') {
    const cf = C.colorField({ value: read() || '#ffffff', onInput: (v) => preview(opsFor(v)), onChange: (v) => commit(opsFor(v), summary) });
    parent.appendChild(C.row(prm.name || prm.key, cf.el).el);
    ctx.reg(() => cf.set(read()));
  } else if (type === 'select') {
    const opts = (prm.options || []).map((o) => (typeof o === 'object' ? { value: o.value ?? o.id, label: o.label ?? o.name ?? o.value } : { value: o, label: String(o) }));
    const sel = C.selectField({ options: opts, onChange: (v) => { const raw = opts.find((o) => String(o.value) === String(v)); commit(opsFor(raw ? raw.value : v), summary); } });
    parent.appendChild(C.row(prm.name || prm.key, sel.el).el);
    ctx.reg(() => sel.set(read()));
  } else if (type === 'bool' || type === 'boolean') {
    const sw = C.switchField({ value: !!read(), onChange: (v) => commit(opsFor(v), summary) });
    parent.appendChild(C.row(prm.name || prm.key, h('span.grow'), sw.el).el);
    ctx.reg(() => sw.set(!!read()));
  } else {
    const min = Number.isFinite(prm.min) ? prm.min : 0; const max = Number.isFinite(prm.max) ? prm.max : Math.max(1, (prm.default || 1) * 2);
    const step = prm.step || ((max - min) <= 2 ? 0.01 : (max - min) <= 20 ? 0.1 : 1);
    numRow(ctx, parent, {
      label: prm.name || prm.key, prop: kfProp || `__param.${prm.key}`, min, max, step, decimals: step < 0.1 ? 2 : step < 1 ? 1 : 0,
      kf: !!kfProp, get: kfProp ? undefined : () => { const v = read(); return Number.isFinite(v) ? v : (prm.default ?? min); },
      ops: kfProp ? undefined : (clips, v) => opsFor(v), defaultD: prm.default,
      def: prm.default, summary, group,
    });
  }
}

// ---------------------------------------------------------------- tab: color & filter
function buildColorFx(ctx, body) {
  const cat = I.catalog;
  const s0 = C.section('פילטר', { icon: 'filter', key: 'color.filter' });
  body.appendChild(s0.el);
  if (cat.filters.length) {
    const items = [{ id: 'none', name: 'ללא', icon: 'close' }, ...cat.filters.filter((f) => f.id !== 'none').map((f) => ({ id: f.id, name: f.name || f.id, swatch: filterSwatch(f) }))];
    const g = C.chipGrid(items, { value: ctx.primary.filter?.id || 'none', onPick: (id) => commit(setOps(ctx.clips, { 'filter.id': id }), `פילטר: ${nameOf(items, id)}`) });
    s0.body.appendChild(g.el);
    ctx.reg(() => g.set(ctx.primary.filter?.id || 'none'));
  } else emptyCat(s0.body, 'אין פילטרים בקטלוג');
  if ((ctx.primary.filter?.id || 'none') !== 'none') numRow(ctx, s0.body, { label: 'עוצמה', prop: 'filter.amount', min: 0, max: 100, step: 1, ...pct, kf: false, defaultD: 100 });

  const s1 = C.section('התאמות', {
    icon: 'adjust', key: 'color.adjust',
    actions: [iconBtn('reset', 'איפוס כל התאמות הצבע', () => {
      const ops = [];
      for (const c of ctx.clips) {
        const set = {};
        for (const [k] of COLOR_KEYS) { set[`color.${k}`] = 0; if (hasKf(c, `color.${k}`)) ops.push({ op: 'clearKeyframes', id: c.id, prop: `color.${k}` }); }
        ops.push({ op: 'updateClip', id: c.id, set });
      }
      commit(ops, 'איפוס התאמות צבע');
    }, { cls: 'xs', size: 13 })],
  });
  body.appendChild(s1.el);
  const g = kfGroup(ctx, s1.actions);
  const colorRowFor = (parent, k, label, group) => {
    const zeroBased = ['vignette', 'sharpen', 'grain', 'fade'].includes(k);
    if (k === 'hue') numRow(ctx, parent, { label, prop: 'color.hue', min: -180, max: 180, step: 1, unit: '°', centered: true, defaultD: 0, def: 0, group });
    else numRow(ctx, parent, { label, prop: `color.${k}`, min: zeroBased ? 0 : -100, max: 100, step: 1, ...signedPct, centered: !zeroBased, defaultD: 0, def: 0, group });
  };
  const labelOf = Object.fromEntries(COLOR_KEYS);
  for (const k of COLOR_MAIN) colorRowFor(s1.body, k, labelOf[k], g);
  const rest = COLOR_KEYS.filter(([k]) => !COLOR_MAIN.includes(k));
  const used = ctx.clips.some((c) => rest.some(([k]) => (Number(c.color?.[k]) || 0) !== 0 || hasKf(c, `color.${k}`)));
  const mb = more(s1.body, 'color.adjust', { force: used });
  for (const [k, label] of rest) colorRowFor(mb, k, label, null);

  const media = ctx.clips.every((c) => c.type === 'video' || c.type === 'image');
  const adj = ctx.clips.every((c) => c.type === 'adjustment');
  buildAdvanced(ctx, body, { lut: true, chroma: media, mask: !adj, blend: !adj, crop: media });
}
function filterSwatch(f) {
  const c = f.color || {};
  const t = clamp(c.temperature || 0, -1, 1); const sat = clamp(1 + (c.saturation || 0), 0, 2); const br = clamp(1 + (c.brightness || 0) + (c.exposure || 0) * 0.6, 0.3, 1.8);
  const r = Math.round(clamp((120 + t * 70) * br, 0, 255)); const b = Math.round(clamp((140 - t * 70) * br, 0, 255)); const g = Math.round(clamp(118 * br, 0, 255));
  const gray = (r + g + b) / 3;
  const mix = (v) => Math.round(gray + (v - gray) * sat);
  return `linear-gradient(135deg, rgb(${mix(r)},${mix(g)},${mix(b)}), rgb(${mix(Math.round(r * 0.45))},${mix(Math.round(g * 0.5))},${mix(Math.round(b * 0.6))}))`;
}

// ---------------------------------------------------------------- tab: effects
function buildEffects(ctx, body) {
  const cat = I.catalog; const list = cat.effects;
  const add = C.section(ctx.primary.type === 'effect' ? 'אפקט על השכבות שמתחת' : 'הוספת אפקט', { icon: 'plus', key: 'fx.add' });
  body.appendChild(add.el);
  if (ctx.primary.type === 'effect') add.body.appendChild(h('div.note', 'קליפ אפקט חל על כל מה שמתחתיו בציר הזמן לאורך כל משכו.'));
  if (list.length) {
    const groups = [...groupBy(list, 'category', 'כללי')].map(([g, items]) => ({ group: g, options: items.map((e) => ({ value: e.id, label: e.name || e.id })) }));
    const sel = C.selectField({ options: groups, value: list[0].id });
    const btn = h('button.btn.btn-sm.btn-primary', { type: 'button', html: `${icon('plus', 14)}<span>הוספה</span>` });
    btn.addEventListener('click', () => {
      const id = sel.get(); const def = list.find((e) => e.id === id);
      const params = Object.fromEntries((def?.params || []).map((p) => [p.key, p.default]));
      commit(ctx.clips.map((c) => ({ op: 'addEffect', id: c.id, effect: id, params })), `הוספת אפקט: ${def?.name || id}`);
    });
    add.body.appendChild(h('div.add-fx', sel.el, btn));
  } else emptyCat(add.body, 'אין אפקטים בקטלוג');

  if (ctx.multi) { body.appendChild(h('div.insp-empty', 'עריכת אפקטים קיימים זמינה לקליף בודד. ההוספה חלה על כל הקליפים שנבחרו.')); return; }
  const c = ctx.primary;
  const effects = c.effects || [];
  const s = C.section(`אפקטים פעילים (${effects.length})`, { icon: 'effect', key: 'fx.list' });
  body.appendChild(s.el);
  if (!effects.length) { s.body.appendChild(h('div.note', 'אין אפקטים על הקליפ. בחרו אפקט מהרשימה או גררו אפקט מהספרייה אל הקליפ.')); return; }
  effects.forEach((fx, i) => {
    const def = list.find((e) => e.id === fx.id);
    const card = h('div.fx-card' + (fx.enabled === false ? '.off' : ''));
    const en = C.switchField({ value: fx.enabled !== false, title: 'הפעלה / כיבוי', onChange: (v) => commit([{ op: 'updateEffect', id: c.id, index: i, enabled: v }], v ? 'הפעלת אפקט' : 'כיבוי אפקט') });
    const up = iconBtn('arrowUp', 'העברה למעלה (מוקדם יותר בשרשרת)', () => moveEffect(c.id, i, -1), { cls: 'xs', size: 13 });
    const down = iconBtn('arrowDown', 'העברה למטה', () => moveEffect(c.id, i, 1), { cls: 'xs', size: 13 });
    up.disabled = i === 0; down.disabled = i === effects.length - 1;
    const del = iconBtn('trash', 'הסרת אפקט', () => commit([{ op: 'removeEffect', id: c.id, index: i }], `הסרת אפקט: ${def?.name || fx.id}`), { cls: 'xs', size: 13 });
    const head = h('div.fx-head', h('span.fx-idx', String(i + 1)), h('span.fx-name', def?.name || fx.id), h('span.fx-acts'), en.el, up, down, del);
    const fb = h('div.fx-body');
    card.append(head, fb);
    s.body.appendChild(card);
    const params = def?.params?.length ? def.params : Object.keys(fx.params || {}).map((k) => ({ key: k, name: k, type: typeof fx.params[k] === 'string' ? 'color' : 'number', default: fx.params[k] }));
    if (!params.length) fb.appendChild(h('div.note', 'לאפקט זה אין פרמטרים'));
    const kg = kfGroup(ctx, head.querySelector('.fx-acts'));
    for (const prm of params) {
      const isNum = (prm.type || 'number') === 'number';
      paramControl(ctx, fb, prm,
        () => ctx.primary.effects?.[i]?.params?.[prm.key] ?? prm.default,
        (v) => [{ op: 'updateEffect', id: c.id, index: i, params: { [prm.key]: v } }],
        `${def?.name || fx.id}: ${prm.name || prm.key}`,
        isNum ? `effects.${i}.${prm.key}` : null, isNum ? kg : null);
    }
    ctx.reg(() => { const f = ctx.primary.effects?.[i]; if (f) { en.set(f.enabled !== false); card.classList.toggle('off', f.enabled === false); } });
  });
}
function moveEffect(clipId, i, dir) {
  const c = state.project.clips[clipId]; if (!c) return;
  const j = i + dir;
  if (j < 0 || j >= (c.effects || []).length) return;
  // ops.moveEffect also remaps effect keyframes
  commit([{ op: 'moveEffect', id: clipId, from: i, to: j }], 'שינוי סדר אפקטים');
}

// ---------------------------------------------------------------- tab: speed
function buildSpeed(ctx, body) {
  const s = C.section('מהירות', { icon: 'speed', key: 'speed.main' });
  body.appendChild(s.el);
  speedControls(ctx, s.body, { compact: false });
}
/** speed chips (+ precise slider, reverse). compact: chips first, the rest under "עוד". */
function speedControls(ctx, parent, { compact = false } = {}) {
  // setSpeed changes the duration like CapCut (and scales keyframes / clamps to media length)
  const speedOps = (clips, v) => clips.map((c) => ({ op: 'setSpeed', id: c.id, speed: round(clamp(v, 0.05, 20), 4) }));
  const presets = compact ? [0.5, 1, 1.5, 2, 3] : SPEED_PRESETS;
  const chips = h('div.chip-row');
  for (const v of presets) {
    const b = h('button.chip', { type: 'button', dir: 'ltr', title: `מהירות ${v}×` }, `${v}×`);
    b.addEventListener('click', () => commit(speedOps(ctx.clips, v), `מהירות: ${v}×`));
    chips.appendChild(b);
    ctx.reg(() => b.classList.toggle('on', Math.abs((ctx.primary.speed || 1) - v) < 1e-3));
  }
  const odd = ctx.clips.some((c) => c.reverse || !presets.some((v) => Math.abs((c.speed || 1) - v) < 1e-3));
  const target = compact ? null : parent;
  if (compact) parent.appendChild(chips);
  const box = compact ? more(parent, 'edit.speed', { force: odd }) : target;
  numRow(ctx, box, { label: 'מהירות', prop: 'speed', min: 0.1, max: 10, curve: 'log', step: 0.01, unit: '×', decimals: 2, kf: false, get: (c) => c.speed || 1, ops: speedOps, summary: 'מהירות', hardMin: 0.05, hardMax: 20, defaultD: 1 });
  if (!compact) box.appendChild(chips);
  if (ctx.clips.every((c) => c.type === 'video' || c.type === 'audio')) switchRow(ctx, box, 'ניגון לאחור', 'reverse', 'ניגון לאחור', 'ניגון רגיל');
  const info = h('div.note');
  box.appendChild(info);
  ctx.reg(() => {
    const c = ctx.primary; const m = state.project.media?.[c.mediaId];
    info.textContent = `משך בציר: ${fmtSec(c.duration)}${m?.duration ? ` · מקור: ${fmtSec(m.duration)}` : ''} — שינוי מהירות מעדכן את משך הקליפ.`;
  });
}

// ---------------------------------------------------------------- tab: audio
const toDb = (v) => (v <= 0.001 ? -60 : clamp(20 * Math.log10(v), -60, 12));
const fromDb = (d) => (d <= -59.9 ? 0 : Math.pow(10, d / 20));
/** volume (keyframable, diamond in the section header) + fades */
function volumeRows(ctx, parent, actionsHost) {
  const g = kfGroup(ctx, actionsHost);
  numRow(ctx, parent, { label: 'עוצמה', prop: 'volume', min: -60, max: 12, step: 0.1, unit: 'dB', decimals: 1, toD: toDb, fromD: fromDb, def: 1, defaultD: 0, hardMin: -60, hardMax: 12, group: g });
  const maxFade = () => Math.min(10, Math.max(0.1, ctx.primary.duration / 2));
  numRow(ctx, parent, { label: 'כניסה רכה', prop: 'fadeIn', min: 0, max: maxFade(), step: 0.05, unit: 'ש׳', decimals: 2, kf: false, hardMin: 0, defaultD: 0 });
  numRow(ctx, parent, { label: 'יציאה רכה', prop: 'fadeOut', min: 0, max: maxFade(), step: 0.05, unit: 'ש׳', decimals: 2, kf: false, hardMin: 0, defaultD: 0 });
}
/** voice enhance, denoise, EQ, pan, ducking under the voice-over */
function audioFxRows(ctx, parent) {
  switchRow(ctx, parent, 'שיפור קול', 'audioFx.voiceEnhance', 'שיפור קול פעיל', 'שיפור קול כבוי');
  switchRow(ctx, parent, 'הפחתת רעש', 'audioFx.denoise', 'הפחתת רעש פעילה', 'הפחתת רעש כבויה');
  selectRow(ctx, parent, 'אקולייזר', 'audioFx.eqPreset', EQ_PRESETS, 'אקולייזר');
  numRow(ctx, parent, { label: 'איזון (Pan)', prop: 'pan', min: -100, max: 100, step: 1, ...signedPct, centered: true, kf: false, defaultD: 0, hardMin: -100, hardMax: 100 });
  subTitle(parent, 'הנמכה מתחת לקריינות');
  switchRow(ctx, parent, 'הנמכה אוטומטית', 'audioFx.duckUnderVoice', 'הנמכה מתחת לקריינות', 'ביטול הנמכה');
  numRow(ctx, parent, { label: 'עומק הנמכה', prop: 'audioFx.duckDb', min: -30, max: 0, step: 0.5, unit: 'dB', decimals: 1, kf: false, defaultD: -10 });
  parent.appendChild(h('div.note', 'מוזיקה ואפקטים יונמכו אוטומטית בכל פעם שהקריינות מדברת — כדי שהדיבור תמיד יישמע.'));
}
function buildAudio(ctx, body) {
  const s = C.section('עוצמה', { icon: 'volume', key: 'audio.vol' });
  body.appendChild(s.el);
  volumeRows(ctx, s.body, s.actions);
  if (ctx.clips.some((c) => c.type === 'video')) switchRow(ctx, s.body, 'השתקת קול הווידאו', 'muteAudio', 'השתקת קול הווידאו', 'הפעלת קול הווידאו');

  const s2 = C.section('שיפור קול', { icon: 'mic', key: 'audio.fx', open: false });
  body.appendChild(s2.el);
  audioFxRows(ctx, s2.body);

  if (!ctx.multi) {
    const tr = M.trackOf(state.project, ctx.primary);
    if (tr && tr.kind === 'audio') {
      const s4 = C.section(`רצועה: ${tr.name || M.ROLE_LABELS[tr.role] || ''}`, { icon: 'track', key: 'audio.track', open: false });
      body.appendChild(s4.el);
      numRow(ctx, s4.body, {
        label: 'עוצמת רצועה', prop: '__trackvol', min: -60, max: 12, step: 0.1, unit: 'dB', decimals: 1, kf: false, defaultD: 0,
        get: () => { const t2 = M.trackOf(state.project, ctx.primary); const v = t2?.volume ?? 1; return v <= 0.001 ? -60 : 20 * Math.log10(v); },
        ops: (clips, d) => [{ op: 'updateTrack', id: tr.id, set: { volume: d <= -59.9 ? 0 : round(Math.pow(10, d / 20), 4) } }],
      });
    }
  }
}

// ---------------------------------------------------------------- tab: text
function buildText(ctx, body) {
  const cat = I.catalog; const c0 = ctx.primary;
  const isCaption = ctx.clips.every((c) => c.type === 'caption');
  if (!isCaption) {
    const s0 = C.section('תוכן', { icon: 'text', key: 'text.content' });
    body.appendChild(s0.el);
    const ta = h('textarea.textarea', { rows: 3, dir: 'auto', spellcheck: false, placeholder: 'הקלידו טקסט…' });
    ta.value = c0.text?.content || '';
    let timer = null;
    ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ta.blur(); } });
    ta.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => preview(setOps(ctx.clips, { 'text.content': ta.value })), 60); });
    ta.addEventListener('change', () => { clearTimeout(timer); commit(setOps(ctx.clips, { 'text.content': ta.value }), 'עריכת טקסט'); });
    s0.body.appendChild(ta);
    ctx.reg(() => { if (document.activeElement !== ta) ta.value = ctx.primary.text?.content || ''; });
  }

  // presets (captions get their look from the caption styles instead)
  const sp = C.section('סגנונות מוכנים', { icon: 'sparkle', key: 'text.presets' });
  if (!isCaption) body.appendChild(sp.el);
  if (isCaption) { /* no presets for captions */ } else if (cat.textPresets.length) {
    const grid = h('div.presets');
    for (const pr of cat.textPresets) {
      const b = h('button.preset', { type: 'button', title: pr.name || pr.id });
      const tx = pr.text || {};
      const span = h('span', pr.name || 'טקסט');
      Object.assign(span.style, {
        fontFamily: `"${tx.font || 'Heebo'}", Heebo, sans-serif`, fontWeight: String(tx.weight || 800), color: tx.color || '#fff',
        fontStyle: tx.italic ? 'italic' : 'normal', WebkitTextStroke: tx.stroke?.width ? `${Math.min(2, tx.stroke.width / 6)}px ${tx.stroke.color}` : '',
        textShadow: tx.glow?.blur ? `0 0 8px ${tx.glow.color}` : (tx.shadow?.blur ? `0 2px 6px ${tx.shadow.color}` : ''),
        background: tx.background?.opacity ? colorWithOpacity(tx.background.color, tx.background.opacity) : 'transparent',
        padding: tx.background?.opacity ? '2px 6px' : '0', borderRadius: tx.background?.opacity ? '5px' : '0',
      });
      if (tx.gradient?.from) Object.assign(span.style, { background: `linear-gradient(${tx.gradient.angle ?? 90}deg, ${tx.gradient.from}, ${tx.gradient.to})`, WebkitBackgroundClip: 'text', color: 'transparent' });
      b.appendChild(span);
      b.addEventListener('click', () => {
        const merge = {}; if (pr.text) merge.text = { ...pr.text }; if (pr.textAnim) merge.textAnim = pr.textAnim;
        if (merge.text) delete merge.text.content;
        commit(ctx.clips.map((c) => ({ op: 'updateClip', id: c.id, merge })), `סגנון טקסט: ${pr.name || pr.id}`);
      });
      grid.appendChild(b);
    }
    sp.body.appendChild(grid);
  } else emptyCat(sp.body, 'אין סגנונות טקסט בקטלוג');

  // font / size / colour; weight, spacing, direction… under "עוד"
  const s1 = C.section('גופן', { icon: 'text', key: 'text.font' });
  body.appendChild(s1.el);
  const fonts = cat.fonts.length ? cat.fonts : [{ family: 'Heebo', weights: [400, 700, 800, 900] }];
  const fontSel = C.selectField({ options: fonts.map((f) => ({ value: f.family, label: f.family })), onChange: (v) => commit(setOps(ctx.clips, { 'text.font': v }), `גופן: ${v}`) });
  s1.body.appendChild(C.row('גופן', fontSel.el).el);
  ctx.reg(() => fontSel.set(ctx.primary.text?.font || 'Heebo'));
  const fam = fonts.find((f) => f.family === (c0.text?.font || 'Heebo'));
  const weights = (fam?.weights?.length ? fam.weights : [300, 400, 500, 600, 700, 800, 900]);
  const WN = { 100: 'דק מאוד', 200: 'דק', 300: 'קל', 400: 'רגיל', 500: 'בינוני', 600: 'חצי מודגש', 700: 'מודגש', 800: 'מודגש מאוד', 900: 'שחור' };
  const wSel = C.selectField({ options: weights.map((w) => ({ value: w, label: `${w} · ${WN[w] || ''}` })), numeric: true, onChange: (v) => commit(setOps(ctx.clips, { 'text.weight': Number(v) }), `משקל גופן: ${v}`) });
  numRow(ctx, s1.body, { label: 'גודל', prop: 'text.size', min: 8, max: 400, step: 1, unit: 'px', kf: false, hardMin: 4, defaultD: 96 });
  if (!isCaption) {
    colorRow(ctx, s1.body, 'צבע', 'text.color', { swatchList: TEXT_SWATCHES, summary: 'צבע טקסט' });
    const align = C.segField([{ value: 'right', icon: 'alignRight', title: 'יישור לימין' }, { value: 'center', icon: 'alignCenter', title: 'יישור למרכז' }, { value: 'left', icon: 'alignLeft', title: 'יישור לשמאל' }], { icons: true, value: c0.text?.align || 'center', onChange: (v) => commit(setOps(ctx.clips, { 'text.align': v }), 'יישור טקסט') });
    s1.body.appendChild(h('div.row', h('span.lbl', 'יישור'), align.el));
    ctx.reg(() => align.set(ctx.primary.text?.align || 'center'));
  }
  const mb = more(s1.body, 'text.font');
  mb.appendChild(C.row('משקל', wSel.el).el);
  ctx.reg(() => wSel.set(ctx.primary.text?.weight ?? 800));
  const styleSeg = h('div.seg.icons');
  const itBtn = mkSegBtn('italic', 'נטוי', () => commit(setOps(ctx.clips, { 'text.italic': !ctx.primary.text?.italic }), 'נטוי'));
  const unBtn = mkSegBtn('underline', 'קו תחתון', () => commit(setOps(ctx.clips, { 'text.underline': !ctx.primary.text?.underline }), 'קו תחתון'));
  styleSeg.append(itBtn, unBtn);
  const dirSel = C.selectField({ options: [{ value: 'auto', label: 'כיוון אוטומטי' }, { value: 'rtl', label: 'ימין לשמאל' }, { value: 'ltr', label: 'שמאל לימין' }], onChange: (v) => commit(setOps(ctx.clips, { 'text.dir': v }), 'כיוון טקסט') });
  mb.appendChild(h('div.row', h('span.lbl', 'סגנון'), styleSeg, dirSel.el));
  ctx.reg(() => { itBtn.classList.toggle('on', !!ctx.primary.text?.italic); unBtn.classList.toggle('on', !!ctx.primary.text?.underline); dirSel.set(ctx.primary.text?.dir || 'auto'); });
  numRow(ctx, mb, { label: 'גובה שורה', prop: 'text.lineHeight', min: 0.6, max: 3, step: 0.01, decimals: 2, kf: false, defaultD: 1.15 });
  numRow(ctx, mb, { label: 'ריווח אותיות', prop: 'text.letterSpacing', min: -20, max: 60, step: 0.5, unit: 'px', decimals: 1, kf: false, centered: true, defaultD: 0 });
  numRow(ctx, mb, { label: 'רוחב מרבי', prop: 'text.maxWidth', min: 100, max: Math.max(2000, (state.project.settings?.width || 1080) * 1.5), step: 10, unit: 'px', kf: false, defaultD: 900 });

  // decorations: collapsed
  const s2 = C.section('קו מתאר', { icon: 'shape', key: 'text.stroke', open: false });
  body.appendChild(s2.el);
  colorRow(ctx, s2.body, 'צבע', 'text.stroke.color', { summary: 'צבע קו מתאר', def: '#000000', swatchList: ['#000000', '#ffffff', '#071822', '#13b6e4', '#ff8a66'] });
  numRow(ctx, s2.body, { label: 'עובי', prop: 'text.stroke.width', min: 0, max: 40, step: 0.5, unit: 'px', decimals: 1, kf: false, hardMin: 0, defaultD: 0 });

  const s3 = C.section('צל', { icon: 'layers', key: 'text.shadow', open: false });
  body.appendChild(s3.el);
  colorRow(ctx, s3.body, 'צבע', 'text.shadow.color', { alpha: true, summary: 'צבע צל', def: 'rgba(0,0,0,0.6)' });
  numRow(ctx, s3.body, { label: 'טשטוש', prop: 'text.shadow.blur', min: 0, max: 80, step: 1, unit: 'px', kf: false, hardMin: 0, defaultD: 12 });
  numRow(ctx, s3.body, { label: 'היסט X', prop: 'text.shadow.x', min: -60, max: 60, step: 1, unit: 'px', kf: false, centered: true, defaultD: 0 });
  numRow(ctx, s3.body, { label: 'היסט Y', prop: 'text.shadow.y', min: -60, max: 60, step: 1, unit: 'px', kf: false, centered: true, defaultD: 4 });

  const s4 = C.section('רקע', { icon: 'rect', key: 'text.bg', open: false });
  body.appendChild(s4.el);
  colorRow(ctx, s4.body, 'צבע', 'text.background.color', { summary: 'צבע רקע טקסט', def: '#000000', swatchList: ['#000000', '#ffffff', '#13b6e4', '#f5c518', '#ff3b5c', '#071822'] });
  numRow(ctx, s4.body, { label: 'אטימות', prop: 'text.background.opacity', min: 0, max: 100, step: 1, ...pct, kf: false, hardMin: 0, hardMax: 100, defaultD: 0 });
  numRow(ctx, s4.body, { label: 'ריפוד', prop: 'text.background.padding', min: 0, max: 120, step: 1, unit: 'px', kf: false, hardMin: 0, defaultD: 24 });
  numRow(ctx, s4.body, { label: 'עיגול פינות', prop: 'text.background.radius', min: 0, max: 120, step: 1, unit: 'px', kf: false, hardMin: 0, defaultD: 24 });

  const s5 = C.section('זוהר', { icon: 'sparkle', key: 'text.glow', open: false });
  body.appendChild(s5.el);
  colorRow(ctx, s5.body, 'צבע', 'text.glow.color', { summary: 'צבע זוהר', def: '#3fe0f5', swatchList: ['#3fe0f5', '#13b6e4', '#ff3df5', '#f5c518', '#ffffff'] });
  numRow(ctx, s5.body, { label: 'עוצמה', prop: 'text.glow.blur', min: 0, max: 100, step: 1, unit: 'px', kf: false, hardMin: 0, defaultD: 0 });

  const hasGrad = !!c0.text?.gradient;
  const gradSw = C.switchField({ value: hasGrad, onChange: (v) => commit(setOps(ctx.clips, { 'text.gradient': v ? { from: '#3fe0f5', to: '#ff8a66', angle: 90 } : null }), v ? 'מעבר צבע לטקסט' : 'ביטול מעבר צבע') });
  const s6 = C.section('מעבר צבע', { icon: 'color', key: 'text.grad', open: false, toggle: gradSw.el });
  body.appendChild(s6.el);
  if (hasGrad) {
    colorRow(ctx, s6.body, 'מ־', 'text.gradient.from', { summary: 'צבע התחלה', def: '#3fe0f5' });
    colorRow(ctx, s6.body, 'אל', 'text.gradient.to', { summary: 'צבע סיום', def: '#ff8a66' });
    numRow(ctx, s6.body, { label: 'זווית', prop: 'text.gradient.angle', min: 0, max: 360, step: 1, unit: '°', kf: false, defaultD: 90 });
  } else s6.body.appendChild(h('div.note', 'הפעילו כדי לצבוע את הטקסט במעבר בין שני צבעים.'));

  // text clips have no "עריכה" tab: position / size and the advanced bits sit here, collapsed
  if (!isCaption) {
    buildTransformSection(ctx, body, { open: false, key: 'text.transform' });
    buildAdvanced(ctx, body, { mask: true, blend: true });
  }
}
function colorWithOpacity(hex, op) { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return hex; const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${op})`; }

// ---------------------------------------------------------------- tab: captions
function buildCaption(ctx, body) {
  const cat = I.catalog; const c0 = ctx.primary;
  const s1 = C.section('סגנון כתוביות', { icon: 'caption', key: 'cap.style' });
  body.appendChild(s1.el);
  // styleCaptions applies the style defaults (text, colors, textAnim) keeping each clip's words
  const applyStyleOps = (clips, st) => (clips.length ? [{ op: 'styleCaptions', ids: clips.map((c) => c.id), style: st.id }] : []);
  if (cat.captionStyles.length) {
    const g = C.chipGrid(cat.captionStyles.map((s) => ({ id: s.id, name: s.name || s.id })), {
      value: c0.caption?.style, wide: true,
      onPick: (id) => { const st = cat.captionStyles.find((s) => s.id === id); commit(applyStyleOps(ctx.clips, st), `סגנון כתוביות: ${st.name || id}`); },
    });
    s1.body.appendChild(g.el);
    ctx.reg(() => g.set(ctx.primary.caption?.style));
    const allBtn = h('button.btn.btn-sm', { type: 'button', html: `${icon('layers', 14)}<span>החלה על כל הכתוביות בפרויקט</span>` });
    allBtn.addEventListener('click', () => {
      const st = cat.captionStyles.find((s) => s.id === ctx.primary.caption?.style);
      if (!st) { toast('בחרו סגנון קודם', { type: 'warn' }); return; }
      const all = Object.values(state.project.clips).filter((c) => c.type === 'caption');
      const yv = ctx.primary.transform?.y ?? 0;
      commit([{ op: 'styleCaptions', ids: all.map((c) => c.id), style: st.id, y: yv }], `סגנון "${st.name || st.id}" לכל הכתוביות`);
    });
    s1.body.appendChild(h('div.btn-row', allBtn));
  } else emptyCat(s1.body, 'אין סגנונות כתוביות בקטלוג');
  const sc = C.section('צבעים ומיקום', { icon: 'color', key: 'cap.colors' });
  body.appendChild(sc.el);
  colorRow(ctx, sc.body, 'טקסט', 'text.color', { summary: 'צבע טקסט הכתוביות', def: '#ffffff', swatchList: ['#ffffff', '#f2ede4', '#f5c518', '#000000'] });
  colorRow(ctx, sc.body, 'מילה פעילה', 'caption.activeColor', { summary: 'צבע מילה פעילה', def: '#3fe0f5', swatchList: ['#3fe0f5', '#13b6e4', '#f5c518', '#2fd27a', '#ffffff'] });
  colorRow(ctx, sc.body, 'מילה חמה', 'caption.hotColor', { summary: 'צבע מילה חמה', def: '#ff8a66', swatchList: ['#ff8a66', '#ff3b5c', '#f5c518', '#9b6bff'] });
  const H = state.project.settings?.height || 1920;
  numRow(ctx, sc.body, { label: 'מיקום אנכי', prop: 'transform.y', min: -H / 2, max: H / 2, step: 1, unit: 'px', centered: true, kf: false, defaultD: 0 });

  if (ctx.multi) return;
  const s2 = C.section(`עריכת זמני מילים (${(c0.caption?.words || []).length})`, { icon: 'clock', key: 'cap.words', open: false });
  body.appendChild(s2.el);
  const words = c0.caption?.words || [];
  if (!words.length) { s2.body.appendChild(h('div.note', 'אין מילים בכתובית הזו.')); return; }
  const table = h('div.words');
  table.appendChild(h('div.words-head', h('span', 'מילה'), h('span', 'התחלה'), h('span', 'סוף'), h('span', 'חמה'), h('span', '')));
  const rows = [];
  const setWord = (i, set, summary) => commit([{ op: 'setCaptionWord', id: c0.id, index: i, set }], summary);
  words.forEach((w, i) => {
    const inp = h('input.input', { type: 'text', dir: 'auto', spellcheck: false });
    inp.value = w.w;
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') inp.blur(); });
    inp.addEventListener('change', () => { const v = inp.value.trim(); if (v) setWord(i, { w: v }, 'עריכת מילה בכתובית'); else inp.value = state.project.clips[c0.id]?.caption?.words?.[i]?.w || ''; });
    const sF = C.numField({ value: w.s, decimals: 2, step: 0.01, hardMin: 0, onChange: (v) => setWord(i, { s: round(v, 3) }, 'תזמון מילה') });
    const eF = C.numField({ value: w.e, decimals: 2, step: 0.01, hardMin: 0, onChange: (v) => setWord(i, { e: round(v, 3) }, 'תזמון מילה') });
    const hot = h('button.hot-btn' + (w.hot ? '.on' : ''), { type: 'button', title: 'מילה חמה (מודגשת בצבע)', html: icon('sparkle', 12) });
    hot.addEventListener('click', () => { const cur = !!state.project.clips[c0.id]?.caption?.words?.[i]?.hot; setWord(i, { hot: !cur }, cur ? 'ביטול מילה חמה' : 'סימון מילה חמה'); });
    const go = iconBtn('play', 'מעבר לזמן המילה', () => state.set({ playhead: (state.project.clips[c0.id]?.caption?.words?.[i]?.s ?? w.s) + 0.001 }), { cls: 'xs', size: 11 });
    const r = h('div.word-row', inp, sF.el, eF.el, hot, go);
    table.appendChild(r);
    rows.push({ r, inp, sF, eF, hot });
  });
  s2.body.appendChild(table);
  s2.body.appendChild(h('div.note', 'הזמנים מוחלטים בציר הזמן (שניות). מילה פעילה מודגשת בזמן הניגון.'));
  ctx.reg(() => {
    const ws = state.project.clips[c0.id]?.caption?.words || [];
    const t = state.playhead;
    rows.forEach((row, i) => {
      const w = ws[i]; if (!w) return;
      if (document.activeElement !== row.inp) row.inp.value = w.w;
      row.sF.set(w.s); row.eF.set(w.e);
      row.hot.classList.toggle('on', !!w.hot);
      const nextS = ws[i + 1]?.s ?? (w.e + 0.15);
      row.r.classList.toggle('active', t >= w.s && t < nextS);
    });
  });
}

// ---------------------------------------------------------------- tab: shape
function buildShape(ctx, body) {
  const c0 = ctx.primary; const W = state.project.settings?.width || 1080;
  const s = C.section('צורה', { icon: 'shape', key: 'shape.main' });
  body.appendChild(s.el);
  const g = C.chipGrid(SHAPE_KINDS.map(([id, name]) => ({ id, name, icon: id === 'progress' ? 'progress' : id })), { value: c0.shape?.kind, onPick: (id) => commit(setOps(ctx.clips, { 'shape.kind': id }), `צורה: ${SHAPE_KINDS.find((k) => k[0] === id)?.[1]}`) });
  s.body.appendChild(g.el);
  ctx.reg(() => g.set(ctx.primary.shape?.kind));
  numRow(ctx, s.body, { label: 'רוחב', prop: 'shape.w', min: 2, max: W * 2, step: 1, unit: 'px', kf: false, hardMin: 1, defaultD: 400 });
  numRow(ctx, s.body, { label: 'גובה', prop: 'shape.h', min: 2, max: W * 2, step: 1, unit: 'px', kf: false, hardMin: 1, defaultD: 400 });
  colorRow(ctx, s.body, 'מילוי', 'shape.fill', { alpha: true, summary: 'צבע מילוי', def: '#13b6e4', swatchList: ['#13b6e4', '#ffffff', '#000000', '#ff8a66', '#f5c518', '#ff3b5c', '#2fd27a', '#071822'] });
  colorRow(ctx, s.body, 'קו', 'shape.stroke', { alpha: true, summary: 'צבע קו', def: '#ffffff' });
  numRow(ctx, s.body, { label: 'עובי קו', prop: 'shape.strokeWidth', min: 0, max: 60, step: 0.5, unit: 'px', decimals: 1, kf: false, hardMin: 0, defaultD: 0 });
  if (['roundrect', 'rect', 'progress'].includes(c0.shape?.kind)) numRow(ctx, s.body, { label: 'עיגול פינות', prop: 'shape.radius', min: 0, max: 400, step: 1, unit: 'px', kf: false, hardMin: 0, defaultD: 40 });
  if (c0.shape?.kind === 'progress') {
    numRow(ctx, s.body, { label: 'התקדמות מ־', prop: 'shape.progressFrom', min: 0, max: 100, step: 0.5, ...pct, decimals: 1, kf: false, defaultD: 0 });
    numRow(ctx, s.body, { label: 'התקדמות עד', prop: 'shape.progressTo', min: 0, max: 100, step: 0.5, ...pct, decimals: 1, kf: false, defaultD: 100 });
    s.body.appendChild(h('div.note', 'הפס מתמלא מ־"התקדמות מ־" ועד "התקדמות עד" לאורך משך הקליפ.'));
  }
}

// ---------------------------------------------------------------- tab: sticker
function buildSticker(ctx, body) {
  const cat = I.catalog; const c0 = ctx.primary;
  const s = C.section('מדבקה', { icon: 'sticker', key: 'sticker.main' });
  body.appendChild(s.el);
  const emoji = h('input.input', { type: 'text', dir: 'ltr', style: 'width:70px;text-align:center;font-size:18px', maxlength: 8, title: 'אימוג׳י' });
  emoji.value = c0.sticker?.kind === 'emoji' ? (c0.sticker?.value || '') : '';
  emoji.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') emoji.blur(); });
  emoji.addEventListener('change', () => { if (emoji.value.trim()) commit(setOps(ctx.clips, { 'sticker.kind': 'emoji', 'sticker.value': emoji.value.trim() }), 'החלפת מדבקה'); });
  s.body.appendChild(C.row('אימוג׳י', emoji, h('span.note', 'הקלידו או בחרו מהרשת')).el);
  numRow(ctx, s.body, { label: 'גודל', prop: 'sticker.size', min: 20, max: 1200, step: 1, unit: 'px', kf: false, hardMin: 4, defaultD: 220 });
  const list = cat.stickers;
  if (list.length) {
    for (const [kind, title] of [['emoji', 'אימוג׳י'], ['builtin', 'מדבקות מובנות']]) {
      const items = list.filter((x) => (x.kind || 'emoji') === kind);
      if (!items.length) continue;
      s.body.appendChild(h('div.sub-title', title));
      const grid = h('div.chips', { style: 'grid-template-columns:repeat(auto-fill,minmax(40px,1fr))' });
      for (const st of items) {
        const b = h('button.chip', { type: 'button', title: st.name || st.id, style: 'min-height:40px;font-size:20px;padding:2px' });
        if (kind === 'emoji') b.textContent = st.value; else b.appendChild(stickerThumb(st));
        b.addEventListener('click', () => commit(setOps(ctx.clips, { 'sticker.kind': kind, 'sticker.value': st.value ?? st.id }), `מדבקה: ${st.name || st.value}`));
        grid.appendChild(b);
        ctx.reg(() => b.classList.toggle('on', ctx.primary.sticker?.kind === kind && String(ctx.primary.sticker?.value) === String(st.value ?? st.id)));
      }
      s.body.appendChild(grid);
    }
  } else emptyCat(s.body, 'אין מדבקות בקטלוג');
  ctx.reg(() => { if (document.activeElement !== emoji) emoji.value = ctx.primary.sticker?.kind === 'emoji' ? (ctx.primary.sticker?.value || '') : ''; });
}
let textModPromise = null;
function stickerThumb(st) {
  const cv = h('canvas', { width: 64, height: 64, style: 'width:28px;height:28px' });
  textModPromise = textModPromise || import('../render/text-render.js').catch(() => null);
  textModPromise.then((mod) => {
    if (mod?.drawThumbnail) { try { mod.drawThumbnail('sticker', st, cv); return; } catch { /* fallthrough */ } }
    const g = cv.getContext('2d'); g.fillStyle = '#13b6e4'; g.font = '700 20px Heebo'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText((st.name || st.id || '?').slice(0, 2), 32, 32);
  });
  return cv;
}

// ---------------------------------------------------------------- project settings (nothing selected)
function buildProjectPanel(p) {
  const body = I.bodyEl;
  const reg = (fn) => I.controls.push(fn);
  const s0 = C.section('פרויקט', { icon: 'film', key: 'proj.info' });
  body.appendChild(s0.el);
  const stats = h('div.stat-grid');
  const st = (label) => { const b = h('b'); stats.appendChild(h('div.stat', b, h('span', label))); return b; };
  const sDur = st('משך'); const sClips = st('קליפים'); const sMedia = st('קובצי מדיה');
  s0.body.appendChild(stats);
  reg(() => {
    const pp = state.project;
    sDur.textContent = M.formatTimecode(M.projectDuration(pp), pp.settings?.fps || 30);
    sClips.textContent = String(Object.keys(pp.clips || {}).length);
    sMedia.textContent = String(Object.keys(pp.media || {}).length);
  });

  const s1 = C.section('פורמט', { icon: 'phone', key: 'proj.format' });
  body.appendChild(s1.el);
  const curAspect = () => `${state.project.settings?.width}x${state.project.settings?.height}`;
  const aspect = C.segField(ASPECTS, { block: true, accent: true, value: curAspect(), onChange: (v) => { const [w, hh] = v.split('x').map(Number); commit([{ op: 'setSettings', set: { width: w, height: hh } }], `גודל פריים: ${w}×${hh}`); } });
  s1.body.appendChild(C.row('יחס', aspect.el).el);
  const wF = C.numField({ value: p.settings?.width, decimals: 0, step: 2, hardMin: 16, hardMax: 8192, onChange: (v) => commit([{ op: 'setSettings', set: { width: Math.round(v / 2) * 2 } }], 'רוחב פריים') });
  const hF = C.numField({ value: p.settings?.height, decimals: 0, step: 2, hardMin: 16, hardMax: 8192, onChange: (v) => commit([{ op: 'setSettings', set: { height: Math.round(v / 2) * 2 } }], 'גובה פריים') });
  wF.el.classList.add('wide'); hF.el.classList.add('wide');
  s1.body.appendChild(h('div.row', h('span.lbl', 'גודל'), h('div.pair', h('span.lbl', 'רוחב'), wF.el, h('span.lbl', 'גובה'), hF.el)));
  const fpsSel = C.selectField({ options: [24, 25, 30, 50, 60].map((v) => ({ value: v, label: `${v} פריימים לשנייה` })), numeric: true, onChange: (v) => commit([{ op: 'setSettings', set: { fps: Number(v) } }], `קצב פריימים: ${v}`) });
  s1.body.appendChild(C.row('קצב פריימים', fpsSel.el).el);
  const bg = C.colorField({ value: p.settings?.background || '#000000', onChange: (v) => commit([{ op: 'setSettings', set: { background: v } }], 'צבע רקע') });
  s1.body.appendChild(C.row('צבע רקע', bg.el).el);
  const safe = C.selectField({ options: [['none', 'ללא'], ['reels', 'ריילס (אינסטגרם)'], ['tiktok', 'טיקטוק'], ['youtube', 'יוטיוב / שורטס']].map(([value, label]) => ({ value, label })), onChange: (v) => commit([{ op: 'setSettings', set: { safeArea: v } }], 'אזור בטוח') });
  s1.body.appendChild(C.row('אזור בטוח', safe.el).el);
  reg(() => {
    const s = state.project.settings || {};
    aspect.set(curAspect()); wF.set(s.width); hF.set(s.height); fpsSel.set(s.fps || 30); bg.set(s.background || '#000000'); safe.set(s.safeArea || 'none');
  });

  const s2 = C.section('שמע ומאסטרינג', { icon: 'volume', key: 'proj.audio', open: false });
  body.appendChild(s2.el);
  const settingRow = (label, key, min, max, step, unit, def) => {
    const sl = C.slider({ min, max, step, value: p.settings?.[key] ?? def, defaultValue: def, onInput: (v) => { nf.set(v); previewOps([{ op: 'setSettings', set: { [key]: v } }]); }, onChange: (v) => commit([{ op: 'setSettings', set: { [key]: v } }], `${label}: ${v}${unit}`) });
    const nf = C.numField({ value: p.settings?.[key] ?? def, decimals: 1, step, hardMin: min, hardMax: max, onChange: (v) => { sl.set(v); commit([{ op: 'setSettings', set: { [key]: v } }], `${label}: ${v}${unit}`); } });
    s2.body.appendChild(C.row(label, sl.el, nf.el, h('span.unit', unit)).el);
    reg(() => { const v = state.project.settings?.[key] ?? def; if (!sl.el.matches(':active')) sl.set(v); nf.set(v); });
  };
  settingRow('יעד עוצמה', 'targetLufs', -24, -8, 0.5, 'LUFS', -14);
  settingRow('מאסטר', 'masterGainDb', -24, 12, 0.5, 'dB', 0);
  s2.body.appendChild(h('div.note', `-14 LUFS מומלץ לאינסטגרם, טיקטוק ויוטיוב · קצב דגימה ${p.settings?.sampleRate || 48000} Hz`));

  // tracks
  const s3 = C.section(`רצועות (${(p.tracks || []).length})`, { icon: 'track', key: 'proj.tracks', open: false, actions: [iconBtn('plus', 'הוספת רצועה', (e) => addTrackMenu(e.currentTarget), { cls: 'xs', size: 14 })] });
  body.appendChild(s3.el);
  const tracks = p.tracks || [];
  if (!tracks.length) s3.body.appendChild(h('div.note', 'אין רצועות. הוסיפו רצועה בכפתור +.'));
  tracks.forEach((tr, idx) => {
    const name = h('input.trk-name', { type: 'text', dir: 'auto', spellcheck: false });
    name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); });
    name.addEventListener('change', () => commit([{ op: 'updateTrack', id: tr.id, set: { name: name.value.trim() } }], 'שינוי שם רצועה'));
    const role = h('span.trk-role');
    const tgl = (key, icOn, icOff, title) => {
      const b = iconBtn(icOn, title, () => { const t2 = state.project.tracks.find((x) => x.id === tr.id); commit([{ op: 'updateTrack', id: tr.id, set: { [key]: !t2?.[key] } }], `${title}: ${t2?.[key] ? 'כבוי' : 'פעיל'}`); }, { cls: 'sm', size: 13 });
      return { b, upd: (t2) => { const v = !!t2[key]; b.innerHTML = icon(v ? icOff : icOn, 13); b.classList.toggle('on', v); } };
    };
    const hide = tr.kind === 'video' ? tgl('hidden', 'eye', 'eyeOff', 'הסתרה') : tgl('muted', 'volume', 'mute', 'השתקה');
    const lock = tgl('locked', 'unlock', 'lock', 'נעילה');
    const solo = tr.kind === 'audio' ? tgl('solo', 'solo', 'solo', 'סולו') : null;
    const up = iconBtn('arrowUp', 'הזזה למעלה', () => commit([{ op: 'moveTrack', id: tr.id, index: Math.max(0, idx - 1) }], 'סידור רצועות'), { cls: 'sm', size: 13 });
    const down = iconBtn('arrowDown', 'הזזה למטה', () => commit([{ op: 'moveTrack', id: tr.id, index: Math.min(tracks.length - 1, idx + 1) }], 'סידור רצועות'), { cls: 'sm', size: 13 });
    up.disabled = idx === 0; down.disabled = idx === tracks.length - 1;
    const del = iconBtn('trash', 'מחיקת רצועה', async () => {
      const n = Object.values(state.project.clips).filter((c) => c.trackId === tr.id).length;
      if (n && !(await confirmDialog(`למחוק את הרצועה "${tr.name || ''}" ואת ${n} הקליפים שבה?`, { title: 'מחיקת רצועה', okLabel: 'מחיקה', danger: true }))) return;
      commit([{ op: 'removeTrack', id: tr.id }], 'מחיקת רצועה');
    }, { cls: 'sm', size: 13 });
    const rowEl = h('div.trk', h('span.trk-ic', { html: icon(tr.kind === 'audio' ? (tr.role === 'voice' ? 'mic' : tr.role === 'music' ? 'music' : 'audio') : (tr.role === 'text' ? 'text' : tr.role === 'effects' ? 'effect' : 'video'), 14) }), name, role, hide.b, lock.b, solo?.b, up, down, del);
    s3.body.appendChild(rowEl);
    reg(() => {
      const t2 = state.project.tracks.find((x) => x.id === tr.id); if (!t2) return;
      if (document.activeElement !== name) name.value = t2.name || '';
      role.textContent = M.ROLE_LABELS[t2.role] || t2.role || '';
      hide.upd(t2); lock.upd(t2); solo?.upd(t2);
    });
  });

  // markers
  const s4 = C.section(`סמנים (${(p.markers || []).length})`, { icon: 'marker', key: 'proj.markers', open: false });
  body.appendChild(s4.el);
  const markers = [...(p.markers || [])].sort((a, b) => a.t - b.t);
  if (!markers.length) s4.body.appendChild(h('div.note', 'אין סמנים. לחצו M בזמן הניגון כדי להוסיף סמן בנקודה.'));
  for (const mk of markers) {
    const lab = h('input.input', { type: 'text', dir: 'auto', placeholder: 'תווית', spellcheck: false });
    lab.value = mk.label || '';
    lab.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') lab.blur(); });
    lab.addEventListener('change', () => commit([{ op: 'updateMarker', id: mk.id, set: { label: lab.value.trim() } }], 'שינוי תווית סמן'));
    const tEl = h('span.mk-t', M.formatTimecode(mk.t, p.settings?.fps || 30));
    tEl.addEventListener('click', () => state.set({ playhead: mk.t }));
    const del = iconBtn('trash', 'מחיקת סמן', () => commit([{ op: 'removeMarker', id: mk.id }], 'מחיקת סמן'), { cls: 'xs', size: 12 });
    s4.body.appendChild(h('div.marker-row', h('span.mk-dot', { style: { background: mk.color || '#f5c518' } }), tEl, lab, del));
  }
}

function addTrackMenu(anchor) {
  const add = (kind, role, name) => {
    // the timeline hides empty tracks — a track the user just added by hand stays visible
    const id = `t_${Math.random().toString(36).slice(2, 10)}`;
    window.dispatchEvent(new CustomEvent('fs:keep-track', { detail: { id } }));
    commit([{ op: 'addTrack', id, kind, role, name }], `הוספת רצועה: ${name}`);
  };
  menu(anchor, [
    { header: 'רצועת וידאו' },
    ...ROLE_OPTIONS.video.map(([role, name]) => ({ label: name, icon: role === 'text' ? 'text' : 'video', onClick: () => add('video', role, name) })),
    { sep: true },
    { header: 'רצועת אודיו' },
    ...ROLE_OPTIONS.audio.map(([role, name]) => ({ label: name, icon: role === 'voice' ? 'mic' : role === 'music' ? 'music' : 'audio', onClick: () => add('audio', role, name) })),
  ]);
}

// ---------------------------------------------------------------- builders map
const BUILDERS = {
  edit: buildEdit, anim: buildAnim, colorfx: buildColorFx, effects: buildEffects,
  speed: buildSpeed, audio: buildAudio, text: buildText, caption: buildCaption, shape: buildShape, sticker: buildSticker,
};

/** programmatic tab switch (e.g. main.js shortcuts); old ids (basic, color, mask, chroma) still work */
export function showTab(id) { id = TAB_ALIAS[id] || id; if (TABS[id]) { I.tab = id; I.structKey = ''; render(); } }
