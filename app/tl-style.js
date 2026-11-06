// Frame Studio — timeline styles (agent L). Injected by timeline.js mount(); scoped under .fs-tl.

export const TL_CSS = `
.fs-tl{--tl-bg:#111317;--tl-lane:#16191e;--tl-lane-alt:#14171b;--tl-head:#191c21;--tl-line:#252a31;--tl-text:#e7e9ec;--tl-text2:#a9afb8;
  --tl-text3:#6f7681;--tl-accent:var(--accent,#13b6e4);--tl-accent-hi:var(--accent-hi,#3fcaf0);--tl-ph:#ffffff;--tl-snap:#f5c518;--tl-kf:var(--kf,#f5c518);
  --tl-hw:176px;position:absolute;inset:0;display:flex;flex-direction:column;background:var(--tl-bg);color:var(--tl-text);direction:ltr;
  font:12px/1.3 var(--font,"Segoe UI",Heebo,Arial,sans-serif);user-select:none;-webkit-user-select:none;outline:none;overflow:hidden;contain:strict}
.fs-tl *{box-sizing:border-box}
.fs-tl svg.ic{display:block;flex:none}

/* toolbar */
.tl-bar{height:38px;flex:none;display:flex;align-items:center;gap:2px;padding:0 8px;border-bottom:1px solid var(--tl-line);background:#15181d}
.tl-btn{height:28px;min-width:28px;padding:0 6px;border-radius:6px;border:0;background:transparent;color:var(--tl-text2);display:inline-flex;align-items:center;justify-content:center;gap:5px;cursor:pointer;font:inherit;position:relative}
.tl-btn:hover{background:#222730;color:#fff}
.tl-btn:active{transform:translateY(.5px)}
.tl-btn.on{color:var(--tl-accent-hi);background:rgba(19,182,228,.13)}
.tl-btn.on:hover{background:rgba(19,182,228,.2)}
.tl-btn[disabled]{opacity:.35;pointer-events:none}
.tl-btn .tl-btn-txt{font-size:11.5px}
.tl-sep{width:1px;height:20px;background:#2a3038;margin:0 6px;flex:none}
.tl-spacer{flex:1}
.tl-tc{font:600 12.5px/1 var(--mono,Consolas,monospace);color:#fff;letter-spacing:.02em;padding:0 10px;white-space:nowrap}
.tl-tc span{color:var(--tl-text3);font-weight:400}
.tl-zoom{display:flex;align-items:center;gap:2px}
.tl-zoom input[type=range]{-webkit-appearance:none;appearance:none;width:110px;height:18px;background:transparent;margin:0 4px;cursor:pointer}
.tl-zoom input[type=range]::-webkit-slider-runnable-track{height:3px;border-radius:3px;background:linear-gradient(90deg,var(--tl-accent) var(--p,50%),#2f353e var(--p,50%))}
.tl-zoom input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:12px;border-radius:50%;background:#fff;margin-top:-4.5px;box-shadow:0 1px 4px rgba(0,0,0,.5)}

/* body grid */
.tl-body{flex:1;position:relative;min-height:0}
.tl-corner{position:absolute;left:0;top:0;width:var(--tl-hw);height:30px;border-right:1px solid var(--tl-line);border-bottom:1px solid var(--tl-line);background:#15181d;
  display:flex;align-items:center;gap:4px;padding:0 6px;z-index:6}
.tl-corner .tl-btn{height:24px;font-size:11.5px;color:var(--tl-text2);direction:rtl;padding:0 8px}
.tl-corner .tl-addtrack{border:1px dashed #343b45;color:var(--tl-text2)}
.tl-corner .tl-addtrack:hover{border-color:var(--tl-accent);color:#fff;background:rgba(19,182,228,.08)}
.tl-ruler{position:absolute;left:var(--tl-hw);right:10px;top:0;height:30px;border-bottom:1px solid var(--tl-line);background:#15181d;z-index:5;cursor:text;overflow:hidden}
.tl-ruler canvas{position:absolute;left:0;top:0}
.tl-heads{position:absolute;left:0;top:30px;width:var(--tl-hw);bottom:12px;overflow:hidden;border-right:1px solid var(--tl-line);background:var(--tl-head);z-index:4}
.tl-heads-in{position:absolute;left:0;top:0;width:100%;will-change:transform}
.tl-view{position:absolute;left:var(--tl-hw);right:10px;top:30px;bottom:12px;overflow:hidden;background:var(--tl-bg)}
.tl-content{position:absolute;left:0;top:0;will-change:transform}
.tl-lanes,.tl-clips,.tl-over{position:absolute;left:0;top:0}
.tl-lane{position:absolute;left:0;background:var(--tl-lane);border-top:1px solid rgba(255,255,255,.025);border-bottom:1px solid rgba(0,0,0,.35)}
.tl-lane.alt{background:var(--tl-lane-alt)}
.tl-lane.main{background:#1a1e24}
.tl-lane.locked{background-image:repeating-linear-gradient(135deg,rgba(255,255,255,.025) 0 6px,transparent 6px 12px)}
.tl-lane.drop-target{background:#1c2a33 !important;box-shadow:inset 0 0 0 1px rgba(19,182,228,.35)}
.tl-endshade{position:absolute;top:0;background:rgba(0,0,0,.22);pointer-events:none}

/* clips */
.tl-clip{position:absolute;left:0;top:0;border-radius:6px;overflow:hidden;cursor:grab;contain:layout paint;will-change:transform;
  background:var(--cc,#1f6f8f);box-shadow:inset 0 0 0 1px rgba(255,255,255,.10),0 1px 2px rgba(0,0,0,.35)}
.tl-clip.anim{transition:transform .16s cubic-bezier(.2,.8,.2,1),width .16s}
.tl-clip:hover{box-shadow:inset 0 0 0 1px rgba(255,255,255,.28),0 1px 2px rgba(0,0,0,.35)}
.tl-clip.sel{box-shadow:inset 0 0 0 2px #fff,0 0 0 1px rgba(0,0,0,.6),0 2px 10px rgba(0,0,0,.45);z-index:2}
.tl-clip.dragging{opacity:.9;z-index:30;cursor:grabbing;box-shadow:inset 0 0 0 2px #fff,0 10px 26px rgba(0,0,0,.55)}
.tl-clip.ghost-src{opacity:.35}
.tl-clip.disabled{opacity:.45;filter:grayscale(.7)}
.tl-clip.disabled .tl-clip-name{text-decoration:line-through}
.tl-clip.hiddentrack{opacity:.4}
.tl-clip.mutedtrack .tl-clip-cv{opacity:.45}
.tl-clip.locked{cursor:not-allowed}
.tl-clip.drop-on{box-shadow:inset 0 0 0 2px var(--tl-accent-hi),0 0 16px rgba(19,182,228,.45)}
.tl-clip.blade{cursor:inherit}
.tl-clip-cv{position:absolute;top:0;left:0;pointer-events:none}
.tl-clip-head{position:absolute;left:0;top:0;height:18px;max-width:100%;display:flex;align-items:center;gap:4px;padding:0 6px 0 5px;pointer-events:none;
  color:#fff;font-size:11px;font-weight:600;white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,.7);will-change:transform;z-index:2}
.tl-clip-head .ic{opacity:.9}
.tl-clip-name{overflow:hidden;text-overflow:ellipsis;unicode-bidi:plaintext}
.tl-clip-badge{display:inline-flex;align-items:center;justify-content:center;width:16px;height:14px;border-radius:4px;background:rgba(0,0,0,.4);color:#fff;flex:none}
.tl-clip.t-video .tl-clip-head,.tl-clip.t-image .tl-clip-head{background:linear-gradient(180deg,rgba(0,0,0,.55),rgba(0,0,0,0));height:20px}
.tl-clip.t-text .tl-clip-head,.tl-clip.t-caption .tl-clip-head,.tl-clip.t-sticker .tl-clip-head,.tl-clip.t-shape .tl-clip-head,
.tl-clip.t-effect .tl-clip-head,.tl-clip.t-adjustment .tl-clip-head{top:calc(50% - 9px);font-weight:500;font-size:11.5px}
.tl-trim{position:absolute;top:0;bottom:0;width:8px;z-index:5;cursor:ew-resize}
.tl-trim.l{left:0}.tl-trim.r{right:0}
.tl-trim::after{content:"";position:absolute;top:3px;bottom:3px;width:3px;border-radius:2px;background:#fff;opacity:0;transition:opacity .1s}
.tl-trim.l::after{left:1px}.tl-trim.r::after{right:1px}
.tl-clip:hover .tl-trim::after,.tl-clip.sel .tl-trim::after{opacity:.75}
.tl-trim:hover::after{opacity:1 !important;background:var(--tl-accent-hi)}
.tl-clip.locked .tl-trim,.tl-clip.blade .tl-trim{display:none}
.tl-trim.limit::after{background:#ff5c63 !important;opacity:1 !important}
.tl-fadeh{position:absolute;top:1px;width:11px;height:11px;margin-left:-5.5px;border-radius:50%;background:#fff;border:2px solid rgba(0,0,0,.55);z-index:6;cursor:ew-resize;opacity:0;transition:opacity .1s}
.tl-clip:hover .tl-fadeh,.tl-clip.sel .tl-fadeh{opacity:.95}
.tl-vol{position:absolute;left:0;right:0;height:9px;margin-top:-4px;z-index:4;cursor:ns-resize;opacity:0;transition:opacity .12s}
.tl-clip:hover .tl-vol,.tl-clip.sel .tl-vol{opacity:1}
.tl-vol::after{content:"";position:absolute;left:0;right:0;top:4px;height:1.5px;background:rgba(255,236,150,.85);box-shadow:0 0 2px rgba(0,0,0,.6)}
.tl-vol:hover::after{background:#fff4b0;height:2px}
.tl-kfs{position:absolute;left:0;right:0;bottom:0;height:15px;z-index:7;pointer-events:none}
.tl-kfs:not(:empty){background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.6))}
.tl-kf{position:absolute;bottom:2px;width:12px;height:12px;margin-left:-6px;pointer-events:auto;cursor:ew-resize;color:var(--tl-kf);filter:drop-shadow(0 0 1px #000) drop-shadow(0 1px 1px rgba(0,0,0,.9))}
.tl-kf:hover{color:#fff}
.tl-kf.active{color:#fff}

/* transitions */
.tl-tr{position:absolute;width:20px;height:20px;margin-left:-10px;border-radius:6px;z-index:8;display:flex;align-items:center;justify-content:center;cursor:pointer;
  background:#2a3038;color:#cfd4da;box-shadow:0 0 0 1px rgba(0,0,0,.55),0 2px 6px rgba(0,0,0,.4);opacity:0;transition:opacity .12s,transform .12s}
.tl-tr.on{opacity:1;background:var(--tl-accent);color:#062433}
.tl-tr.hot,.tl-tr:hover,.tl-tr.drop{opacity:1}
.tl-tr:hover{background:#3a424d;color:#fff}
.tl-tr.on:hover{background:var(--tl-accent-hi);color:#062433}
.tl-tr.drop{background:var(--tl-accent-hi);color:#062433;box-shadow:0 0 0 2px #fff}
.tl-trspan{position:absolute;z-index:3;pointer-events:none;border-radius:4px;background:rgba(19,182,228,.18);box-shadow:inset 0 0 0 1px rgba(63,202,240,.45)}

/* overlays */
.tl-ph{position:absolute;top:0;bottom:12px;width:0;z-index:20;pointer-events:none;will-change:transform}
.tl-ph-line{position:absolute;left:-0.5px;top:30px;bottom:0;width:1.5px;background:var(--tl-ph);box-shadow:0 0 0 .5px rgba(0,0,0,.4)}
.tl-ph-head{position:absolute;left:-7px;top:12px;width:14px;height:18px;pointer-events:auto;cursor:ew-resize}
.tl-ph-head::before{content:"";position:absolute;left:0;top:0;width:14px;height:12px;background:var(--tl-ph);border-radius:3px 3px 0 0}
.tl-ph-head::after{content:"";position:absolute;left:0;top:12px;border-left:7px solid transparent;border-right:7px solid transparent;border-top:6px solid var(--tl-ph)}
.tl-snapline{position:absolute;top:0;bottom:0;width:1px;background:var(--tl-snap);z-index:25;pointer-events:none;display:none}
.tl-bladeline{position:absolute;width:1px;background:#ff5c63;z-index:25;pointer-events:none;display:none}
.tl-marquee{position:absolute;z-index:26;border:1px solid var(--tl-accent-hi);background:rgba(19,182,228,.12);pointer-events:none;display:none}
.tl-newtrack{position:absolute;left:0;right:0;height:2px;margin-top:-1px;border-radius:2px;background:var(--tl-accent-hi);z-index:24;pointer-events:none;display:none}
.tl-newtrack::after{content:attr(data-label);position:absolute;left:8px;top:-17px;font-size:10.5px;color:var(--tl-accent-hi);white-space:nowrap;direction:rtl}
.tl-ghost{position:absolute;border-radius:6px;z-index:23;pointer-events:none;display:none;border:1.5px dashed rgba(255,255,255,.85);background:rgba(19,182,228,.22);
  color:#fff;font-size:11px;font-weight:600;padding:2px 6px;white-space:nowrap;overflow:hidden;unicode-bidi:plaintext}
.tl-insert{position:absolute;width:3px;margin-left:-1.5px;border-radius:2px;background:var(--tl-accent-hi);z-index:24;pointer-events:none;display:none}
.tl-range-shade{position:absolute;top:0;bottom:0;background:rgba(19,182,228,.05);border-left:1px solid rgba(19,182,228,.45);border-right:1px solid rgba(19,182,228,.45);pointer-events:none;z-index:1}
.tl-beat{position:absolute;top:2px;width:4px;height:4px;margin-left:-2px;border-radius:50%;background:rgba(255,255,255,.75);pointer-events:none}

/* markers on ruler */
.tl-mk{position:absolute;top:17px;width:9px;height:13px;margin-left:-4.5px;z-index:3;pointer-events:auto;cursor:pointer}
.tl-mk-tick{position:absolute;left:3.5px;top:3px;width:2px;height:10px;border-radius:1px;background:var(--mc,#f5c518);opacity:.85}
.tl-mk:hover .tl-mk-tick{opacity:1;left:2.5px;width:4px}
.tl-range-h{position:absolute;top:0;height:30px;width:9px;margin-left:-4.5px;cursor:ew-resize;z-index:4}
.tl-range-h::after{content:"";position:absolute;left:3px;top:3px;bottom:3px;width:3px;border-radius:2px;background:var(--tl-accent-hi)}

/* headers */
.tl-th{position:absolute;left:0;right:0;display:flex;align-items:stretch;background:var(--tl-head);border-bottom:1px solid rgba(0,0,0,.35);border-top:1px solid rgba(255,255,255,.025)}
.tl-th.alt{background:#171a1f}
.tl-th.sel{background:#1d2229}
.tl-th-color{width:3px;flex:none;background:var(--rc,#4a5563)}
.tl-th-grip{width:14px;flex:none;display:flex;align-items:center;justify-content:center;color:#4b515a;cursor:grab;opacity:0;transition:opacity .12s}
.tl-th:hover .tl-th-grip{opacity:1}
.tl-th-grip:hover{color:#a9afb8}
.tl-th-main{flex:1;min-width:0;display:flex;flex-direction:row;align-items:center;gap:5px;padding:0 6px 0 2px}
.tl-th-ic{color:var(--rc,#a9afb8);display:flex;opacity:.85}
.tl-th-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;font-size:11.5px;color:#c9ced4;unicode-bidi:plaintext;cursor:default}
.tl-th-btns{display:flex;align-items:center;gap:0;flex:none}
.tl-tb{width:22px;height:20px;border-radius:5px;border:0;background:transparent;color:#646b75;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;padding:0;flex:none}
.tl-tb:hover{background:#262b33;color:#fff}
.tl-tb.solo:not(.on){display:none}
.tl-th:hover .tl-tb.solo{display:inline-flex}
.tl-tb.on{color:#ffcf4a}
.tl-tb.on.red{color:#ff6b70}
.tl-tb.solo.on{color:#062433;background:#f5c518}
.tl-th-resize{position:absolute;left:0;right:0;bottom:-3px;height:6px;cursor:ns-resize;z-index:2}
.tl-th.compact .tl-th-ic{display:none}
.tl-th.reorder{opacity:.5}
.tl-th-drop{position:absolute;left:0;right:0;height:3px;margin-top:-1.5px;background:var(--tl-accent-hi);z-index:8;display:none}
.tl-th-empty{position:absolute;left:0;right:0;display:flex;align-items:center;justify-content:center;color:var(--tl-text3);font-size:11px;direction:rtl}

/* scrollbars */
.tl-hs{position:absolute;left:var(--tl-hw);right:10px;bottom:0;height:12px;background:#121418;border-top:1px solid #1d2126}
.tl-vs{position:absolute;right:0;top:30px;bottom:12px;width:10px;background:#121418;border-left:1px solid #1d2126}
.tl-hs-thumb{position:absolute;top:2px;height:7px;border-radius:5px;background:#3a414b;cursor:grab;min-width:24px}
.tl-hs-thumb:hover{background:#4a525d}
.tl-hs-grip{position:absolute;top:-2px;width:8px;height:11px;cursor:ew-resize}
.tl-hs-grip.l{left:-3px}.tl-hs-grip.r{right:-3px}
.tl-vs-thumb{position:absolute;left:2px;width:6px;border-radius:4px;background:#3a414b;cursor:grab}
.tl-vs-thumb:hover{background:#4a525d}
.tl-cornerbr{position:absolute;right:0;bottom:0;width:10px;height:12px;background:#121418}

.tl-empty{position:absolute;inset:30px 10px 12px var(--tl-hw);display:flex;align-items:center;justify-content:center;flex-direction:column;gap:6px;color:var(--tl-text3);
  pointer-events:none;direction:rtl;font-size:13px}
.tl-empty b{color:var(--tl-text2);font-weight:600}
.fs-tl.tool-blade .tl-view{cursor:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='M14.5 3.5l6 6L9 21H3v-6z' fill='%23ff5c63' stroke='%23fff' stroke-width='1.3'/%3E%3C/svg%3E") 3 21,crosshair}
.fs-tl.tool-blade .tl-clip{cursor:inherit}
.fs-tl.dropping .tl-view{outline:1px dashed rgba(63,202,240,.5);outline-offset:-2px}
.fs-tl .tl-fileover{position:absolute;inset:30px 10px 12px var(--tl-hw);display:none;align-items:center;justify-content:center;background:rgba(19,182,228,.07);
  color:var(--tl-accent-hi);font-size:14px;font-weight:600;pointer-events:none;z-index:40;direction:rtl}

/* transition picker */
.tlp{padding:10px 12px 12px}
.tlp-cats{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}
.tlp-cat{height:24px;padding:0 9px;border-radius:12px;border:1px solid #333a44;background:#20252c;color:#a9afb8;font:inherit;font-size:11.5px;cursor:pointer}
.tlp-cat.on{background:rgba(19,182,228,.18);border-color:#13b6e4;color:#fff}
.tlp-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;max-height:260px;overflow:auto;padding:2px}
.tlp-item{display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer;border-radius:8px;padding:3px;border:1px solid transparent}
.tlp-item canvas{width:100%;aspect-ratio:16/10;border-radius:6px;background:#0d0f12;display:block}
.tlp-item span{font-size:10.5px;color:#c4c9cf;text-align:center;line-height:1.15;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tlp-item:hover{background:#252a32}
.tlp-item.on{border-color:#13b6e4;background:rgba(19,182,228,.12)}
.tlp-row{display:flex;align-items:center;gap:8px;margin-top:10px}
.tlp-row label{color:#a9afb8;font-size:11.5px;flex:none}
.tlp-row input[type=range]{flex:1;accent-color:#13b6e4}
.tlp-row .tlp-val{font:12px var(--mono,Consolas,monospace);color:#fff;width:46px;text-align:left;direction:ltr}
.tlp-actions{display:flex;gap:6px;margin-top:10px}
`;
