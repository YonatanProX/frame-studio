// Frame Studio — app/ui-icons.js (owner: U)
// Hand-drawn inline SVG icon set (24×24 grid, stroke = currentColor). No icon fonts, no network.
// icon(name, size=16, cls='') → SVG markup string ; hydrateIcons(root) fills every [data-icon] element.

const S = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const F = 'fill="currentColor" stroke="none"';

export const ICONS = {
  logo: `<rect x="2.5" y="4" width="19" height="16" rx="3.5" fill="#13b6e4" stroke="none"/>
    <rect x="4.6" y="6" width="1.8" height="1.8" rx=".5" fill="#0b0e13" stroke="none"/><rect x="4.6" y="11.1" width="1.8" height="1.8" rx=".5" fill="#0b0e13" stroke="none"/><rect x="4.6" y="16.2" width="1.8" height="1.8" rx=".5" fill="#0b0e13" stroke="none"/>
    <rect x="17.6" y="6" width="1.8" height="1.8" rx=".5" fill="#0b0e13" stroke="none"/><rect x="17.6" y="11.1" width="1.8" height="1.8" rx=".5" fill="#0b0e13" stroke="none"/><rect x="17.6" y="16.2" width="1.8" height="1.8" rx=".5" fill="#0b0e13" stroke="none"/>
    <path d="M10.2 8.6v6.8l5.4-3.4z" fill="#0b0e13" stroke="none"/>`,
  play: `<path d="M7.5 5.2v13.6c0 .8.9 1.3 1.6.9l10.6-6.8c.6-.4.6-1.3 0-1.7L9.1 4.3c-.7-.4-1.6.1-1.6.9z" ${F}/>`,
  pause: `<rect x="6" y="4.8" width="4.2" height="14.4" rx="1.2" ${F}/><rect x="13.8" y="4.8" width="4.2" height="14.4" rx="1.2" ${F}/>`,
  stop: `<rect x="6" y="6" width="12" height="12" rx="2" ${F}/>`,
  stepBack: `<path d="M6 5.5v13" ${S}/><path d="M18.5 6.4v11.2c0 .6-.7 1-1.2.6l-8.1-5.6a.75.75 0 010-1.2l8.1-5.6c.5-.4 1.2 0 1.2.6z" ${F}/>`,
  stepFwd: `<path d="M18 5.5v13" ${S}/><path d="M5.5 6.4v11.2c0 .6.7 1 1.2.6l8.1-5.6a.75.75 0 000-1.2L6.7 5.8c-.5-.4-1.2 0-1.2.6z" ${F}/>`,
  toStart: `<path d="M4.5 5v14" ${S}/><path d="M12 7v10l-6.5-5z" ${F}/><path d="M19.5 7v10L13 12z" ${F}/>`,
  toEnd: `<path d="M19.5 5v14" ${S}/><path d="M12 7v10l6.5-5z" ${F}/><path d="M4.5 7v10L11 12z" ${F}/>`,
  loop: `<path d="M17 2.8l3 3-3 3" ${S}/><path d="M4 11.5v-1.2a4.5 4.5 0 014.5-4.5H20" ${S}/><path d="M7 21.2l-3-3 3-3" ${S}/><path d="M20 12.5v1.2a4.5 4.5 0 01-4.5 4.5H4" ${S}/>`,
  undo: `<path d="M9 14.5L4 9.5l5-5" ${S}/><path d="M4 9.5h10.5a5.5 5.5 0 010 11H11" ${S}/>`,
  redo: `<path d="M15 14.5l5-5-5-5" ${S}/><path d="M20 9.5H9.5a5.5 5.5 0 000 11H13" ${S}/>`,
  export: `<path d="M12 15.5V3.5" ${S}/><path d="M7.5 8L12 3.5 16.5 8" ${S}/><path d="M4 14.5v4A2.5 2.5 0 006.5 21h11a2.5 2.5 0 002.5-2.5v-4" ${S}/>`,
  fullscreen: `<path d="M4 9V5.5A1.5 1.5 0 015.5 4H9M15 4h3.5A1.5 1.5 0 0120 5.5V9M20 15v3.5a1.5 1.5 0 01-1.5 1.5H15M9 20H5.5A1.5 1.5 0 014 18.5V15" ${S}/>`,
  grid: `<rect x="3.5" y="3.5" width="17" height="17" rx="2" ${S}/><path d="M9.2 3.5v17M14.8 3.5v17M3.5 9.2h17M3.5 14.8h17" ${S} stroke-width="1.3"/>`,
  safe: `<rect x="3" y="3" width="18" height="18" rx="2.5" ${S}/><rect x="7" y="6.5" width="10" height="11" rx="1.2" ${S} stroke-dasharray="2.2 2"/>`,
  close: `<path d="M6 6l12 12M18 6L6 18" ${S}/>`,
  plus: `<path d="M12 5v14M5 12h14" ${S}/>`,
  minus: `<path d="M5 12h14" ${S}/>`,
  trash: `<path d="M4 7h16" ${S}/><path d="M9.5 7V4.8c0-.4.4-.8.8-.8h3.4c.4 0 .8.4.8.8V7" ${S}/><path d="M6.5 7l.9 12.3a1.8 1.8 0 001.8 1.7h5.6a1.8 1.8 0 001.8-1.7L17.5 7" ${S}/><path d="M10.2 11v6M13.8 11v6" ${S}/>`,
  eye: `<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" ${S}/><circle cx="12" cy="12" r="3" ${S}/>`,
  eyeOff: `<path d="M4 4l16 16" ${S}/><path d="M10 5.7c.6-.1 1.3-.2 2-.2 6 0 9.5 6.5 9.5 6.5a17 17 0 01-2.6 3.4M6.6 6.9C3.9 8.6 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1" ${S}/><path d="M9.9 9.9a3 3 0 004.2 4.2" ${S}/>`,
  lock: `<rect x="5" y="10.5" width="14" height="10" rx="2" ${S}/><path d="M8 10.5V7.5a4 4 0 018 0v3" ${S}/>`,
  unlock: `<rect x="5" y="10.5" width="14" height="10" rx="2" ${S}/><path d="M8 10.5V7.5a4 4 0 017.6-1.7" ${S}/>`,
  volume: `<path d="M4 9.5h3.2L12 5.2v13.6l-4.8-4.3H4z" ${S}/><path d="M15.5 9a4.2 4.2 0 010 6M18 6.5a7.8 7.8 0 010 11" ${S}/>`,
  mute: `<path d="M4 9.5h3.2L12 5.2v13.6l-4.8-4.3H4z" ${S}/><path d="M16 9.5l5 5M21 9.5l-5 5" ${S}/>`,
  solo: `<circle cx="12" cy="12" r="8.5" ${S}/><path d="M14.6 9.2c-.4-.9-1.4-1.5-2.6-1.5-1.5 0-2.6.8-2.6 2s1.1 1.7 2.6 2.1c1.6.4 2.8 1 2.8 2.3s-1.2 2.2-2.8 2.2c-1.3 0-2.4-.6-2.8-1.6" ${S}/>`,
  diamond: `<path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12z" ${S}/>`,
  diamondFill: `<path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12z" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>`,
  diamondPlus: `<path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12z" ${S}/><path d="M12 9v6M9 12h6" ${S}/>`,
  chevLeft: `<path d="M14.5 6l-6 6 6 6" ${S}/>`,
  chevRight: `<path d="M9.5 6l6 6-6 6" ${S}/>`,
  chevDown: `<path d="M6 9.5l6 6 6-6" ${S}/>`,
  chevUp: `<path d="M6 14.5l6-6 6 6" ${S}/>`,
  folder: `<path d="M3.5 7.2c0-1 .8-1.7 1.7-1.7h4.2l2 2.2h7.4c1 0 1.7.8 1.7 1.7v8.4c0 1-.8 1.7-1.7 1.7H5.2c-1 0-1.7-.8-1.7-1.7z" ${S}/>`,
  folderOpen: `<path d="M3.5 17.5V7.2c0-1 .8-1.7 1.7-1.7h4.2l2 2.2h6.4c1 0 1.7.8 1.7 1.7v1.1" ${S}/><path d="M3.5 17.5l2.6-6.1c.3-.6.9-1 1.6-1H20c.8 0 1.4.8 1.1 1.6l-2.2 5.6c-.3.7-.9 1.1-1.6 1.1H5" ${S}/>`,
  film: `<rect x="3.5" y="3.5" width="17" height="17" rx="2.5" ${S}/><path d="M7.5 3.5v17M16.5 3.5v17M3.5 8h4M3.5 12h4M3.5 16h4M16.5 8h4M16.5 12h4M16.5 16h4" ${S} stroke-width="1.4"/>`,
  copy: `<rect x="8.5" y="8.5" width="12" height="12" rx="2" ${S}/><path d="M15.5 8.5V5.5a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2h3" ${S}/>`,
  check: `<path d="M5 12.5l4.5 4.5L19 7.5" ${S} stroke-width="2.2"/>`,
  alert: `<path d="M12 3.8l9 15.6a.9.9 0 01-.8 1.4H3.8a.9.9 0 01-.8-1.4z" ${S}/><path d="M12 10v4.2" ${S}/><circle cx="12" cy="17.4" r="1" ${F}/>`,
  info: `<circle cx="12" cy="12" r="8.8" ${S}/><path d="M12 11v5.5" ${S}/><circle cx="12" cy="7.8" r="1.05" ${F}/>`,
  sparkle: `<path d="M12 2.8c.5 3.9 2.6 6.6 7.2 7.2-4.6.6-6.7 3.3-7.2 7.2-.5-3.9-2.6-6.6-7.2-7.2 4.6-.6 6.7-3.3 7.2-7.2z" ${F}/><path d="M18.6 15.2c.2 1.7 1.1 2.7 2.8 2.9-1.7.2-2.6 1.2-2.8 2.9-.2-1.7-1.1-2.7-2.8-2.9 1.7-.2 2.6-1.2 2.8-2.9z" ${F}/>`,
  search: `<circle cx="10.8" cy="10.8" r="6.3" ${S}/><path d="M15.5 15.5l4.5 4.5" ${S}/>`,
  magnet: `<path d="M5.5 4.5h4v7a2.5 2.5 0 005 0v-7h4v7a6.5 6.5 0 01-13 0z" ${S}/><path d="M5.5 8.5h4M14.5 8.5h4" ${S}/>`,
  scissors: `<circle cx="6.5" cy="7" r="2.8" ${S}/><circle cx="6.5" cy="17" r="2.8" ${S}/><path d="M8.8 8.6L20 18M8.8 15.4L20 6" ${S}/>`,
  cursor: `<path d="M5.5 3.5l13 7.2-5.6 1.5 3.4 6.4-2.6 1.4-3.4-6.4-4.8 3.6z" ${S}/>`,
  text: `<path d="M5 6.5V4.5h14v2M12 4.5v15M9 19.5h6" ${S}/>`,
  image: `<rect x="3.5" y="4.5" width="17" height="15" rx="2.2" ${S}/><circle cx="9" cy="9.5" r="1.8" ${S}/><path d="M3.8 17l4.8-4.6c.6-.6 1.5-.6 2.1 0l5.1 5M14 15l1.7-1.6c.6-.6 1.5-.6 2.1 0l2.5 2.4" ${S}/>`,
  music: `<path d="M9 18V5.5l11-2v12.2" ${S}/><circle cx="6.5" cy="18" r="2.5" ${S}/><circle cx="17.5" cy="15.7" r="2.5" ${S}/>`,
  mic: `<rect x="9" y="3" width="6" height="11" rx="3" ${S}/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21M8.5 21h7" ${S}/>`,
  sticker: `<path d="M20.5 12.5a8.5 8.5 0 11-9-9h1.2c0 4.6 3.3 7.8 7.8 7.8z" ${S}/><path d="M12.7 3.5a8.5 8.5 0 017.8 7.8" ${S}/><circle cx="9" cy="11" r="1" ${F}/><circle cx="14" cy="13.6" r="1" ${F}/><path d="M8.7 15.5c1.2 1.3 3.3 1.6 4.8.8" ${S}/>`,
  shape: `<rect x="3.5" y="10.5" width="10" height="10" rx="1.5" ${S}/><circle cx="15.5" cy="8.5" r="5" ${S}/>`,
  wand: `<path d="M4 20l11-11" ${S}/><path d="M13.5 7.5l3 3" ${S}/><path d="M17.5 2.5v3M16 4h3M20.5 8.5v2.4M19.3 9.7h2.4M9.5 3.5v2M8.5 4.5h2" ${S} stroke-width="1.5"/>`,
  filter: `<circle cx="9" cy="9.5" r="5" ${S}/><circle cx="15" cy="9.5" r="5" ${S}/><circle cx="12" cy="14.8" r="5" ${S}/>`,
  transition: `<path d="M3.5 5.5l8.5 6.5-8.5 6.5z" ${S}/><path d="M20.5 5.5L12 12l8.5 6.5z" ${S}/>`,
  layers: `<path d="M12 3.5l9 4.8-9 4.8-9-4.8z" ${S}/><path d="M3 12.5l9 4.8 9-4.8" ${S}/><path d="M3 16.5l9 4.8 9-4.8" ${S} opacity=".6"/>`,
  arrowUp: `<path d="M12 19V5M6.5 10.5L12 5l5.5 5.5" ${S}/>`,
  arrowDown: `<path d="M12 5v14M6.5 13.5L12 19l5.5-5.5" ${S}/>`,
  reset: `<path d="M4.5 12a7.5 7.5 0 102.2-5.3L4.5 9" ${S}/><path d="M4.5 4.5V9H9" ${S}/>`,
  link: `<path d="M10 14a4 4 0 005.7 0l3.2-3.2a4 4 0 00-5.7-5.7l-1.2 1.2" ${S}/><path d="M14 10a4 4 0 00-5.7 0l-3.2 3.2a4 4 0 005.7 5.7l1.2-1.2" ${S}/>`,
  unlink: `<path d="M10 14a4 4 0 005.7 0l3.2-3.2a4 4 0 00-5.7-5.7l-1.2 1.2" ${S} opacity=".5"/><path d="M14 10a4 4 0 00-5.7 0l-3.2 3.2a4 4 0 005.7 5.7l1.2-1.2" ${S} opacity=".5"/><path d="M4 4l16 16" ${S}/>`,
  eyedropper: `<path d="M14.5 5.5l4 4" ${S}/><path d="M16.5 3.6a2.3 2.3 0 013.3 3.3l-2.2 2.2-3.3-3.3z" ${S}/><path d="M14.3 7.8L5.6 16.5 4.5 19.5l3-1.1 8.7-8.7" ${S}/>`,
  flipH: `<path d="M12 3v18" ${S} stroke-dasharray="2 2.2"/><path d="M9 6.5L3.5 17.5H9z" ${S}/><path d="M15 6.5l5.5 11H15z" ${F} opacity=".85"/>`,
  flipV: `<path d="M3 12h18" ${S} stroke-dasharray="2 2.2"/><path d="M6.5 9L17.5 3.5V9z" ${S}/><path d="M6.5 15l11 5.5V15z" ${F} opacity=".85"/>`,
  alignRight: `<path d="M5 6.5h15M9 10.5h11M6.5 14.5H20M11 18.5h9" ${S}/>`,
  alignCenter: `<path d="M4.5 6.5h15M7.5 10.5h9M5.5 14.5h13M8.5 18.5h7" ${S}/>`,
  alignLeft: `<path d="M4 6.5h15M4 10.5h11M4 14.5h13.5M4 18.5h9" ${S}/>`,
  bold: `<path d="M7 4.5h6a3.6 3.6 0 010 7.2H7zM7 11.7h7a3.9 3.9 0 010 7.8H7z" ${S} stroke-width="2.1"/>`,
  italic: `<path d="M10 4.5h8M6 19.5h8M14.5 4.5l-5 15" ${S}/>`,
  underline: `<path d="M7 4v7a5 5 0 0010 0V4M5 20h14" ${S}/>`,
  gear: `<circle cx="12" cy="12" r="3" ${S}/><path d="M19.4 13.5a7.6 7.6 0 000-3l2-1.5-2-3.5-2.4 1a7.5 7.5 0 00-2.6-1.5L14 2.5h-4l-.4 2.5A7.5 7.5 0 007 6.5l-2.4-1-2 3.5 2 1.5a7.6 7.6 0 000 3l-2 1.5 2 3.5 2.4-1a7.5 7.5 0 002.6 1.5l.4 2.5h4l.4-2.5a7.5 7.5 0 002.6-1.5l2.4 1 2-3.5z" ${S} stroke-width="1.5"/>`,
  keyboard: `<rect x="2.5" y="6" width="19" height="12" rx="2.2" ${S}/><path d="M6 9.5h.01M9.3 9.5h.01M12.6 9.5h.01M15.9 9.5h.01M18 9.5h.01M6 12.5h.01M9.3 12.5h.01M12.6 12.5h.01M15.9 12.5h.01M8 15.3h8" ${S} stroke-width="2"/>`,
  help: `<circle cx="12" cy="12" r="8.8" ${S}/><path d="M9.4 9.4a2.7 2.7 0 015.2.9c0 1.8-2.6 2.3-2.6 3.9" ${S}/><circle cx="12" cy="17" r="1" ${F}/>`,
  speed: `<path d="M4.2 17.5a8.5 8.5 0 1115.6 0" ${S}/><path d="M12 13.5l4.5-4.5" ${S}/><circle cx="12" cy="13.5" r="1.4" ${F}/>`,
  mask: `<rect x="3.5" y="3.5" width="17" height="17" rx="2.5" ${S}/><circle cx="12" cy="12" r="5" ${F} opacity=".85"/>`,
  chroma: `<path d="M12 3.2c3.2 4 6 7.2 6 10.6a6 6 0 01-12 0c0-3.4 2.8-6.6 6-10.6z" ${S}/><path d="M9 14.2a3 3 0 003 3" ${S}/>`,
  wave: `<path d="M3 12h1.5M6 8v8M9 5v14M12 9v6M15 6.5v11M18 9.5v5M21 12h-.5" ${S}/>`,
  crop: `<path d="M6.5 2.5v13a2 2 0 002 2h13" ${S}/><path d="M2.5 6.5h13a2 2 0 012 2v13" ${S}/>`,
  move: `<path d="M12 3v18M3 12h18" ${S}/><path d="M9.5 5.5L12 3l2.5 2.5M9.5 18.5L12 21l2.5-2.5M5.5 9.5L3 12l2.5 2.5M18.5 9.5L21 12l-2.5 2.5" ${S}/>`,
  rotate: `<path d="M20 12a8 8 0 11-2.6-5.9" ${S}/><path d="M20 3.5v4.5h-4.5" ${S}/>`,
  projects: `<rect x="3.5" y="3.5" width="7" height="7" rx="1.6" ${S}/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6" ${S}/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6" ${S}/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6" ${S}/>`,
  dots: `<circle cx="5.5" cy="12" r="1.6" ${F}/><circle cx="12" cy="12" r="1.6" ${F}/><circle cx="18.5" cy="12" r="1.6" ${F}/>`,
  download: `<path d="M12 3.5v12M7.5 11l4.5 4.5 4.5-4.5M4 20.5h16" ${S}/>`,
  clock: `<circle cx="12" cy="12" r="8.8" ${S}/><path d="M12 7v5.2l3.3 2" ${S}/>`,
  marker: `<path d="M6 3.5h12v12.5l-6 4.5-6-4.5z" ${S}/>`,
  inPoint: `<path d="M8 4.5v15M8 4.5h5M8 19.5h5" ${S} stroke-width="2"/>`,
  outPoint: `<path d="M16 4.5v15M16 4.5h-5M16 19.5h-5" ${S} stroke-width="2"/>`,
  zoomIn: `<circle cx="10.8" cy="10.8" r="6.3" ${S}/><path d="M15.5 15.5l4.5 4.5M10.8 8.3v5M8.3 10.8h5" ${S}/>`,
  zoomOut: `<circle cx="10.8" cy="10.8" r="6.3" ${S}/><path d="M15.5 15.5l4.5 4.5M8.3 10.8h5" ${S}/>`,
  video: `<rect x="2.5" y="6" width="13" height="12" rx="2.2" ${S}/><path d="M15.5 10.2l5-3v9.6l-5-3z" ${S}/>`,
  audio: `<path d="M3 13.5v-3M6.5 16v-8M10 19V5M13.5 15.5v-7M17 17.5v-11M20.5 13.5v-3" ${S}/>`,
  caption: `<rect x="2.5" y="5" width="19" height="14" rx="2.5" ${S}/><path d="M6 12.5h4M12.5 12.5h5.5M6 15.5h7M15 15.5h3" ${S}/>`,
  effect: `<path d="M12 3l1.9 4.6 4.9.4-3.7 3.2 1.1 4.8L12 13.4 7.8 16l1.1-4.8L5.2 8l4.9-.4z" ${S}/><path d="M5 19.5h14" ${S}/>`,
  adjust: `<path d="M4 7h9M17 7h3M4 17h3M11 17h9" ${S}/><circle cx="15" cy="7" r="2.2" ${S}/><circle cx="9" cy="17" r="2.2" ${S}/>`,
  color: `<path d="M12 3a9 9 0 100 18c1.3 0 1.8-1 1.4-2-.5-1.2.3-2.5 1.6-2.5H17a4 4 0 004-4C21 7 17 3 12 3z" ${S}/><circle cx="7.5" cy="11" r="1.2" ${F}/><circle cx="10" cy="7" r="1.2" ${F}/><circle cx="14.5" cy="7" r="1.2" ${F}/>`,
  anim: `<circle cx="15" cy="12" r="5.5" ${S}/><path d="M3 9h4.5M2.5 12h4M3 15h4.5" ${S}/>`,
  basic: `<rect x="4" y="4" width="16" height="16" rx="2.5" ${S}/><path d="M4 9.5h16M9.5 9.5V20" ${S}/>`,
  track: `<rect x="3" y="5" width="18" height="5" rx="1.4" ${S}/><rect x="3" y="14" width="18" height="5" rx="1.4" ${S}/>`,
  link2: `<path d="M8 12h8" ${S}/><rect x="2.5" y="8" width="7" height="8" rx="3" ${S}/><rect x="14.5" y="8" width="7" height="8" rx="3" ${S}/>`,
  external: `<path d="M14 4.5h5.5V10M19.5 4.5L11 13" ${S}/><path d="M18 14v4.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 014 18.5v-11A1.5 1.5 0 015.5 6H10" ${S}/>`,
  upload: `<path d="M12 16V4.5M7.5 9L12 4.5 16.5 9M4 20h16" ${S}/>`,
  heart: `<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0112 7.3 4.3 4.3 0 0119.5 10c0 5.4-7.5 10-7.5 10z" ${S}/>`,
  star: `<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z" ${S}/>`,
  ellipse: `<ellipse cx="12" cy="12" rx="8.5" ry="6.5" ${S}/>`,
  rect: `<rect x="4" y="6" width="16" height="12" rx="1.5" ${S}/>`,
  roundrect: `<rect x="4" y="6" width="16" height="12" rx="4.5" ${S}/>`,
  line: `<path d="M4.5 19.5l15-15" ${S}/>`,
  arrow: `<path d="M4 12h15M13.5 6.5L19 12l-5.5 5.5" ${S}/>`,
  triangle: `<path d="M12 4.5l8.5 15h-17z" ${S}/>`,
  burst: `<path d="M12 2.5l2 4.3 4.6-1.6-1.4 4.6 4.3 2.2-4.3 2.2 1.4 4.6-4.6-1.6-2 4.3-2-4.3-4.6 1.6 1.4-4.6L2.5 12l4.3-2.2L5.4 5.2 10 6.8z" ${S} stroke-width="1.5"/>`,
  progress: `<rect x="3" y="9.5" width="18" height="5" rx="2.5" ${S}/><rect x="4.6" y="11" width="9" height="2" rx="1" ${F}/>`,
  ripple: `<path d="M3 12h4l2-5 3 10 2-5h7" ${S}/>`,
  split: `<path d="M12 3v18" ${S}/><rect x="3" y="7.5" width="6" height="9" rx="1.5" ${S}/><rect x="15" y="7.5" width="6" height="9" rx="1.5" ${S}/>`,
  record: `<circle cx="12" cy="12" r="6" ${F}/>`,
  phone: `<rect x="6.5" y="2.5" width="11" height="19" rx="2.5" ${S}/><path d="M10.5 18.5h3" ${S}/>`,
};

export function icon(name, size = 16, cls = '') {
  const body = ICONS[name] || ICONS.dots;
  return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** replace children of every [data-icon] element inside root with the icon SVG (keeps other children after) */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.dataset.iconDone === el.dataset.icon) continue;
    const size = Number(el.dataset.iconSize || 16);
    const old = el.querySelector(':scope > svg.ic');
    if (old) old.remove();
    el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon, size));
    el.dataset.iconDone = el.dataset.icon;
  }
}
