// Frame Studio — app/ui-export.js (owner: U)
// Export dialog. By default only what a creator decides: resolution, quality, where the file goes, "ייצוא".
// Under "מתקדם": fps, loudness target (LUFS), range (all / I-O / custom), where to render, speech check, file name.
// Live progress with ETA; when done: a one-line summary ("הסרטון מוכן · 5 ש׳ · 2.1MB"), the real folder
// (מסמכים › Frame Studio › projects › <project id> › exports — the folders as they are on disk) with "פתיחת התיקייה", and the technical report folded under "פרטים".
// POST /api/projects/:id/export {from,to,fps,crf,preset,lufs,headless,check,out?, scale,width,height}
//   (scale/width/height are an extension of SPEC §8 — the render job carries `scale`).
import { api, state, onEvent } from './api.js';
import { h, clear, toast, modal, copyText, fmtEta, fmtBytes, round, store, clamp } from './ui-kit.js';
import { icon } from './ui-icons.js';
import * as M from './ui-model.js';

const QUALITY = [
  { id: 'max', label: 'מקסימלית', crf: 14, preset: 'slow' },
  { id: 'high', label: 'גבוהה', crf: 16, preset: 'medium' },
  { id: 'normal', label: 'רגילה', crf: 18, preset: 'medium' },
  { id: 'small', label: 'קובץ קטן', crf: 23, preset: 'fast' },
  { id: 'draft', label: 'טיוטה מהירה', crf: 28, preset: 'veryfast' },
];
const RES = [
  { id: '720', label: '720p', short: 720 },
  { id: '1080', label: '1080p', short: 1080 },
  { id: '2160', label: '4K (הגדלה)', short: 2160 },
];
const LUFS_PRESETS = [[-14, 'רשתות'], [-16, 'פודקאסט'], [-23, 'שידור']];

// ---------------------------------------------------------------- where the file goes, in words
const FOLDER_WORDS = { documents: 'מסמכים', 'מסמכים': 'מסמכים', desktop: 'שולחן העבודה', 'שולחן העבודה': 'שולחן העבודה', downloads: 'הורדות', 'הורדות': 'הורדות', videos: 'סרטונים', 'סרטונים': 'סרטונים' };
/**
 * "C:\Users\me\Documents\Frame Studio\projects\my-film\exports\x.mp4" →
 * ["מסמכים", "Frame Studio", "projects", "my-film", "exports"] — the real folder names as File Explorer shows them
 * (the user folder is skipped and Documents / Desktop / Downloads / Videos read the way Hebrew Windows names them).
 */
export function friendlyFolder(file) {
  const parts = String(file || '').replace(/\\/g, '/').split('/').filter(Boolean);
  parts.pop(); // the file name itself
  let i = 0;
  if (/^[a-z]:$/i.test(parts[0] || '')) i = 1;
  if (/^(users|home)$/i.test(parts[i] || '')) i += 2; // skip "Users/<name>"
  const out = [];
  for (let k = i; k < parts.length; k++) {
    const seg = parts[k];
    if (/^onedrive/i.test(seg)) continue; // "OneDrive/Documents" still reads as Documents
    out.push(FOLDER_WORDS[seg.toLowerCase()] || seg);
  }
  return out.length ? out : [String(file || '')];
}
/** a path node that never gets bidi-scrambled */
function pathEl(file, opts) {
  const crumbs = friendlyFolder(file, opts);
  const el = h('div.ex-folder', { title: file || '' });
  crumbs.forEach((c, i) => {
    if (i) el.appendChild(h('span.sep', '›'));
    el.appendChild(h('bdi', c));
  });
  return el;
}
const hasVoice = (p) => {
  const voiceTracks = new Set((p.tracks || []).filter((t) => t.role === 'voice').map((t) => t.id));
  return Object.values(p.clips || {}).some((c) => voiceTracks.has(c.trackId) && !c.disabled);
};
let dataDirCache = null;
async function exportsFolderOf(projectId) {
  if (!dataDirCache) { try { dataDirCache = (await api.get('/api/health'))?.dataDir || null; } catch { dataDirCache = null; } }
  return dataDirCache ? `${dataDirCache.replace(/[\\/]+$/, '')}/projects/${projectId}/exports/x.mp4` : null;
}

const ownJobs = new Set();
export const isOwnJob = (id) => ownJobs.has(id);

