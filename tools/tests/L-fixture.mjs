// Agent L test fixture: a realistic project (~22 clips, 7 tracks) for the timeline / library tests.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as MODEL from '../../shared/model.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ASSETS = path.join(HERE, 'L-assets');

export function makeFixture() {
  const p = MODEL.newProject({ id: 'fx-demo', name: 'סרטון בדיקה — ציר זמן', width: 1080, height: 1920, fps: 30 });
  const capTrack = MODEL.newTrack('video', { id: 't_caps', role: 'text', name: 'כתוביות' });
  const fxTrack = MODEL.newTrack('video', { id: 't_fx', role: 'effects', name: 'אפקטים' });
  p.tracks = [fxTrack, capTrack, ...p.tracks];
  const A = (f) => path.join(ASSETS, f);
  p.media = {
    m_v1: { id: 'm_v1', kind: 'video', name: 'צילום-אתר.mp4', path: A('v_demo.mp4'), duration: 16, width: 640, height: 360, fps: 30, hasVideo: true, hasAudio: true, channels: 2, sampleRate: 48000, size: 1749647, status: 'ready' },
    m_v2: { id: 'm_v2', kind: 'video', name: 'אנימציה-מנדלברוט.mp4', path: A('v_demo2.mp4'), duration: 12, width: 640, height: 360, fps: 30, hasVideo: true, hasAudio: false, size: 2747263, status: 'ready' },
    m_img: { id: 'm_img', kind: 'image', name: 'רקע-מותג.png', path: A('i_photo.png'), duration: 0, width: 1080, height: 1350, hasVideo: true, hasAudio: false, status: 'ready' },
    m_vo: { id: 'm_vo', kind: 'audio', name: 'קריינות-מנוקדת-05.wav', path: A('a_voice.wav'), duration: 14, hasVideo: false, hasAudio: true, channels: 2, sampleRate: 48000, status: 'ready' },
    m_mus: { id: 'm_mus', kind: 'audio', name: 'שיר-מתח-3.wav', path: A('a_music.wav'), duration: 20, hasVideo: false, hasAudio: true, channels: 2, sampleRate: 48000, status: 'ready' },
    m_proc: { id: 'm_proc', kind: 'video', name: 'ייבוא-חדש.mov', path: A('v_demo.mp4'), duration: 9.5, width: 1080, height: 1920, fps: 30, hasVideo: true, hasAudio: true, status: 'processing' },
  };
  const add = (type, props) => {
    const c = MODEL.newClip(type, props);
    p.clips[c.id] = c;
    return c;
  };
  // main track
  add('video', { id: 'c_v1', trackId: 't_main', mediaId: 'm_v1', start: 0, duration: 4, in: 0, name: 'פתיחה — האתר', transitionOut: { id: 'crossfade', duration: 0.6, params: {} } });
  add('video', { id: 'c_v2', trackId: 't_main', mediaId: 'm_v2', start: 4, duration: 3.5, in: 2, keyframes: { 'transform.scale': [{ t: 0, v: 1, ease: 'linear' }, { t: 1.2, v: 1.25, ease: 'easeInOut' }, { t: 3, v: 1.1, ease: 'spring' }] } });
  add('video', { id: 'c_v3', trackId: 't_main', mediaId: 'm_v1', start: 7.5, duration: 4.5, in: 6, muteAudio: true, transitionOut: { id: 'zoomBlur', duration: 0.4, params: {} } });
  add('video', { id: 'c_v4', trackId: 't_main', mediaId: 'm_v2', start: 12, duration: 3, in: 0, speed: 2 });
  // overlay
  add('image', { id: 'c_img', trackId: 't_overlay', mediaId: 'm_img', start: 2.5, duration: 3, animIn: { id: 'pop', duration: 0.4 } });
  add('sticker', { id: 'c_st', trackId: 't_overlay', start: 9, duration: 2, sticker: { kind: 'emoji', value: '🔥', size: 220 } });
  add('shape', { id: 'c_sh', trackId: 't_overlay', start: 12.2, duration: 2.2, shape: { kind: 'arrow', w: 400, h: 120, fill: '#13b6e4' } });
  // text
  add('text', { id: 'c_t1', trackId: 't_text', start: 0, duration: 1.6, text: { content: 'רגע!', color: '#ffffff', weight: 900 } });
  add('text', { id: 'c_t2', trackId: 't_text', start: 6, duration: 3, text: { content: 'ככה זה נשמע', color: '#3fe0f5', weight: 800 }, keyframes: { 'transform.y': [{ t: 0, v: 200 }, { t: 0.5, v: 0, ease: 'back' }] } });
  add('text', { id: 'c_t3', trackId: 't_text', start: 13, duration: 2, text: { content: 'Chordix', color: '#ff8a66', weight: 900 } });
  // captions
  const words = [['תשמעו', 0.6, 1.0], ['את', 1.0, 1.2], ['זה', 1.2, 1.6], ['רגע', 1.9, 2.3], ['אחד', 2.3, 2.7], ['האתר', 3.1, 3.6], ['מנגן', 3.6, 4.1], ['לבד', 4.1, 4.6], ['ובום!', 5.0, 5.6], ['זה', 6.0, 6.3], ['עובד', 6.3, 6.9]];
  const chunks = [[0, 3], [3, 5], [5, 9], [9, 11]];
  chunks.forEach(([a, b], i) => {
    const ws = words.slice(a, b).map(([w, s, e]) => ({ w, s, e, hot: w === 'ובום!' }));
    const start = ws[0].s;
    const end = i < chunks.length - 1 ? words[b][1] : ws[ws.length - 1].e + 0.4;
    add('caption', { id: `c_cap${i}`, trackId: 't_caps', start, duration: Math.round((end - start) * 1000) / 1000, caption: { words: ws, style: 'chordix', activeColor: '#3fe0f5', hotColor: '#ff8a66' } });
  });
  // effects
  add('effect', { id: 'c_fx1', trackId: 't_fx', start: 5, duration: 1, effects: [{ id: 'zoomPunch', params: {}, enabled: true }], name: 'zoomPunch' });
  add('adjustment', { id: 'c_adj', trackId: 't_fx', start: 9.5, duration: 3, filter: { id: 'cinematic', amount: 1 } });
  // audio
  add('audio', { id: 'c_vo', trackId: 't_voice', mediaId: 'm_vo', start: 0.5, duration: 12, in: 0, fadeOut: 0.5, name: 'קריינות' });
  add('audio', { id: 'c_mus', trackId: 't_music', mediaId: 'm_mus', start: 0, duration: 15, in: 1, fadeIn: 1, fadeOut: 2, volume: 0.4 });
  add('audio', { id: 'c_s1', trackId: 't_sfx', mediaId: 'm_vo', start: 0, duration: 1.2, in: 3, name: 'בום פתיחה', volume: 0.4 });
  add('audio', { id: 'c_s2', trackId: 't_sfx', mediaId: 'm_vo', start: 3.8, duration: 0.8, in: 5, name: 'ווש', volume: 0.25 });
  add('audio', { id: 'c_s3', trackId: 't_sfx', mediaId: 'm_mus', start: 9, duration: 2.5, in: 0, name: 'עולה לפני דרופ', volume: 0.2, fadeIn: 1.5 });
  add('audio', { id: 'c_s4', trackId: 't_sfx', mediaId: 'm_vo', start: 12, duration: 0.6, in: 8, name: 'קליק', volume: 0.3 });
  p.markers = [
    { id: 'mk_hook', t: 0.6, label: 'הוק', color: '#f5c518' },
    { id: 'mk_drop', t: 5.0, label: 'דרופ', color: '#ff8a66' },
    { id: 'mk_end', t: 13, label: 'כרטיס סיום', color: '#3fe0f5' },
  ];
  p.transcript = { words: words.map(([w, s, e]) => ({ w, s, e })) };
  p.rev = 1;
  return p;
}
