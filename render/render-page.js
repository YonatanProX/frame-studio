// Frame Studio — export / snapshot job runner (agent A)
// Used two ways:
//   1. render/render.html (headless Chrome, launched by server/export.mjs) → bootRenderPage()
//   2. the editor window (app/main.js export dialog) → runJobInPage(jobId, { onProgress })
// Talks to server/export.mjs:  GET /api/jobs/:job, GET /api/jobs/:job/project,
//   POST /api/jobs/:job/{progress,frame,audio,stems,png,done,fail,log}
// Must import cleanly in Node: no DOM access at module top level; render modules load lazily.

const enc = encodeURIComponent;

class JobCanceled extends Error {
  constructor(msg = 'המשימה בוטלה') { super(msg); this.name = 'JobCanceled'; this.canceled = true; }
}

function nowMs() {
  return (globalThis.performance && typeof performance.now === 'function') ? performance.now() : Date.now();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setStatus(text) {
  try {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('status');
    if (el) el.textContent = text;
  } catch { /* ignore */ }
}

function publishState(patch) {
  const s = (globalThis.__frameStudioRender ||= {});
  Object.assign(s, patch);
}

async function readError(res) {
  try {
    const j = await res.json();
    if (j && j.error) return j.error;
  } catch { /* not json */ }
  return `שגיאת שרת ${res.status}`;
}

function makeApi(apiBase, jobId, signal) {
  const J = `${apiBase}/api/jobs/${enc(jobId)}`;
  const check = async (res) => {
    if (res.status === 409 || res.status === 410) throw new JobCanceled(await readError(res));
    if (!res.ok) throw new Error(await readError(res));
    return res;
  };
  const withRetry = async (fn) => {
    try { return await fn(); }
    catch (e) {
      if (e instanceof JobCanceled || signal?.aborted || !(e instanceof TypeError)) throw e;
      await sleep(250);               // one retry for a transient network error
      return fn();
    }
  };
  return {
    J,
    async getJson(url) {
      return withRetry(async () => (await check(await fetch(url, { cache: 'no-store', signal }))).json());
    },
    async postJson(path, body) {
      return withRetry(async () => {
        const res = await check(await fetch(J + path, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}), signal,
        }));
        const txt = await res.text();
        return txt ? JSON.parse(txt) : {};
      });
    },
    async postBinary(path, data, type, headers = {}) {
      return withRetry(async () => {
        const res = await check(await fetch(J + path, {
          method: 'POST', headers: { 'Content-Type': type, ...headers }, body: data, signal,
        }));
        const txt = await res.text();
        return txt ? JSON.parse(txt) : {};
      });
    },
    // Fire-and-forget (logging, heartbeats). Never throws.
    beacon(path, body) {
      try {
        fetch(J + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}), keepalive: true }).catch(() => {});
      } catch { /* ignore */ }
    },
  };
}

function makeCanvas(w, h, existing) {
  if (existing) {
    if (existing.width !== w) existing.width = w;
    if (existing.height !== h) existing.height = h;
    return existing;
  }
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  throw new Error('אין קנבס זמין לרינדור');
}

async function canvasToPng(canvas) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('יצירת PNG נכשלה'))), 'image/png'));
}

/** RGBA top-down pixels → PNG Blob, optionally scaled. Alpha forced opaque (like the video). */
async function pixelsToPng(px, w, h, scale) {
  const data = new Uint8ClampedArray(px.buffer, px.byteOffset, w * h * 4);
  const copy = new Uint8ClampedArray(data);
  for (let i = 3; i < copy.length; i += 4) copy[i] = 255;
  const full = makeCanvas(w, h);
  const g = full.getContext('2d');
  g.putImageData(new ImageData(copy, w, h), 0, 0);
  if (!scale || Math.abs(scale - 1) < 1e-6) return canvasToPng(full);
  const dw = Math.max(1, Math.round(w * scale)), dh = Math.max(1, Math.round(h * scale));
  const small = makeCanvas(dw, dh);
  const sg = small.getContext('2d');
  sg.imageSmoothingEnabled = true;
  sg.imageSmoothingQuality = 'high';
  sg.drawImage(full, 0, 0, dw, dh);
  return canvasToPng(small);
}