/** normalize a job object from the server */
export function jobInfo(job) {
  if (!job || typeof job !== 'object') return null;
  const id = job.id || job.jobId || job.job;
  const raw = String(job.status || job.state || '').toLowerCase();
  let status = 'running';
  if (['done', 'finished', 'complete', 'completed', 'success', 'ok'].includes(raw) || job.done === true) status = 'done';
  else if (['failed', 'fail', 'error', 'errored', 'cancelled', 'canceled', 'timeout'].includes(raw) || (job.error && raw !== 'running')) status = 'failed';
  else if (['queued', 'pending', 'waiting', 'created'].includes(raw)) status = 'queued';
  let progress = Number(job.progress);
  if (!Number.isFinite(progress)) progress = job.frames && job.totalFrames ? job.frames / job.totalFrames : 0;
  if (progress > 1.0001) progress /= 100;
  const outputs = job.outputs ?? job.output ?? job.out ?? job.file ?? job.path;
  let output = null;
  if (typeof outputs === 'string') output = outputs;
  else if (Array.isArray(outputs)) output = outputs.find((x) => typeof x === 'string') || outputs[0]?.path || null;
  else if (outputs && typeof outputs === 'object') output = outputs.video || outputs.mp4 || outputs.out || outputs.path || Object.values(outputs).find((x) => typeof x === 'string') || null;
  return {
    id, type: job.type || job.kind || 'export', status, progress: clamp(progress || 0, 0, 1),
    frames: job.frames ?? job.frame ?? null, totalFrames: job.totalFrames ?? job.total ?? job.frameCount ?? null,
    eta: Number.isFinite(Number(job.eta)) ? Number(job.eta) : null, stage: job.stage || job.phase || job.step || '',
    output, outputs, report: job.report || null, error: job.error || null, by: job.by || null, raw: job,
  };
}

const STAGES = { loading: 'טוען פרויקט ומדיה', waiting: 'ממתין לחלון העורך', finishing: 'מקודד ומאחד', snapshot: 'מצלם תמונות', running: 'מרנדר', queued: 'בתור', starting: 'מתחיל', launching: 'מפעיל דפדפן לרינדור', frames: 'מרנדר פריימים', render: 'מרנדר פריימים', video: 'מרנדר פריימים', audio: 'מעבד שמע', loudness: 'מנרמל עוצמה (LUFS)', mux: 'מאחד וידאו ושמע', check: 'בודק מרווח דיבור', done: 'הושלם', encoding: 'מקודד', stems: 'מרנדר ערוצי בדיקה' };

let open = null;
/** true while the export dialog is visible and still tracking this job */
export const dialogTracks = (id) => !!open && open.jobId === id && !open.finished;

