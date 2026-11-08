// Frame Studio — app/ui-claude.js (owner: U)
// Everything the editor says about Claude, kept honest:
//  • the top-bar indicator: "קלוד מחובר" only when Claude really used this server recently (GET /api/claude/status
//    → connected, or a Claude edit arrived over the live link); "מוכן לקלוד" when Claude Desktop / Claude Code is set
//    up but has not been asked yet; "קלוד לא מחובר — איך מחברים?" when nothing is set up. A lost link to the local
//    server is its own state ("אין חיבור לשרת").
//  • openClaudeHelp(): what to write to Claude, and how to connect it when it is not connected.
//  • claudeCard(): the small "עובדים עם Claude?" card on the project manager.
import { api, state, on, onEvent } from './api.js';
import { h, modal, toast } from './ui-kit.js';
import { icon } from './ui-icons.js';

const RECENT_MS = 15 * 60_000;           // a Claude edit / request within this window = "connected"
const POLL_MS = 20_000;
const GUIDE_URL = 'https://github.com/YonatanProX/frame-studio#התקנה-בשלושה-צעדים';
const DOWNLOAD_URL = 'https://claude.ai/download';
export const EXAMPLE_ASK = 'פתח את Frame Studio ותערוך לי סרטון קצר מהקבצים בתיקייה…';

let status = null;           // last GET /api/claude/status (null = unknown)
let lastEditAt = 0;          // last Claude edit seen over the live link (this window)
let pollTimer = null;
const listeners = new Set();
const emit = () => { for (const fn of [...listeners]) { try { fn(); } catch { /* ignore */ } } };

export async function refreshClaudeStatus() {
  try { status = await api.get('/api/claude/status'); } catch { status = status || null; }
  emit();
  return status;
}

function startPolling() {
  if (pollTimer) return;
  refreshClaudeStatus();
  pollTimer = setInterval(() => { if (document.visibilityState !== 'hidden') refreshClaudeStatus(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshClaudeStatus(); });
}

/** "connected" | "ready" | "setup" | "unknown" */
export function claudeState() {
  if (lastEditAt && Date.now() - lastEditAt < RECENT_MS) return 'connected';
  if (!status) return 'unknown';
  return status.state || (status.connected ? 'connected' : status.ready ? 'ready' : 'setup');
}

/** The top-bar indicator (#claudeInd). Call once. */
export function mountClaudeIndicator(ind) {
  const label = ind.querySelector('.txt');
  ind.setAttribute('role', 'button');
  ind.tabIndex = 0;
  let editing = null; let editTimer = null; let lastSummary = '';
  const paint = () => {
    const server = !!state.connected;
    const st = claudeState();
    ind.classList.remove('on', 'off', 'ready', 'setup');
    if (editing) {
      ind.classList.add('on');
      label.textContent = 'קלוד עורך…';
      ind.title = editing;
      return;
    }
    if (!server) {
      ind.classList.add('off');
      label.textContent = state.projectId ? 'אין חיבור לשרת' : 'מתחבר…';
      ind.title = 'החיבור לשרת Frame Studio במחשב נותק — מנסה להתחבר מחדש…';
      return;
    }
    if (st === 'connected') {
      ind.classList.add('on');
      label.textContent = 'קלוד מחובר';
      ind.title = `Claude עבד כאן לאחרונה — השינויים שלו מופיעים בזמן אמת${lastSummary ? `\nעריכה אחרונה: ${lastSummary}` : ''}\nלחיצה — מה אפשר לבקש`;
    } else if (st === 'ready') {
      ind.classList.add('ready');
      label.textContent = 'מוכן לקלוד';
      ind.title = 'Claude יכול לערוך כאן ברגע שתבקשו ממנו.\nלחיצה — מה כותבים לו';
    } else if (st === 'setup') {
      ind.classList.add('setup');
      label.textContent = 'קלוד לא מחובר — איך מחברים?';
      ind.title = 'Claude עוד לא מחובר ל-Frame Studio במחשב הזה. לחיצה — איך מחברים';
    } else {
      ind.classList.add('ready');
      label.textContent = 'מוכן';
      ind.title = 'העורך מחובר. לחיצה — איך עובדים עם Claude';
    }
  };
  const openHelp = () => openClaudeHelp();
  ind.addEventListener('click', openHelp);
  ind.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHelp(); } });
  listeners.add(paint);
  on('connected', () => { paint(); if (state.connected) refreshClaudeStatus(); });
  onEvent('claude', (ev) => {
    lastEditAt = Date.now();
    lastSummary = String(ev.summary || '').split('\n')[0];
    editing = lastSummary ? `Claude עורך עכשיו: ${lastSummary}` : 'Claude עורך עכשיו';
    clearTimeout(editTimer);
    editTimer = setTimeout(() => { editing = null; paint(); }, 3000);
    paint();
  });
  startPolling();
  paint();
  return { paint };
}