function fmtEta(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m ? `${m} דק׳ ${s} שנ׳` : `${s} שנ׳`;
}

/**
 * Runs one export / snapshot / audio job against the server.
 * opts: { canvas?: HTMLCanvasElement|OffscreenCanvas, onProgress?(info), apiBase?:"", signal?: AbortSignal }
 * onProgress info: { jobId, type, phase:"loading"|"audio"|"video"|"snapshot"|"finishing"|"done", progress 0..1 (phase),
 *                    overall 0..1 (whole job, monotonic),
 *                    frame?, totalFrames?, eta? (s), message (Hebrew) }
 * Resolves with the final job object returned by POST /done (outputs + report).
 */
export async function runJobInPage(jobId, opts = {}) {
  const { canvas = null, onProgress = null, apiBase = '', signal = null } = opts;
  const api = makeApi(apiBase, jobId, signal);
  const warnings = [];
  const st = { phase: 'loading', progress: 0, frame: 0 };
  let heartbeat = null;
  let jobType = 'export';
  const disposers = [];

  // Overall 0..1 across phases (for one progress bar): export = audio 0–4 %, frames 4–96 %, encode/mux 96–100 %.
  const overallOf = (phase, p) => {
    if (phase === 'done') return 1;
    if (phase === 'finishing') return jobType === 'export' ? 0.97 : 0.99;
    if (jobType === 'export') {
      if (phase === 'audio') return 0.04 * p;
      if (phase === 'video') return 0.04 + 0.92 * p;
      return st.overall || 0;
    }
    if (phase === 'audio' || phase === 'snapshot') return 0.98 * p;
    return st.overall || 0;
  };
  const emit = (phase, progress, extra = {}) => {
    st.phase = phase; st.progress = progress;
    st.overall = Math.max(st.overall || 0, overallOf(phase, progress));
    if (extra.frame != null) st.frame = extra.frame;
    const info = { jobId, type: jobType, phase, progress, overall: st.overall, ...extra };
    publishState({ jobId, phase, progress, frame: st.frame });
    if (info.message) setStatus(info.message);
    if (typeof onProgress === 'function') { try { onProgress(info); } catch { /* UI errors must not kill the job */ } }
  };
  const checkAbort = () => { if (signal?.aborted) throw new JobCanceled('הייצוא בוטל'); };

  try {
    publishState({ jobId, status: 'running', error: null });
    const job = await api.getJson(api.J);
    jobType = job.type || 'export';
    if (['done', 'error', 'canceled'].includes(job.status)) throw new Error('המשימה כבר הסתיימה');
    emit('loading', 0, { message: 'טוען את הפרויקט…' });
    await api.postJson('/progress', { phase: 'loading', progress: 0 });
    heartbeat = setInterval(() => api.beacon('/progress', { phase: st.phase, progress: st.progress, frame: st.frame }), 4000);

    let project = null;
    try { project = await api.getJson(`${api.J}/project`); } catch (e) { if (e instanceof JobCanceled) throw e; }
    if (!project || !project.settings) project = await api.getJson(`${apiBase}/api/projects/${enc(job.projectId)}`);
    const W = Math.max(2, Math.round(project.settings?.width || 1080));
    const H = Math.max(2, Math.round(project.settings?.height || 1920));
    checkAbort();

    /* ---------------- audio (export: mix [+stems]; audio job: mix + stems) ---------------- */
    if (jobType === 'export' || jobType === 'audio') {
      const fps = job.fps || project.settings?.fps || 30;
      const from = Number(job.from) || 0;
      const to = jobType === 'export' && job.totalFrames ? from + job.totalFrames / fps : Number(job.to);
      emit('audio', 0, { message: 'מרנדר שמע…' });
      const { AudioEngine } = await import('./audio-engine.js');
      const engine = new AudioEngine({ projectId: job.projectId, apiBase });
      engine.setProject(project);
      const audio = await engine.renderOffline({
        from, to, sampleRate: job.sampleRate || 48000, stems: !!job.stems,
        onProgress: (p) => emit('audio', p, { message: `מרנדר שמע… ${Math.round(p * 100)}%` }),
      });
      for (const w of audio.warnings || []) warnings.push(w);
      checkAbort();
      await api.postBinary('/audio', AudioEngine.encodeWav(audio.mix, { float: true }), 'audio/wav');
      if (job.stems && audio.voice && audio.background) {
        await api.postBinary('/stems?kind=voice', AudioEngine.encodeWav(audio.voice, { float: true }), 'audio/wav');
        await api.postBinary('/stems?kind=background', AudioEngine.encodeWav(audio.background, { float: true }), 'audio/wav');
      }
      engine.dispose();
    }

    /* ---------------- video frames / snapshots ---------------- */
    if (jobType === 'export' || jobType === 'snapshot') {
      emit('loading', 0, { message: 'טוען גופנים ומדיה…' });
      const [compMod, srcMod, textMod] = await Promise.all([
        import('./compositor.js'), import('./sources.js'), import('./text-render.js'),
      ]);
      if (typeof textMod.ensureFonts === 'function') await textMod.ensureFonts(project);
      checkAbort();
      const cv = makeCanvas(W, H, canvas);
      const comp = new compMod.Compositor(cv, { mode: 'export', scale: 1 });
      disposers.push(() => comp.dispose && comp.dispose());
      comp.setProject(project);
      const sources = new srcMod.SourceProvider({ mode: 'export', projectId: job.projectId, apiBase });
      disposers.push(() => sources.dispose && sources.dispose());
      sources.setProject(project);
      const expected = W * H * 4;
      const grab = () => {
        const px = comp.readPixels();
        if (!px || px.length !== expected) {
          throw new Error(`גודל הפריים מהמרכיב שגוי (${px ? px.length : 0} במקום ${expected})`);
        }
        return px;
      };

      if (jobType === 'export') {
        const fps = job.fps || project.settings?.fps || 30;
        const from = Number(job.from) || 0;
        const total = Math.max(1, job.totalFrames | 0);
        const t0 = nowMs();
        let pending = null;
        emit('video', 0, { frame: 0, totalFrames: total, message: 'מרנדר פריימים…' });
        for (let n = 0; n < total; n++) {
          checkAbort();
          const t = from + n / fps;
          await comp.renderFrame(t, sources);
          const px = grab();
          if (pending) await pending;           // backpressure: one frame in flight at most
          pending = api.postBinary('/frame', px, 'application/octet-stream', { 'X-Frame': String(n) });
          const done = n + 1;
          const elapsed = (nowMs() - t0) / 1000;
          const eta = done > 2 ? (elapsed / done) * (total - done) : null;
          emit('video', done / total, {
            frame: done, totalFrames: total, eta,
            message: `פריים ${done} מתוך ${total}${eta != null ? ` · נותרו ${fmtEta(eta)}` : ''}`,
          });
        }
        if (pending) await pending;
      } else {
        const times = Array.isArray(job.times) ? job.times : [];
        const scale = Number(job.scale) > 0 ? Number(job.scale) : 1;
        for (let i = 0; i < times.length; i++) {
          checkAbort();
          const t = Number(times[i]) || 0;
          await comp.renderFrame(t, sources);
          const png = await pixelsToPng(grab(), W, H, scale);
          await api.postBinary(`/png?t=${enc(String(t))}&i=${i}`, png, 'image/png');
          emit('snapshot', (i + 1) / times.length, { frame: i + 1, totalFrames: times.length, message: `תמונה ${i + 1} מתוך ${times.length}` });
        }
      }
    }

    emit('finishing', 1, { message: 'מסיים (קידוד ומיזוג)…' });
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    heartbeat = setInterval(() => api.beacon('/progress', { phase: 'finishing', progress: 1 }), 4000);
    const final = await api.postJson('/done', { warnings });
    emit('done', 1, { message: 'הסתיים ✓', job: final });
    publishState({ status: 'done' });
    return final;
  } catch (err) {
    const canceled = err instanceof JobCanceled || signal?.aborted;
    const msg = canceled ? 'המשימה בוטלה' : (err?.message || String(err));
    publishState({ status: canceled ? 'canceled' : 'error', error: msg });
    setStatus(`שגיאה: ${msg}`);
    if (!(err instanceof JobCanceled)) {
      try {
        await fetch(`${api.J}/fail`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: msg, stack: err?.stack ? String(err.stack).slice(0, 4000) : undefined, canceled: !!canceled }),
        });
      } catch { /* server gone */ }
    }
    throw err;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    for (const d of disposers.reverse()) { try { d(); } catch { /* ignore */ } }
  }
}