export function openExportDialog(viewer) {
  if (open) return open;
  const p = state.project;
  if (!p) { toast('אין פרויקט פתוח', { type: 'warn' }); return null; }
  if (viewer?.isPlaying?.()) viewer.pause();
  const s = p.settings || {}; const W = s.width || 1080; const H = s.height || 1920;
  const dur = M.projectDuration(p); const pfps = s.fps || 30;
  const saved = store.get('fs.export', {}) || {};
  const opt = {
    res: saved.res || '1080', fps: saved.fps || pfps, quality: saved.quality || 'normal', lufs: s.targetLufs ?? -14,
    range: 'all', from: 0, to: dur, headless: saved.headless ?? true, check: saved.check ?? true, out: '',
  };
  const r = state.range;
  const hasIO = r && r.in != null && r.out != null && r.out > r.in;
  if (hasIO) { opt.from = r.in; opt.to = r.out; }

  // ---- form
  const resLabel = h('span.ex-res');
  const scaleFor = (id) => { const sh = RES.find((x) => x.id === id)?.short || 1080; return sh / Math.min(W, H); };
  const dims = (id) => { const k = scaleFor(id); return [Math.round((W * k) / 2) * 2, Math.round((H * k) / 2) * 2]; };
  const seg = (items, cur, onPick, cls = '') => {
    const el = h('div.seg' + cls);
    for (const it of items) {
      const b = h('button' + (String(it.id) === String(cur) ? '.on.accent' : ''), { type: 'button', disabled: !!it.disabled, title: it.title || '' }, it.label);
      b.addEventListener('click', () => { for (const x of el.children) x.classList.remove('on', 'accent'); b.classList.add('on', 'accent'); onPick(it.id); });
      el.appendChild(b);
    }
    return el;
  };
  const paintRes = () => { const [w, hh] = dims(opt.res); resLabel.textContent = `${w}×${hh}`; };
  const resSeg = seg(RES, opt.res, (id) => { opt.res = id; paintRes(); });
  paintRes();
  const fpsSel = h('select.select', { style: 'width:150px' });
  for (const v of [...new Set([pfps, 24, 25, 30, 50, 60])].sort((a, b) => a - b)) fpsSel.appendChild(h('option', { value: v }, v === pfps ? `${v} fps (הפרויקט)` : `${v} fps`));
  fpsSel.value = String(opt.fps);
  fpsSel.addEventListener('change', () => { opt.fps = Number(fpsSel.value); });
  const qSeg = seg(QUALITY.map((q) => ({ id: q.id, label: q.label, title: q.id === 'draft' ? 'לבדיקה מהירה — לא לפרסום' : q.id === 'small' ? 'קובץ קל לשליחה' : '' })), opt.quality, (id) => { opt.quality = id; });
  const lufsIn = h('input.input.mono', { type: 'number', step: 0.5, min: -30, max: -6, value: opt.lufs, style: 'width:80px;direction:ltr;text-align:center' });
  lufsIn.addEventListener('change', () => { const v = Number(lufsIn.value); if (Number.isFinite(v)) opt.lufs = clamp(v, -30, -6); lufsIn.value = String(opt.lufs); });
  const lufsChips = h('div.chip-row');
  for (const [v, label] of LUFS_PRESETS) {
    const b = h('button.chip', { type: 'button', title: `${v} LUFS` }, label);
    b.addEventListener('click', () => { opt.lufs = v; lufsIn.value = String(v); });
    lufsChips.appendChild(b);
  }
  const fromIn = h('input.input', { type: 'text', value: round(opt.from, 2), title: 'שניות' });
  const toIn = h('input.input', { type: 'text', value: round(opt.to, 2), title: 'שניות' });
  const rangeInfo = h('span.hint');
  const custom = h('div.ex-range', { hidden: true }, h('span', 'מ־'), fromIn, h('span', 'עד'), toIn, h('span.hint', 'שניות'));
  const paintRange = () => {
    const [a, b] = opt.range === 'all' ? [0, dur] : opt.range === 'io' ? [r.in, r.out] : [Number(fromIn.value) || 0, Number(toIn.value) || dur];
    rangeInfo.textContent = M.fmtLength(Math.max(0, b - a));
    rangeInfo.title = `${M.formatTimecode(a, pfps)} – ${M.formatTimecode(b, pfps)}`;
  };
  const rangeSeg = seg([
    { id: 'all', label: 'כל הסרטון' },
    { id: 'io', label: 'הקטע המסומן', disabled: !hasIO, title: hasIO ? 'בין נקודת הכניסה ליציאה (I / O)' : 'סמנו קטע בציר הזמן עם המקשים I ו־O' },
    { id: 'custom', label: 'מותאם' },
  ], opt.range, (id) => { opt.range = id; custom.hidden = id !== 'custom'; paintRange(); });
  fromIn.addEventListener('input', paintRange); toIn.addEventListener('input', paintRange);
  for (const el of [fromIn, toIn, lufsIn]) el.addEventListener('keydown', (e) => e.stopPropagation());
  paintRange();
  const modeSeg = seg([
    { id: 'headless', label: 'ברקע', title: 'מהיר — אפשר להמשיך לעבוד בזמן הייצוא' },
    { id: 'inapp', label: 'בחלון הזה', title: 'הייצוא רץ בחלון העורך — השאירו אותו פתוח' },
  ], opt.headless ? 'headless' : 'inapp', (id) => { opt.headless = id === 'headless'; });
  // the speech check only means something when there is a voice-over
  const voice = hasVoice(p);
  const checkIn = h('input', { type: 'checkbox', checked: opt.check && voice, disabled: !voice });
  checkIn.addEventListener('change', () => { opt.check = checkIn.checked; });
  const checkRow = voice
    ? h('label.row', { style: 'cursor:pointer;gap:10px' }, h('span.switch', checkIn, h('span.track')), h('span', 'לבדוק שהקריינות נשמעת מעל המוזיקה'))
    : h('span.hint', 'אין קריינות בפרויקט — אין מה לבדוק');
  const outIn = h('input.input', { type: 'text', dir: 'auto', placeholder: 'אוטומטי (שם הפרויקט ותאריך)', spellcheck: false });
  outIn.addEventListener('keydown', (e) => e.stopPropagation());
  const whereBox = h('div.ex-where', h('span.hint', '…'));
  exportsFolderOf(state.projectId).then((f) => {
    clear(whereBox);
    whereBox.appendChild(f ? pathEl(f, { projectId: state.projectId, projectName: p.name }) : h('span.hint', 'בתיקיית הייצוא של הפרויקט'));
  });

  const form = h('div.ex-grid',
    h('span.lbl', 'רזולוציה'), h('div.row', resSeg, resLabel),
    h('span.lbl', 'איכות'), qSeg,
    h('span.lbl', 'נשמר ב'), whereBox,
  );
  const adv = h('details.pm-adv.ex-adv',
    h('summary', 'מתקדם'),
    h('div.ex-grid', { style: 'padding-top:12px' },
      h('span.lbl', 'קטע'), h('div', { style: 'display:flex;flex-direction:column;gap:6px' }, h('div.row', rangeSeg, rangeInfo), custom),
      h('span.lbl', 'קצב פריימים'), fpsSel,
      h('span.lbl', 'עוצמת שמע'), h('div.row', lufsChips, lufsIn, h('span.hint', { title: 'יעד עוצמה בתקן LUFS' }, 'LUFS')),
      h('span.lbl', 'בדיקת דיבור'), checkRow,
      h('span.lbl', 'ייצוא'), modeSeg,
      h('span.lbl', 'שם / נתיב הקובץ'), outIn,
    ));
  if (store.get('fs.exportAdv', false)) adv.open = true;
  adv.addEventListener('toggle', () => store.set('fs.exportAdv', adv.open));
  const formWrap = h('div', { style: 'display:flex;flex-direction:column;gap:14px' }, form, adv);

  const m = modal({ title: 'ייצוא סרטון', width: 600, body: formWrap, onClose: () => { open = null; cleanup(); } });
  open = m;
  let unsub = null; let poll = null; let jobId = null; let startedAt = 0; let finished = false;
  const cleanup = () => { unsub?.(); clearInterval(poll); };
  m.setActions([
    { label: 'ביטול', ghost: true },
    { label: 'ייצוא', primary: true, icon: 'export', keepOpen: true, onClick: () => { start(); return false; } },
  ]);

  async function start() {
    let from = 0; let to = dur;
    if (opt.range === 'io' && hasIO) { from = r.in; to = r.out; }
    if (opt.range === 'custom') { from = Math.max(0, Number(fromIn.value) || 0); to = Math.min(dur, Number(toIn.value) || dur); }
    if (!(to - from >= 1 / pfps)) { toast('טווח הייצוא קצר מדי', { type: 'error' }); return; }
    const q = QUALITY.find((x) => x.id === opt.quality) || QUALITY[2];
    const [w, hh] = dims(opt.res);
    const body = { from: round(from, 4), to: round(to, 4), fps: opt.fps, crf: q.crf, preset: q.preset, lufs: opt.lufs, headless: opt.headless, check: opt.check && voice, scale: round(scaleFor(opt.res), 6), width: w, height: hh };
    if (outIn.value.trim()) body.out = outIn.value.trim();
    store.set('fs.export', { res: opt.res, fps: opt.fps === pfps ? undefined : opt.fps, quality: opt.quality, headless: opt.headless, check: opt.check });
    showProgress({ status: 'queued', progress: 0 });
    try {
      const res = await api.post(`/api/projects/${encodeURIComponent(state.projectId)}/export`, body);
      const job = res?.job || res;
      jobId = job?.id || job?.jobId;
      if (!jobId) throw new Error('השרת לא החזיר מזהה משימה');
      ownJobs.add(jobId);
      m.jobId = jobId;
      startedAt = performance.now();
      update(jobInfo(job));
      unsub = onEvent('job', (ev) => { const info = jobInfo(ev.job); if (info?.id === jobId) update(info); });
      poll = setInterval(async () => { try { update(jobInfo(await api.get(`/api/jobs/${encodeURIComponent(jobId)}`))); } catch { /* keep polling */ } }, 1000);
      if (!opt.headless) runInApp(jobId);
    } catch (e) { showFailed(e.message); }
  }

  let inAppAbort = null;
  async function runInApp(id) {
    try {
      const mod = await import('../render/render-page.js');
      if (typeof mod.runJobInPage !== 'function') throw new Error('runJobInPage לא קיים במנוע הרינדור');
      inAppAbort = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const onProgress = (pr) => {
        if (!pr || typeof pr !== 'object') { update(jobInfo({ id, progress: Number(pr) || 0, status: 'running' }), true); return; }
        if (pr.phase === 'done') return;
        update(jobInfo({ id, status: 'running', progress: pr.overall ?? pr.progress ?? 0, stage: pr.phase, frames: pr.frame, totalFrames: pr.totalFrames, eta: pr.eta }), true);
      };
      const final = await mod.runJobInPage(id, { onProgress, signal: inAppAbort?.signal });
      const info = jobInfo(final);
      if (info && info.status === 'done' && !finished) finish(info);
    } catch (e) {
      if (finished) return;
      try { await api.post(`/api/jobs/${encodeURIComponent(id)}/fail`, { error: `רינדור בתוך העורך נכשל: ${e.message}` }); } catch { /* ignore */ }
      showFailed(`רינדור בתוך העורך נכשל: ${e.message}`);
    }
  }

  // ---- progress view
  let prog = null;
  function showProgress() {
    clear(m.body);
    const bar = h('div.bar'); const pbox = h('div.progress', bar);
    const pct = h('span.ex-pct', '0%'); const stage = h('span.ex-stage', 'ממתין להתחלה…');
    const stat = (label) => { const b = h('b', '—'); return [h('div.stat', b, h('span', label)), b]; };
    const [s1, frames] = stat('פריימים'); const [s2, eta] = stat('זמן משוער לסיום'); const [s3, elapsed] = stat('זמן שעבר');
    m.body.append(h('div.ex-prog-head', stage, pct), pbox, h('div.ex-stats', s1, s2, s3),
      h('div.hint', opt.headless ? 'הרינדור רץ ברקע — אפשר לסגור את החלון ולהמשיך לערוך. נקבל הודעה בסיום.' : 'הרינדור רץ בחלון הזה — השאירו אותו פתוח עד הסיום.'));
    prog = { bar, pbox, pct, stage, frames, eta, elapsed };
    m.setActions([
      { label: 'עצירת הייצוא', danger: true, keepOpen: true, onClick: () => { cancel(); return false; } },
      { label: opt.headless ? 'הסתרה' : 'סגירה', ghost: true },
    ]);
  }

  function update(info, local = false) {
    if (!info || finished || !prog) return;
    if (info.status === 'done') { finish(info); return; }
    if (info.status === 'failed') { showFailed(info.error || 'הייצוא נכשל'); return; }
    const p2 = info.progress;
    prog.bar.style.width = `${(p2 * 100).toFixed(1)}%`;
    prog.pct.textContent = `${Math.floor(p2 * 100)}%`;
    const st = String(info.stage || '').toLowerCase();
    prog.stage.textContent = STAGES[st] || info.stage || (info.status === 'queued' ? 'בתור…' : p2 > 0.97 ? 'מסיים שמע ואיחוד…' : 'מרנדר פריימים…');
    if (info.frames != null) prog.frames.textContent = info.totalFrames ? `${info.frames} / ${info.totalFrames}` : String(info.frames);
    const el = (performance.now() - startedAt) / 1000;
    prog.elapsed.textContent = fmtEta(el);
    const eta = info.eta != null ? info.eta : (p2 > 0.02 ? (el * (1 - p2)) / p2 : null);
    prog.eta.textContent = eta != null ? fmtEta(eta) : 'מחשב…';
    void local;
  }

  async function cancel() {
    if (!jobId) { m.close(); return; }
    try { await api.post(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {}); }
    catch { try { await api.post(`/api/jobs/${encodeURIComponent(jobId)}/fail`, { error: 'בוטל על ידי המשתמש' }); } catch { /* ignore */ } }
    inAppAbort?.abort();
    showFailed('הייצוא בוטל');
  }

  function showFailed(msg) {
    finished = true; m.finished = true; cleanup();
    clear(m.body);
    m.body.append(h('div.row', { style: 'gap:12px' }, h('div.ex-done-ic', { style: 'background:var(--danger-soft);color:var(--danger)', html: icon('alert', 22) }), h('div', { style: 'font-size:14px;font-weight:650' }, 'הייצוא לא הושלם')), h('div.ex-err', msg));
    m.setActions([{ label: 'סגירה', ghost: true }, { label: 'ניסיון נוסף', primary: true, keepOpen: true, onClick: () => { m.close(); setTimeout(() => openExportDialog(viewer), 180); return false; } }]);
  }

  function finish(info) {
    finished = true; m.finished = true; cleanup();
    clear(m.body);
    const out = info.output || '';
    const rep = info.report && typeof info.report === 'object' ? info.report : {};
    const fileName = out.split(/[\\/]/).pop() || '';
    const facts = [rep.duration != null ? M.fmtLength(Number(rep.duration)) : null, rep.size != null ? fmtBytes(Number(rep.size)) : null, rep.width && rep.height ? `${rep.width}×${rep.height}` : null].filter(Boolean);
    const openBtn = h('button.btn.btn-primary', { type: 'button', html: `${icon('folderOpen', 15)}<span>פתיחת התיקייה</span>` });
    openBtn.addEventListener('click', async () => {
      try { await api.post('/api/reveal', { path: out }); }
      catch { const dir = out.replace(/[\\/][^\\/]*$/, ''); if (await copyText(dir)) toast('נתיב התיקייה הועתק — הדביקו בסייר הקבצים', { type: 'success' }); }
    });
    const copyBtn = h('button.btn', { type: 'button', title: out, html: `${icon('copy', 15)}<span>העתקת הנתיב</span>` });
    copyBtn.addEventListener('click', async () => { if (await copyText(out)) toast('הנתיב הועתק', { type: 'success', timeout: 1500 }); });
    m.body.append(
      h('div.row', { style: 'gap:12px' }, h('div.ex-done-ic', { html: icon('check', 24) }),
        h('div', h('div', { style: 'font-size:15px;font-weight:650' }, 'הסרטון מוכן'), h('div.hint', facts.length ? facts.join(' · ') : `נמשך ${fmtEta((performance.now() - startedAt) / 1000)}`))),
      out ? h('div.ex-done-where', h('div.ex-file', h('bdi', fileName)), pathEl(out, { projectId: state.projectId, projectName: state.project?.name }), h('div.row', { style: 'gap:6px' }, openBtn, copyBtn))
        : h('div.note', 'הקובץ נשמר בתיקיית הייצוא של הפרויקט'),
    );
    if (rep.loudness && rep.loudness.silent) m.body.append(h('div.note.warn', 'שימו לב: אין שמע בסרטון שיוצא.'));
    const speech = speechCard(rep);
    if (speech) m.body.append(speech);
    const detail = reportRows(rep);
    if (detail) {
      const d = h('details.pm-adv.ex-adv', h('summary', 'פרטים'), h('div', { style: 'padding-top:10px' }, detail));
      m.body.append(d);
    }
    m.setActions([{ label: 'סגירה', primary: true }, { label: 'ייצוא נוסף', ghost: true, keepOpen: true, onClick: () => { m.close(); setTimeout(() => openExportDialog(viewer), 180); return false; } }]);
    if (!m.back.isConnected) toast('הייצוא הושלם', { type: 'success' }); // the dialog already says so while it is open
  }
  return m;
}