function stepList(items) {
  return h('ol.claude-steps', items.map((x) => h('li', typeof x === 'string' ? x : x)));
}

function exampleBox(text) {
  const box = h('div.claude-example', h('span.q', text));
  const copy = h('button.btn.btn-ghost.btn-sm', { type: 'button', title: 'העתקה', html: `${icon('copy', 14)}<span>העתקה</span>` });
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); toast('הועתק — הדביקו ב-Claude', { type: 'success', timeout: 1800 }); } catch { /* ignore */ }
  });
  box.appendChild(copy);
  return box;
}

async function openLink(url) {
  try { await api.post('/api/open-url', { url }); toast('נפתח בדפדפן', { timeout: 1800 }); }
  catch { const w = window.open(url, '_blank', 'noopener'); if (!w) toast(`פתחו בדפדפן: ${url}`, { type: 'warn' }); }
}

/** "How do I use Claude here?" — adapts to whether Claude is connected / set up. */
export async function openClaudeHelp() {
  const st0 = status ? claudeState() : (await refreshClaudeStatus(), claudeState());
  const s = status || {};
  const body = [];
  if (st0 === 'setup') {
    const broken = s.desktop && s.desktop.broken;
    body.push(h('p.modal-text', broken
      ? 'Claude Desktop מוגדר, אבל ההגדרה של Frame Studio בו מצביעה על תיקייה שכבר לא קיימת. ההתקנה של Frame Studio מתקנת את זה.'
      : 'Claude עוד לא מחובר ל-Frame Studio במחשב הזה. ככה מחברים (פעם אחת):'));
    body.push(stepList([
      'התקינו את Claude Desktop והתחברו עם החשבון שלכם (מנוי Pro מספיק).',
      'הריצו שוב את ההתקנה של Frame Studio (לחיצה כפולה על install.cmd) — היא מחברת את Frame Studio ל-Claude לבד.',
      'סגרו את Claude Desktop לגמרי (בסמל שליד השעון ← Quit) ופתחו אותו מחדש.',
      'כתבו ל-Claude, למשל:',
    ]));
    body.push(exampleBox(EXAMPLE_ASK));
    body.push(h('div.hint', 'החיבור מתעדכן כאן לבד ברגע ש-Claude מתחיל לעבוד.'));
  } else {
    body.push(h('p.modal-text', st0 === 'connected'
      ? 'Claude מחובר ועובד על הפרויקטים שלכם. כל שינוי שלו מופיע כאן מיד, ואפשר להמשיך לערוך ידנית באותו זמן.'
      : 'Frame Studio מחובר ל-Claude. פתחו את Claude Desktop וכתבו לו מה לעשות — העריכה תופיע כאן בזמן אמת.'));
    body.push(h('div.sub-title', 'מה כותבים ל-Claude? למשל:'));
    body.push(exampleBox(EXAMPLE_ASK));
    body.push(h('ul.claude-ideas',
      h('li', '"תוסיף כתוביות בסגנון מילים קופצות"'),
      h('li', '"תשים ווש בכל מעבר ובום בסוף"'),
      h('li', '"תקצר את הסרטון ל-30 שניות ותייצא"'),
    ));
    body.push(h('div.hint', 'Undo (Ctrl+Z) מבטל גם עריכות של Claude.'));
  }
  const actions = [
    { label: 'סגירה', primary: st0 !== 'setup' },
    { label: 'המדריך המלא', ghost: true, icon: 'info', keepOpen: true, onClick: () => { openLink(GUIDE_URL); return false; } },
  ];
  if (st0 === 'setup') actions.splice(1, 0, { label: 'הורדת Claude Desktop', primary: true, keepOpen: true, onClick: () => { openLink(DOWNLOAD_URL); return false; } });
  return modal({ title: st0 === 'setup' ? 'חיבור ל-Claude' : 'עבודה עם Claude', width: 500, body, actions });
}

/** Small card for the project manager: how to ask Claude. */
export function claudeCard() {
  const more = h('button.btn-link', { type: 'button' }, 'איך מחברים?');
  more.addEventListener('click', () => openClaudeHelp());
  const card = h('div.pm-claude',
    h('span.pm-claude-ic', { html: icon('sparkle', 18) }),
    h('div.pm-claude-txt',
      h('b', 'עובדים עם Claude?'),
      h('span', 'פתחו את Claude Desktop וכתבו: ', h('q', 'פתח את Frame Studio ותערוך לי…'), ' — העריכה תופיע כאן בזמן אמת. '),
      more),
  );
  const paint = () => {
    const st = claudeState();
    more.textContent = st === 'setup' ? 'Claude לא מחובר — איך מחברים?' : 'מה עוד אפשר לבקש?';
    card.classList.toggle('setup', st === 'setup');
  };
  listeners.add(paint);
  if (!status) refreshClaudeStatus(); else paint();
  paint();
  return card;
}
