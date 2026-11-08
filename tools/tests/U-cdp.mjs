// Frame Studio — tools/tests/U-cdp.mjs (agent U self-test)
// Drives headless Chrome over the DevTools protocol (Node 24 global WebSocket): navigates the editor on the mock
// server, runs scripted interactions, captures screenshots and collects console errors / exceptions / failed requests.
// usage: node tools/tests/U-cdp.mjs [scenario]   (scenarios: all | manager | editor | ...)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'U-out');
fs.mkdirSync(OUT, { recursive: true });
const CHROME = [process.env.FRAME_STUDIO_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  .find((f) => f && fs.existsSync(f));
if (!CHROME) { console.error('Chrome / Edge not found (set FRAME_STUDIO_CHROME)'); process.exit(1); }
const BASE = process.env.BASE || 'http://127.0.0.1:7794';
const DPORT = Number(process.env.DPORT || 9794);
const W = 1600; const H = 950;
const PROJECT = process.env.PROJECT || 'u-demo';
const EXPORT_WAIT = Number(process.env.EXPORT_WAIT || 6000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// browser profile in the OS temp folder, never inside the repository
const prof = path.join(os.tmpdir(), 'frame-studio-tests', 'U-chrome-prof');
const chrome = spawn(CHROME, [
  '--headless=new', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--no-first-run', '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required', `--remote-debugging-port=${DPORT}`, `--user-data-dir=${prof}`, `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map(); const logs = []; const errors = [];
async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DPORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
    } catch { /* not up yet */ }
    await sleep(150);
  }
  if (!ws) throw new Error('chrome devtools not reachable');
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); if (msg.error) rej(new Error(msg.error.message)); else res(msg.result); return; }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
      logs.push(`[${msg.params.type}] ${text}`);
      if (msg.params.type === 'error') errors.push(`console.error: ${text}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(`exception: ${d.exception?.description || d.text} @ ${d.url || ''}:${d.lineNumber}`);
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      if (e.level === 'error') errors.push(`log: ${e.text} ${e.url || ''}`);
    }
  };
}
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`timeout ${method}`)); } }, 30000); });
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const f = path.join(OUT, `${name}.png`);
  fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
  console.log(`  screenshot → ${f}`);
}
async function nav(url, wait = 1500) {
  await send('Page.navigate', { url });
  await sleep(wait);
}
async function key(k, { code, shift = false, ctrl = false } = {}) {
  const mods = (shift ? 8 : 0) | (ctrl ? 2 : 0);
  const keyCode = { ' ': 32, Delete: 46, ArrowLeft: 37, ArrowRight: 39, Escape: 27, Home: 36, End: 35 }[k] || (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: code || k, modifiers: mods, windowsVirtualKeyCode: keyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: code || k, modifiers: mods, windowsVirtualKeyCode: keyCode });
}
async function mouse(type, x, y, buttons = 1) {
  await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: type === 'mouseReleased' || type === 'mousePressed' ? 1 : 0 });
}
const check = (cond, label) => { console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}`); if (!cond) failures.push(label); };
const failures = [];