/** the technical report ("פרטים"): file facts and loudness, for those who want them */
function reportRows(rep) {
  if (!rep || typeof rep !== 'object') return null;
  const box = h('div.report');
  const add = (label, value, bad = false) => { if (value == null || value === '') return; box.appendChild(h('div.report-row' + (bad ? '.bad' : ''), h('span', label), h('bdi', String(value)))); };
  const n = (v, d = 1) => (Number.isFinite(Number(v)) ? round(Number(v), d) : null);
  const L = rep.loudness || {};
  if (rep.duration != null) add('משך', `${n(rep.duration, 2)} ש׳`);
  if (rep.width && rep.height) add('רזולוציה', `${rep.width}×${rep.height}${rep.fps ? ` · ${rep.fps}fps` : ''}`);
  if (rep.frames != null) add('פריימים', rep.frames);
  if (rep.size != null) add('גודל קובץ', fmtBytes(Number(rep.size)));
  if (rep.videoCodec || rep.audioCodec) add('פורמט', [rep.videoCodec, rep.audioCodec].filter(Boolean).join(' + '));
  const lufs = rep.lufs ?? L.lufs ?? rep.integrated;
  if (lufs != null) add('עוצמה (LUFS)', `${n(lufs)}${L.targetLufs != null ? ` (יעד ${L.targetLufs})` : ''}`, L.targetLufs != null && Math.abs(Number(lufs) - L.targetLufs) > 1);
  const tp = rep.truePeak ?? rep.tp;
  if (tp != null) add('שיא (dBTP)', n(tp), Number(tp) > -1);
  if (L.inputLufs != null) add('עוצמה לפני התיקון', `${n(L.inputLufs)} LUFS`);
  if (L.gainDb != null) add('תיקון עוצמה', `${Number(L.gainDb) > 0 ? '+' : ''}${n(L.gainDb)} dB`);
  if (L.silent) add('שמע', 'שקט — לא נמצא שמע בייצוא', true);
  if (rep.renderSeconds != null) add('זמן ייצוא', `${n(rep.renderSeconds)} ש׳${rep.renderFps ? ` · ${n(rep.renderFps)} פריימים לשנייה` : ''}`);
  return box.children.length ? box : null;
}