/* ------------------------------------------------------------------ headless page boot */

function installPageLogging(jobId) {
  if (typeof window === 'undefined' || !jobId) return;
  const J = `/api/jobs/${enc(jobId)}/log`;
  let sent = 0;
  const send = (level, parts) => {
    if (sent > 200) return;
    sent++;
    const msg = parts.map((p) => {
      if (p instanceof Error) return `${p.message}\n${p.stack || ''}`;
      if (typeof p === 'string') return p;
      try { return JSON.stringify(p); } catch { return String(p); }
    }).join(' ').slice(0, 2000);
    try { fetch(J, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level, msg }), keepalive: true }).catch(() => {}); } catch { /* ignore */ }
  };
  for (const level of ['error', 'warn']) {
    const orig = console[level].bind(console);
    console[level] = (...a) => { send(level, a); orig(...a); };
  }
  window.addEventListener('error', (e) => send('error', [`שגיאה לא מטופלת: ${e.message} (${e.filename}:${e.lineno})`]));
  window.addEventListener('unhandledrejection', (e) => send('error', ['הבטחה שנדחתה:', e.reason]));
}

async function pollWorker(workerId) {
  let failures = 0;
  setStatus('ממתין למשימה…');
  for (;;) {
    try {
      const res = await fetch(`/api/render-worker/next?worker=${enc(workerId)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const j = await res.json();
      failures = 0;
      if (j.exit) { setStatus('העבודה הסתיימה'); try { window.close(); } catch { /* ignore */ } return; }
      if (j.job) { location.replace(`render.html?job=${enc(j.job)}&worker=${enc(workerId)}`); return; }
    } catch {
      failures++;
      if (failures >= 5) { try { window.close(); } catch { /* ignore */ } return; }
      await sleep(1000);
    }
  }
}

/** Entry point of render/render.html. */
export function bootRenderPage() {
  if (typeof location === 'undefined') return;
  const q = new URLSearchParams(location.search);
  const jobId = q.get('job');
  const workerId = q.get('worker');
  if (jobId) {
    installPageLogging(jobId);
    setStatus('מתחיל…');
    const canvas = typeof document !== 'undefined' ? document.getElementById('c') : null;
    runJobInPage(jobId, { canvas })
      .catch(() => { /* already reported through /fail */ })
      .finally(() => {
        if (workerId) setTimeout(() => location.replace(`render.html?worker=${enc(workerId)}`), 30);
      });
  } else if (workerId) {
    pollWorker(workerId);
  } else {
    setStatus('דף רינדור של Frame Studio — אין משימה פעילה');
  }
}

export default runJobInPage;