async function main() {
  await connect();
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const which = process.argv[2] || 'all';

  if (which === 'eval') {
    await nav(`${BASE}/?project=${PROJECT}`, Number(process.env.WAIT || 3500));
    for (const expr of process.argv.slice(3)) {
      try { console.log(JSON.stringify(await evaluate(expr), null, 1)); } catch (e) { console.log('ERR', e.message); }
    }
    if (process.env.SHOT) await shot(process.env.SHOT);
  }

  if (which === 'all' || which === 'manager') {
    console.log('# project manager');
    await nav(`${BASE}/`, 1800);
    await shot('01-manager');
    check(await evaluate(`!!document.querySelector('.pm-back') && document.querySelectorAll('.pcard').length >= 1`), 'manager lists projects');
    await evaluate(`document.querySelector('.pm-new-btn').click()`); await sleep(400);
    check(await evaluate(`document.querySelectorAll('.modal .aspect').length === 4 && !!document.querySelector('.modal details.pm-adv:not([open])')`), 'new-project dialog: 4 formats, advanced collapsed');
    await key('Escape', { code: 'Escape' }); await sleep(300);
  }

  if (which === 'all' || which === 'editor') {
    console.log('# editor');
    await nav(`${BASE}/?project=${PROJECT}`, 3500);
    await shot('02-editor');
    check(await evaluate(`!!window.FrameStudio && !!FrameStudio.state.project`), 'project loaded');
    // #claudeInd: "off" = no live link to the server; ready / setup / on = linked (app/ui-claude.js)
    check(await evaluate(`(() => { const c = document.querySelector('#claudeInd').classList; return !c.contains('off') && (c.contains('on') || c.contains('ready') || c.contains('setup')); })()`), 'SSE connected indicator');
    check(await evaluate(`document.querySelector('#projName').value.length > 0`), 'project name shown');

    // select text clip → inspector text tab
    await evaluate(`FrameStudio.state.set({ selection: new Set(['c_title']), playhead: 1 })`); await sleep(600);
    await shot('03-text-selected');
    check(await evaluate(`[...document.querySelectorAll('#inspector .tab')].map(t=>t.textContent).join(',').includes('טקסט')`), 'text tabs present');

    // edit tab on the image (keyframed scale)
    await evaluate(`FrameStudio.state.set({ selection: new Set(['c_img']), playhead: 1.6 })`); await sleep(500);
    await evaluate(`[...document.querySelectorAll('#inspector .tab')].find(t=>t.textContent.includes('עריכה'))?.click()`); await sleep(400);
    await shot('04-image-basic');
    check(await evaluate(`document.querySelectorAll('#inspector .kf-dia.has').length >= 1`), 'keyframe diamond shows existing keyframes');
    check(await evaluate(`(()=>{ const r=[...document.querySelectorAll('#inspector .row')].find(x=>x.querySelector('.lbl')?.textContent==='סיבוב'); return !!r && !r.querySelector('.kf-dia'); })()`), 'rows without keyframes have no per-row diamond');

    // numeric commit through inspector → optimistic + server
    const before = await evaluate(`FrameStudio.state.project.rev`);
    await evaluate(`(()=>{ const r=[...document.querySelectorAll('#inspector .row')].find(x=>x.querySelector('.lbl')?.textContent==='סיבוב'); const n=r.querySelector('.num'); n.focus(); n.value='12'; n.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); })()`);
    await sleep(500);
    check(await evaluate(`FrameStudio.state.project.clips.c_img.transform.rotation === 12 && FrameStudio.state.project.rev > ${before}`), 'rotation committed via inspector (rev advanced)');

    // section "הוסף קיפריים" diamond keyframes the section's props (incl. rotation) at the playhead
    await evaluate(`(()=>{ const sec=[...document.querySelectorAll('#inspector .sec')].find(x=>x.querySelector('.sec-title')?.textContent==='מיקום וגודל'); sec.querySelector('.sec-head .kf-sec').click(); })()`);
    await sleep(500);
    check(await evaluate(`(FrameStudio.state.project.clips.c_img.keyframes['transform.rotation']||[]).length === 1`), 'keyframe added via section diamond');
    check(await evaluate(`(()=>{ const r=[...document.querySelectorAll('#inspector .row')].find(x=>x.querySelector('.lbl')?.textContent==='סיבוב'); return !!r?.querySelector('.kf-dia'); })()`), 'keyframed row now shows its own diamond');

    // color tab
    await evaluate(`[...document.querySelectorAll('#inspector .tab')].find(t=>t.textContent.includes('צבע'))?.click()`); await sleep(400);
    await shot('05-image-color');

    // undo via keyboard
    const kfCount = await evaluate(`(FrameStudio.state.project.clips.c_img.keyframes['transform.rotation']||[]).length`);
    await evaluate(`document.activeElement?.blur()`);
    await key('z', { code: 'KeyZ', ctrl: true }); await sleep(600);
    check(await evaluate(`(FrameStudio.state.project.clips.c_img.keyframes['transform.rotation']||[]).length`) === kfCount - 1, 'Ctrl+Z undo removed keyframe');

    // project settings (nothing selected)
    await evaluate(`FrameStudio.state.set({ selection: new Set() })`); await sleep(400);
    await shot('06-project-settings');
    check(await evaluate(`document.querySelectorAll('#inspector .trk').length === FrameStudio.state.project.tracks.length`), 'track list matches project');

    // claude live edit
    await fetch(`${BASE}/api/projects/${PROJECT}/ops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by: 'claude', summary: 'הוספתי כותרת "בום!" בשנייה 2', ops: [{ op: 'addClip', id: 'c_boom', type: 'text', start: 0.5, duration: 2, content: 'בום!', set: { 'transform.y': 120, 'text.size': 160, 'text.color': '#ffd60a' } }] }) });
    await sleep(500);
    await shot('07-claude-edit');
    check(await evaluate(`!!FrameStudio.state.project.clips.c_boom`), 'claude edit arrived via SSE');
    check(await evaluate(`document.querySelector('.toast-claude') !== null`), 'claude toast shown');
    check(await evaluate(`document.querySelector('#claudeInd').classList.contains('on')`), 'claude indicator shows Claude editing');

    // shortcuts: split at playhead (S) on selected video, then delete
    await evaluate(`FrameStudio.state.set({ selection: new Set(['c_vid']), playhead: 4 })`); await sleep(200);
    const n0 = await evaluate(`Object.keys(FrameStudio.state.project.clips).length`);
    await key('s', { code: 'KeyS' }); await sleep(600);
    check(await evaluate(`Object.keys(FrameStudio.state.project.clips).length`) === n0 + 1, 'S splits selected clip');
    // play / pause
    await key(' ', { code: 'Space' }); await sleep(700);
    const playing = await evaluate(`FrameStudio.state.playing`);
    const ph = await evaluate(`FrameStudio.state.playhead`);
    await key(' ', { code: 'Space' }); await sleep(200);
    check(playing === true && ph > 4, `Space plays (playhead advanced to ${ph?.toFixed?.(2)})`);
    check(await evaluate(`FrameStudio.state.playing === false`), 'Space pauses');

    // on-canvas drag of the sticker
    await evaluate(`FrameStudio.state.set({ selection: new Set(['c_sticker']), playhead: 2 })`); await sleep(500);
    const b = await evaluate(`(()=>{ const bb = FrameStudio.viewer.getClipBounds('c_sticker'); const fr = document.querySelector('.vw-frame').getBoundingClientRect(); if(!bb) return null; const k = fr.width/1080; return { x: fr.left + bb.cx*k, y: fr.top + bb.cy*k }; })()`);
    if (b) {
      const x0 = FrameStudioX(b.x); const y0 = b.y;
      await mouse('mouseMoved', x0, y0, 0); await mouse('mousePressed', x0, y0);
      for (let i = 1; i <= 6; i++) await mouse('mouseMoved', x0 - i * 8, y0 + i * 5);
      await mouse('mouseReleased', x0 - 48, y0 + 30); await sleep(600);
      const tx = await evaluate(`FrameStudio.state.project.clips.c_sticker.transform`);
      check(tx.x < 300 && tx.y > -200, `drag on canvas moved sticker (x=${tx.x}, y=${tx.y})`);
    } else check(false, 'sticker bounds available for drag');
    await shot('08-after-drag');

    // export dialog
    await evaluate(`document.querySelector('#btnExport').click()`); await sleep(400);
    await shot('09-export-dialog');
    await evaluate(`document.querySelector('.modal [data-action], .modal .btn-primary')?.click()`); await sleep(1200);
    await shot('10-export-progress');
    for (let w = 0; w < EXPORT_WAIT; w += 500) { if (await evaluate(`!!document.querySelector('.modal .ex-out, .modal .ex-err, .modal .ex-done-ic')`)) break; await sleep(500); }
    await sleep(300);
    await shot('11-export-done');
    const exErr = await evaluate(`document.querySelector('.modal .ex-err')?.textContent || ''`);
    if (exErr) console.log('  export error text:', exErr);
    check(await evaluate(`!!document.querySelector('.modal .ex-out .path')`), 'export done shows output path');
    await key('Escape', { code: 'Escape' }); await sleep(300);

    // keyboard help
    await key('?', { code: 'Slash', shift: true }); await sleep(300);
    await shot('12-shortcuts');
    await key('Escape', { code: 'Escape' }); await sleep(200);

    // caption selected
    const capId = await evaluate(`Object.values(FrameStudio.state.project.clips).find(c=>c.type==='caption')?.id`);
    if (capId) { await evaluate(`FrameStudio.state.set({ selection: new Set(['${capId}']), playhead: 3.4 })`); await sleep(500); await shot('13-caption'); }
    // audio selected
    await evaluate(`FrameStudio.state.set({ selection: new Set(['c_music']) })`); await sleep(400);
    await shot('14-audio');
  }
  if (which === 'all' || which === 'tabs') {
    console.log('# inspector tabs');
    await nav(`${BASE}/?project=${PROJECT}`, 3500);
    const tab = async (clip, t, label, name, prep) => {
      await evaluate(`FrameStudio.state.set({ selection: new Set(['${clip}']), playhead: ${t} })`); await sleep(400);
      await evaluate(`[...document.querySelectorAll('#inspector .tab')].find(x=>x.textContent.includes('${label}'))?.click()`); await sleep(350);
      if (prep) { await evaluate(prep); await sleep(500); }
      await shot(name);
    };
    await tab('c_title', 1, 'טקסט', '20-text-presets', `document.querySelector('#inspector .insp-body').scrollTop = 160`);
    check(await evaluate(`document.querySelectorAll('#inspector .preset').length > 10`), 'text presets rendered');
    await tab('c_title', 1, 'אנימציה', '21-anim');
    check(await evaluate(`document.querySelectorAll('#inspector .chip').length > 20`), 'animation chips rendered');
    await evaluate(`[...document.querySelectorAll('#inspector .chip')].find(x=>x.textContent.trim()==='${'הקפצה'}' || x.title==='pop')?.click()`);
    await tab('c_img', 2, 'צבע', '22-color-filters');
    check(await evaluate(`document.querySelectorAll('#inspector .chip').length > 10`), 'filter chips rendered');
    // pick a filter chip → op applied
    await evaluate(`[...document.querySelectorAll('#inspector .chip')][3]?.click()`); await sleep(500);
    check(await evaluate(`FrameStudio.state.project.clips.c_img.filter.id !== 'none'`), 'filter applied from chip');
    await tab('c_img', 2, 'אפקטים', '23-effects', `document.querySelector('#inspector .add-fx .btn')?.click()`);
    check(await evaluate(`(FrameStudio.state.project.clips.c_img.effects||[]).length === 1`), 'effect added');
    await sleep(300); await shot('23-effects');
    const openAdv = `(()=>{ const adv=[...document.querySelectorAll('#inspector .sec')].find(s=>s.querySelector('.sec-title')?.textContent==='מתקדם'); if(adv?.classList.contains('closed')) adv.querySelector('.sec-head').click(); return adv; })()`;
    await tab('c_img', 2, 'צבע', '24-mask', `(()=>{ const adv=${openAdv}; const hd=[...adv.querySelectorAll('.sub-head')].find(x=>x.textContent.includes('מסכה')); hd.nextElementSibling.querySelectorAll('.chip')[2].click(); })()`);
    await sleep(300); await shot('24-mask');
    check(await evaluate(`FrameStudio.state.project.clips.c_img.mask?.type`) === 'ellipse', 'mask picked from צבע ופילטר → מתקדם');
    await tab('c_img', 2, 'צבע', '25-chroma', `(()=>{ ${openAdv}; document.querySelector('#inspector .insp-body').scrollTop = 9999; })()`);
    check(await evaluate(`[...document.querySelectorAll('#inspector .sub-head')].some(x=>x.textContent.includes('מפתח כרום'))`), 'chroma key in advanced section');
    await tab('c_vid', 2, 'עריכה', '26-speed', `document.querySelector('#inspector .insp-body').scrollTop = 260`);
    check(await evaluate(`[...document.querySelectorAll('#inspector .sec-title')].some(x=>x.textContent==='מהירות')`), 'speed section in עריכה');
    await tab('c_vid', 2, 'עריכה', '27-video-audio', `document.querySelector('#inspector .insp-body').scrollTop = 9999`);
    check(await evaluate(`document.querySelectorAll('#inspector .tab').length <= 4`), 'at most 4 inspector tabs');
    await tab('c_shape', 3, 'צורה', '28-shape');
    await tab('c_sticker', 2, 'מדבקה', '29-sticker');
    const capId = await evaluate(`Object.values(FrameStudio.state.project.clips).find(c=>c.type==='caption')?.id`);
    await tab(capId, 3.4, 'כתוביות', '30-caption-styles');
    check(await evaluate(`document.querySelectorAll('#inspector .chips.wide .chip').length > 5`), 'caption style chips rendered');
    await evaluate(`document.querySelectorAll('#inspector .chips.wide .chip')[1]?.click()`); await sleep(500);
    check(await evaluate(`FrameStudio.state.project.clips['${capId}'].caption.style`) !== undefined, 'caption style applied');
    // multi-select
    await evaluate(`FrameStudio.state.set({ selection: new Set(['c_title','c_shape','c_sticker']), playhead: 2.2 })`); await sleep(500);
    await shot('31-multi');
    await evaluate(`FrameStudio.state.set({ selection: new Set(['c_vid']), playhead: 2 })`); await sleep(400);
    await evaluate(`[...document.querySelectorAll('#inspector .tab')].find(x=>x.textContent.includes('אנימציה'))?.click()`); await sleep(400);
    await evaluate(`document.querySelector('#inspector .insp-body').scrollTop = 9999`); await sleep(200);
    await shot('32-transition');
  }

  if (which === 'all' || which === 'extra') {
    console.log('# extra interactions');
    await nav(`${BASE}/?project=${PROJECT}`, 3500);
    // rename project in the top bar
    await evaluate(`(()=>{ const n=document.querySelector('#projName'); n.focus(); n.value='שם חדש לבדיקה'; n.dispatchEvent(new Event('change',{bubbles:true})); n.blur(); })()`); await sleep(500);
    check(await evaluate(`FrameStudio.state.project.name`) === 'שם חדש לבדיקה', 'rename project via top bar (renameProject op)');
    // double-click text → inline editor → commit
    await evaluate(`FrameStudio.state.set({ selection: new Set(), playhead: 1 })`); await sleep(500);
    const tb = await evaluate(`(()=>{ const bb = FrameStudio.viewer.getClipBounds('c_title'); const fr = document.querySelector('.vw-frame').getBoundingClientRect(); const k = fr.width/1080; return bb && { x: fr.left + bb.cx*k, y: fr.top + bb.cy*k }; })()`);
    if (tb) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tb.x, y: tb.y, button: 'left', buttons: 1, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tb.x, y: tb.y, button: 'left', buttons: 0, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tb.x, y: tb.y, button: 'left', buttons: 1, clickCount: 2 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tb.x, y: tb.y, button: 'left', buttons: 0, clickCount: 2 });
      await sleep(400);
      check(await evaluate(`!!document.querySelector('.vw-text-edit')`), 'double-click opens inline text editor');
      await shot('40-inline-text');
      await evaluate(`(()=>{ const ta=document.querySelector('.vw-text-edit'); ta.value='טקסט ערוך בנגן'; ta.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true})); })()`); await sleep(500);
      check(await evaluate(`FrameStudio.state.project.clips.c_title.text.content`) === 'טקסט ערוך בנגן', 'inline edit committed');
    } else check(false, 'title bounds');
    // copy / paste / duplicate
    await evaluate(`FrameStudio.state.set({ selection: new Set(['c_sticker']), playhead: 5 })`); await sleep(200);
    const nBefore = await evaluate(`Object.keys(FrameStudio.state.project.clips).length`);
    await key('c', { code: 'KeyC', ctrl: true }); await sleep(100);
    await key('v', { code: 'KeyV', ctrl: true }); await sleep(600);
    check(await evaluate(`Object.keys(FrameStudio.state.project.clips).length`) === nBefore + 1, 'Ctrl+C / Ctrl+V pastes clip at playhead');
    const pastedStart = await evaluate(`FrameStudio.state.project.clips[[...FrameStudio.state.selection][0]]?.start`);
    check(Math.abs(pastedStart - 5) < 0.05, `pasted clip selected at playhead (${pastedStart})`);
    await key('d', { code: 'KeyD', ctrl: true }); await sleep(600);
    check(await evaluate(`Object.keys(FrameStudio.state.project.clips).length`) === nBefore + 2, 'Ctrl+D duplicates');
    await key('Delete', { code: 'Delete' }); await sleep(600);
    check(await evaluate(`Object.keys(FrameStudio.state.project.clips).length`) === nBefore + 1, 'Delete removes selected');
    // marker + in/out
    const mk = await evaluate(`FrameStudio.state.project.markers.length`);
    await key('m', { code: 'KeyM' }); await sleep(500);
    check(await evaluate(`FrameStudio.state.project.markers.length`) === mk + 1, 'M adds marker');
    await key('i', { code: 'KeyI' }); await evaluate(`FrameStudio.state.set({ playhead: 6.5 })`); await key('o', { code: 'KeyO' }); await sleep(200);
    check(await evaluate(`JSON.stringify(FrameStudio.state.range)`) === JSON.stringify({ in: 5, out: 6.5 }), 'I / O set range');
    // zoom / tools / snapping
    const z = await evaluate(`FrameStudio.state.zoom`);
    await key('=', { code: 'Equal' }); await sleep(100);
    check(await evaluate(`FrameStudio.state.zoom`) > z, '+ zooms timeline');
    await key('b', { code: 'KeyB' }); check(await evaluate(`FrameStudio.state.tool`) === 'blade', 'B blade tool');
    await key('v', { code: 'KeyV' }); check(await evaluate(`FrameStudio.state.tool`) === 'select', 'V select tool');
    const sn = await evaluate(`FrameStudio.state.snapping`); await key('n', { code: 'KeyN' });
    check(await evaluate(`FrameStudio.state.snapping`) === !sn, 'N toggles snapping');
    // frame step / home / end
    await evaluate(`FrameStudio.state.set({ playhead: 2 })`);
    await key('ArrowRight', { code: 'ArrowRight' }); await sleep(100);
    check(Math.abs(await evaluate(`FrameStudio.state.playhead`) - (2 + 1 / 30)) < 1e-6, '→ steps one frame');
    await key('ArrowLeft', { code: 'ArrowLeft', shift: true }); await sleep(100);
    check(Math.abs(await evaluate(`FrameStudio.state.playhead`) - (1 + 1 / 30)) < 1e-3, 'Shift+← steps one second');
    await key('End', { code: 'End' }); await sleep(100);
    check(await evaluate(`FrameStudio.state.playhead === FrameStudio.state.duration`), 'End jumps to end');
    await key('Home', { code: 'Home' }); await sleep(100);
    check(await evaluate(`FrameStudio.state.playhead`) === 0, 'Home jumps to start');
    // shuttle L L → 2x then K
    await evaluate(`FrameStudio.state.set({ playhead: 0.5 })`);
    await key('l', { code: 'KeyL' }); await key('l', { code: 'KeyL' }); await sleep(600);
    const p2 = await evaluate(`FrameStudio.state.playhead`);
    await key('k', { code: 'KeyK' }); await sleep(150);
    check(p2 > 1.3 && (await evaluate(`FrameStudio.state.playing`)) === false, `L L shuttles at 2× (playhead ${p2?.toFixed?.(2)}) and K stops`);
    // meters while playing
    await evaluate(`FrameStudio.state.set({ playhead: 1 })`);
    await key(' ', { code: 'Space' }); await sleep(900);
    const meter = await evaluate(`document.querySelector('.meter-db').textContent`);
    await shot('41-playing-meters');
    await key(' ', { code: 'Space' }); await sleep(200);
    check(meter !== '-∞', `audio meters show level while playing (${meter} dBFS)`);
    // drop a library media item onto the viewer
    const before2 = await evaluate(`Object.keys(FrameStudio.state.project.clips).length`);
    await evaluate(`(()=>{ const st=document.querySelector('.vw-stage'); const dt=new DataTransfer(); dt.setData('application/x-frame-studio', JSON.stringify({kind:'media', mediaId: Object.values(FrameStudio.state.project.media).find(m=>m.kind==='image').id, mediaKind:'image'})); const r=st.getBoundingClientRect(); const o={dataTransfer:dt,bubbles:true,cancelable:true,clientX:r.left+20,clientY:r.top+20}; st.dispatchEvent(new DragEvent('dragover',o)); st.dispatchEvent(new DragEvent('drop',o)); })()`);
    await sleep(700);
    check(await evaluate(`Object.keys(FrameStudio.state.project.clips).length`) === before2 + 1, 'library media dropped on viewer adds clip at playhead');
    // track toggles in project settings
    await evaluate(`FrameStudio.state.set({ selection: new Set() })`); await sleep(400);
    await evaluate(`[...document.querySelectorAll('#inspector .trk')].find(r=>r.querySelector('.trk-name').value==='מוזיקה')?.querySelectorAll('.btn-icon')[0].click()`); await sleep(500);
    check(await evaluate(`FrameStudio.state.project.tracks.find(t=>t.role==='music').muted`) === true, 'track mute toggle in project settings');
    // thirds + safe-area menu
    await evaluate(`document.querySelector('.transport [title="רשת שלישים"]').click()`); await sleep(200);
    check(await evaluate(`document.querySelectorAll('.vw-overlay .thirds').length`) === 4, 'rule-of-thirds overlay');
    await evaluate(`document.querySelector('.transport [title="אזור בטוח לרשתות"]').click()`); await sleep(200);
    await shot('42-safe-menu');
    await evaluate(`[...document.querySelectorAll('.menu-item')].find(b=>b.textContent.includes('טיקטוק'))?.click()`); await sleep(500);
    check(await evaluate(`FrameStudio.state.project.settings.safeArea`) === 'tiktok', 'safe-area menu sets project setting');
    // slider live preview (previewOps) + commit on change
    await evaluate(`FrameStudio.state.set({ selection: new Set(['c_shape']), playhead: 3 })`); await sleep(400);
    await evaluate(`[...document.querySelectorAll('#inspector .tab')].find(x=>x.textContent.includes('עריכה'))?.click()`); await sleep(300);
    const rev0 = await evaluate(`FrameStudio.state.project.rev`);
    await evaluate(`(()=>{ const r=[...document.querySelectorAll('#inspector .row')].find(x=>x.querySelector('.lbl')?.textContent==='שקיפות'); const s=r.querySelector('input.slider'); s.value='40'; s.dispatchEvent(new Event('input',{bubbles:true})); })()`); await sleep(200);
    const pv = await evaluate(`FrameStudio.state.project.clips.c_shape.transform.opacity`);
    check(Math.abs(pv - 0.4) < 1e-6 && (await evaluate(`FrameStudio.state.project.rev`)) === rev0, 'slider input previews locally without a server commit');
    await evaluate(`(()=>{ const r=[...document.querySelectorAll('#inspector .row')].find(x=>x.querySelector('.lbl')?.textContent==='שקיפות'); const s=r.querySelector('input.slider'); s.dispatchEvent(new Event('change',{bubbles:true})); })()`); await sleep(500);
    check((await evaluate(`FrameStudio.state.project.rev`)) > rev0, 'slider change commits once');
    await shot('43-final');
  }

  if (which === 'inapp') {
    console.log('# in-app export (headless:false → runJobInPage)');
    await nav(`${BASE}/?project=${PROJECT}`, 3500);
    await evaluate(`document.querySelector('#btnExport').click()`); await sleep(400);
    await evaluate(`[...document.querySelectorAll('.modal .seg button')].find(b=>b.textContent.includes('בתוך העורך')).click()`);
    await evaluate(`[...document.querySelectorAll('.modal .seg button')].find(b=>b.textContent.includes('מותאם')).click()`);
    await evaluate(`(()=>{ const ins=document.querySelectorAll('.modal .ex-range .input'); ins[0].value='0'; ins[1].value='1.5'; ins[1].dispatchEvent(new Event('input')); })()`);
    await evaluate(`[...document.querySelectorAll('.modal .seg button')].find(b=>b.textContent.includes('טיוטה')).click()`);
    await shot('50-inapp-settings');
    await evaluate(`document.querySelector('.modal [data-action], .modal .btn-primary')?.click()`); await sleep(1500);
    await shot('51-inapp-progress');
    for (let w = 0; w < EXPORT_WAIT; w += 500) { if (await evaluate(`!!document.querySelector('.modal .ex-out, .modal .ex-err')`)) break; await sleep(500); }
    await shot('52-inapp-done');
    const err = await evaluate(`document.querySelector('.modal .ex-err')?.textContent || ''`);
    if (err) console.log('  export error:', err);
    check(await evaluate(`!!document.querySelector('.modal .ex-out .path')`), 'in-app export finished with output path');
  }

  console.log('\n# console errors / exceptions');
  const uniq = [...new Set(errors)];
  if (!uniq.length) console.log('  (none)');
  for (const e of uniq) console.log('  ' + e);
  if (process.env.SHOWLOGS) for (const l of logs) console.log('  ' + l);
  console.log(`\n# ${failures.length ? `${failures.length} FAILED: ${failures.join(' | ')}` : 'all checks passed'}`);
}
function FrameStudioX(x) { return x; }

main().catch((e) => { console.error('driver error:', e); process.exitCode = 1; }).finally(async () => {
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill();
  await sleep(300);
  // failed checks must fail the run (exit 1), not only print "# N FAILED"
  if (failures.length) process.exitCode = 1;
  process.exit();
});