/**
 * Speech check verdict — only when there was a voice-over to check (no voice → nothing, never a false "sounds good").
 * A problem shows the times to fix as clickable chips.
 */
function speechCard(rep) {
  const n = (v, d = 1) => (Number.isFinite(Number(v)) ? round(Number(v), d) : null);
  const wrap = h('div', { style: 'display:flex;flex-direction:column;gap:10px' });
  const sm = rep && (rep.speechMargin || rep.speech) || null;
  if (sm && typeof sm === 'object' && !sm.error && sm.min != null && (sm.activeWindows ?? 1) > 0) {
    const ok = sm.ok !== undefined ? sm.ok !== false : !(Number(sm.min) < (sm.thresholdDb ?? 12));
    const card = h('div', { style: `border:1px solid ${ok ? 'rgba(47,210,122,.4)' : 'rgba(245,197,24,.45)'};background:${ok ? 'rgba(47,210,122,.08)' : 'rgba(245,197,24,.07)'};border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:8px` });
    card.appendChild(h('div', { style: 'display:flex;align-items:center;gap:8px;font-weight:650', html: `<span style="color:${ok ? 'var(--ok)' : 'var(--warn)'};display:flex">${icon(ok ? 'check' : 'alert', 16)}</span><span>${ok ? 'הדיבור נשמע היטב מעל הרקע' : 'הדיבור נבלע ברקע בחלק מהזמנים'}</span>` }));
    const facts = [];
    if (sm.min != null) facts.push(`מינימום ${n(sm.min)} dB`);
    if (sm.median != null) facts.push(`חציון ${n(sm.median)} dB`);
    if (sm.thresholdDb != null) facts.push(`יעד ${sm.thresholdDb} dB`);
    if (facts.length) card.title = facts.join(' · ');
    if (!ok) card.appendChild(h('div', { style: 'color:var(--text-2);font-size:12px;line-height:1.5' }, 'כדאי להנמיך את המוזיקה בזמנים האלה (או להגביר את הקריינות):'));
    const times = Array.isArray(sm.below) ? sm.below.map((b) => (typeof b === 'number' ? b : b?.t)).filter((t) => Number.isFinite(t)) : [];
    if (times.length) {
      const chips = h('div.chip-row');
      for (const t of times.slice(0, 16)) {
        const b = h('button.chip', { type: 'button', title: 'מעבר לזמן הזה בעורך' }, `${round(t, 1)} ש׳`);
        b.addEventListener('click', () => state.set({ playhead: t }));
        chips.appendChild(b);
      }
      if (times.length > 16) chips.appendChild(h('span.hint', `ועוד ${times.length - 16}…`));
      card.appendChild(h('div.hint', 'לחיצה על זמן מזיזה את סמן הניגון לשם:'));
      card.appendChild(chips);
    }
    wrap.appendChild(card);
  }
  return wrap.children.length ? wrap : null;
}
