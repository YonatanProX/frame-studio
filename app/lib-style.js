// Frame Studio — library panel styles (agent L). Scoped under .fs-lib (RTL).

export const LIB_CSS = `
.fs-lib{--lb-bg:var(--panel,#16191e);--lb-bg2:#1b1f25;--lb-line:var(--border,#252a31);--lb-text:var(--text,#e7e9ec);--lb-text2:var(--text-2,#a9afb8);
  --lb-text3:var(--text-3,#6f7681);--lb-accent:var(--accent,#13b6e4);--lb-accent-hi:var(--accent-hi,#3fcaf0);
  position:absolute;inset:0;display:flex;flex-direction:row;direction:rtl;background:var(--lb-bg);color:var(--lb-text);
  font:12.5px/1.35 var(--font,"Segoe UI",Heebo,Arial,sans-serif);overflow:hidden}
.fs-lib *{box-sizing:border-box}
.fs-lib svg.ic{display:block;flex:none}
.lb-tabs{width:62px;flex:none;display:flex;flex-direction:column;gap:2px;padding:6px 4px;border-left:1px solid var(--lb-line);background:#13161a;overflow-y:auto;overflow-x:hidden}
.lb-tabs::-webkit-scrollbar{width:0}
.lb-tab{display:flex;flex-direction:column;align-items:center;gap:3px;padding:7px 2px 6px;border-radius:8px;border:0;background:transparent;color:var(--lb-text3);cursor:pointer;font:inherit;font-size:10.5px;line-height:1.1;text-align:center}
.lb-tab:hover{background:#1d2127;color:var(--lb-text)}
.lb-tab.on{background:rgba(19,182,228,.14);color:#fff}
.lb-tab.on .ic{color:var(--lb-accent-hi)}
.lb-main{flex:1;min-width:0;display:flex;flex-direction:column}
.lb-head{flex:none;display:flex;align-items:center;gap:6px;padding:10px 12px 6px}
.lb-title{font-weight:700;font-size:13.5px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lb-sub{font-size:11px;color:var(--lb-text3);font-weight:400;margin-inline-start:6px}
.lb-hint{flex:none;margin:0 12px 6px;padding:5px 9px;border-radius:7px;background:rgba(19,182,228,.1);color:var(--lb-accent-hi);font-size:11.5px;display:none;align-items:center;gap:6px}
.lb-hint.show{display:flex}
.lb-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:2px 12px 14px;position:relative}
.lb-btn{height:28px;padding:0 10px;border-radius:7px;border:1px solid #30363f;background:#20252c;color:var(--lb-text);display:inline-flex;align-items:center;gap:6px;cursor:pointer;font:inherit;font-size:12px;white-space:nowrap}
.lb-btn:hover{background:#272d35;border-color:#3b424c}
.lb-btn.primary{background:var(--lb-accent);border-color:var(--lb-accent);color:#05222d;font-weight:600}
.lb-btn.primary:hover{background:var(--lb-accent-hi)}
.lb-btn.ghost{background:transparent;border-color:transparent;color:var(--lb-text2)}
.lb-btn.ghost:hover{background:#20252c;color:#fff}
.lb-btn.small{height:24px;padding:0 8px;font-size:11.5px}
.lb-btn[disabled]{opacity:.45;pointer-events:none}
.lb-icon-btn{width:26px;height:26px;border-radius:6px;border:0;background:transparent;color:var(--lb-text2);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex:none}
.lb-icon-btn:hover{background:#252a32;color:#fff}
.lb-row{display:flex;align-items:center;gap:6px;margin-bottom:8px}
.lb-search{position:relative;flex:1;min-width:0}
.lb-search input{width:100%;height:30px;border-radius:8px;border:1px solid #30363f;background:#0f1215;color:#fff;padding:0 30px 0 28px;font:inherit;outline:none;user-select:text}
.lb-search input:focus{border-color:var(--lb-accent);box-shadow:0 0 0 3px rgba(19,182,228,.16)}
.lb-search .ic-s{position:absolute;right:8px;top:7px;color:var(--lb-text3);pointer-events:none}
.lb-search .lb-clear{position:absolute;left:3px;top:2px;display:none}
.lb-search.has .lb-clear{display:inline-flex}
.lb-input{width:100%;height:30px;border-radius:8px;border:1px solid #30363f;background:#0f1215;color:#fff;padding:0 9px;font:inherit;outline:none;user-select:text}
.lb-input:focus{border-color:var(--lb-accent)}
.lb-chips{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px}
.lb-chip{height:24px;padding:0 9px;border-radius:12px;border:1px solid #30363f;background:#1c2026;color:var(--lb-text2);font:inherit;font-size:11.5px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.lb-chip:hover{border-color:#454d58;color:#fff}
.lb-chip.on{background:rgba(19,182,228,.16);border-color:var(--lb-accent);color:#fff}
.lb-chip .x{opacity:.7}
.lb-chip.role{border-color:rgba(245,197,24,.35);color:#f3d77a;flex:none}
.lb-chips.roles{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;-webkit-mask-image:linear-gradient(to left,#000 85%,transparent);scroll-behavior:smooth}
.lb-chips.roles::-webkit-scrollbar{display:none}
.lb-chip.role.on{background:rgba(245,197,24,.16);border-color:#f5c518;color:#fff}
.lb-section{margin:10px 0 6px;font-size:11px;font-weight:700;color:var(--lb-text3);letter-spacing:.02em;display:flex;align-items:center;gap:6px}
.lb-section::after{content:"";flex:1;height:1px;background:#252a31}
.lb-empty{padding:26px 10px;text-align:center;color:var(--lb-text3);font-size:12px;line-height:1.6}
.lb-empty b{display:block;color:var(--lb-text2);font-size:13px;margin-bottom:4px}
.lb-status{font-size:11px;color:var(--lb-text3);margin:2px 0 8px;display:flex;align-items:center;gap:6px}
.lb-status .bar{flex:1;height:3px;border-radius:2px;background:#252a31;overflow:hidden}
.lb-status .bar i{display:block;height:100%;background:var(--lb-accent)}
.lb-spin{width:12px;height:12px;border-radius:50%;border:2px solid rgba(255,255,255,.18);border-top-color:var(--lb-accent-hi);animation:lbspin .8s linear infinite;flex:none}
@keyframes lbspin{to{transform:rotate(360deg)}}

/* category tree */
.lb-tree{border:1px solid #262b33;border-radius:9px;background:#14171b;margin-bottom:8px;max-height:240px;overflow:auto;padding:4px}
.lb-tnode{display:flex;align-items:center;gap:5px;height:26px;padding:0 6px;border-radius:6px;cursor:pointer;color:var(--lb-text2);white-space:nowrap}
.lb-tnode:hover{background:#1e2228;color:#fff}
.lb-tnode.on{background:rgba(19,182,228,.15);color:#fff}
.lb-tnode .tw{width:14px;display:flex;justify-content:center;color:var(--lb-text3);transition:transform .12s}
.lb-tnode.open > .tw{transform:rotate(-90deg)}
.lb-tnode .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.lb-tnode .ct{font:10.5px var(--mono,Consolas,monospace);color:var(--lb-text3)}
.lb-tkids{padding-inline-start:14px}
.lb-treebtn{display:flex;align-items:center;gap:6px;height:28px;width:100%;padding:0 8px;border-radius:7px;border:1px solid #262b33;background:#171a1f;color:var(--lb-text2);cursor:pointer;font:inherit;font-size:12px;margin-bottom:6px}
.lb-treebtn:hover{color:#fff;border-color:#333a44}
.lb-treebtn .grow{flex:1;text-align:right}

/* sound rows */
.lb-snd{display:grid;grid-template-columns:28px 1fr 70px;grid-template-rows:auto auto;column-gap:8px;row-gap:2px;align-items:center;padding:6px 6px 6px 4px;border-radius:8px;cursor:pointer;position:relative;border:1px solid transparent}
.lb-snd:hover{background:#1c2026}
.lb-snd.playing{background:rgba(19,182,228,.1);border-color:rgba(19,182,228,.35)}
.lb-snd .pl{grid-row:1/3;width:28px;height:28px;border-radius:50%;background:#252b33;color:#dfe3e7;display:flex;align-items:center;justify-content:center;border:0;cursor:pointer}
.lb-snd.playing .pl{background:var(--lb-accent);color:#05222d}
.lb-snd .nm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:12px;direction:ltr;text-align:right;unicode-bidi:plaintext}
.lb-snd .meta{grid-column:2;min-width:0;display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--lb-text3);white-space:nowrap;overflow:hidden}
.lb-snd .meta .cat{overflow:hidden;text-overflow:ellipsis}
.lb-snd .wv{grid-column:3;grid-row:1;width:70px;height:22px;display:block}
.lb-snd .dur{grid-column:3;grid-row:2;font:10.5px var(--mono,Consolas,monospace);color:var(--lb-text2);text-align:left;direction:ltr}
.lb-snd .add{position:absolute;left:4px;top:50%;margin-top:-13px;opacity:0;background:#2b313a;color:#fff;transition:opacity .1s}
.lb-snd:hover .add{opacity:1}
.lb-snd:hover .wv,.lb-snd:hover .dur{visibility:hidden}
.lb-lic{font-size:9.5px;line-height:14px;padding:0 5px;border-radius:4px;background:#22303a;color:#8fd6ef;flex:none;cursor:help}
.lb-lic.mixkit{background:#2c2540;color:#c3a8ff}
.lb-lic.own{background:#22362b;color:#89e0ad}
.lb-lic.starter{background:#2a2f1f;color:#d9e38a}
/* sound folders + first-run state */
.lb-foldbtn .lb-cnt{display:inline-block;min-width:16px;height:16px;line-height:16px;padding:0 4px;border-radius:8px;background:#262c34;color:var(--lb-text2);font-size:10.5px;text-align:center;margin-inline-start:4px}
.lb-foldbtn .lb-warn{display:inline-flex;vertical-align:-2px;color:#f5c518;margin-inline-start:2px}
.lb-foldbtn.open{border-color:#333a44;color:#fff}
.lb-folders{border:1px solid #262b33;border-radius:9px;background:#14171b;margin:-2px 0 8px;padding:6px}
.lb-fold{display:flex;align-items:center;gap:8px;padding:5px 6px;border-radius:7px}
.lb-fold:hover{background:#1b1f25}
.lb-fold .fi{color:var(--lb-accent-hi);display:flex}
.lb-fold .tx{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.3}
.lb-fold .tx b{font-weight:600;font-size:12px;color:var(--lb-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;unicode-bidi:plaintext;text-align:right}
.lb-fold .tx span{font-size:10.5px;color:var(--lb-text3)}
.lb-fold .tx span.off{color:#f5c518}
.lb-fold-actions{display:flex;flex-wrap:wrap;gap:6px;padding:6px 4px 2px}
.lb-fold-note{font-size:10.5px;color:var(--lb-text3);padding:4px 4px 2px}
.lb-emptystate{display:flex;flex-direction:column;align-items:stretch;gap:10px;padding:26px 8px 18px;text-align:center}
.lb-emptystate .es-ic{width:58px;height:58px;border-radius:16px;background:rgba(19,182,228,.12);color:var(--lb-accent-hi);display:flex;align-items:center;justify-content:center;margin:0 auto 2px}
.lb-emptystate h3{margin:0 0 4px;font-size:15px;font-weight:700;color:#fff}
.lb-emptystate p{margin:2px 6px 0;font-size:12px;line-height:1.55;color:var(--lb-text2)}
.lb-emptystate p.small{font-size:11px;color:var(--lb-text3)}
.lb-bigbtn{min-height:44px;padding:8px 14px;border-radius:10px;border:1px solid #30363f;background:#1d2229;color:var(--lb-text);display:flex;align-items:center;justify-content:center;gap:9px;cursor:pointer;font:inherit;font-size:13px;font-weight:600}
.lb-bigbtn:hover{background:#252b33;border-color:#3b424c}
.lb-bigbtn.primary{background:var(--lb-accent);border-color:var(--lb-accent);color:#05222d}
.lb-bigbtn.primary:hover{background:var(--lb-accent-hi)}
.lb-bigbtn[disabled]{opacity:.7;pointer-events:none}
.lb-bigbtn .lb-spin{border-color:rgba(0,0,0,.2);border-top-color:currentColor}
.lb-promo{position:relative;border:1px solid rgba(19,182,228,.28);background:rgba(19,182,228,.07);border-radius:10px;padding:9px 10px 9px 28px;margin-bottom:8px}
.lb-promo .txt{font-size:11.5px;line-height:1.5;color:var(--lb-text2)}
.lb-promo .txt b{display:block;color:#fff;font-size:12.5px;margin-bottom:1px}
.lb-promo .btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px}
.lb-promo .x{position:absolute;left:4px;top:4px;width:22px;height:22px}
.lb-role{font-size:9.5px;line-height:14px;padding:0 5px;border-radius:4px;background:rgba(245,197,24,.16);color:#f5d264;flex:none}
.lb-more{display:flex;justify-content:center;margin:8px 0}

/* media bin */
.lb-drop{border:1.5px dashed #343b45;border-radius:10px;padding:12px;text-align:center;color:var(--lb-text3);margin-bottom:8px;transition:all .12s;font-size:11.5px}
.lb-drop b{color:var(--lb-text2);display:block;font-size:12.5px;margin-bottom:2px}
.fs-lib.filedrag .lb-drop{border-color:var(--lb-accent);background:rgba(19,182,228,.08);color:var(--lb-accent-hi)}
.lb-dropall{position:absolute;inset:0;z-index:30;background:rgba(10,14,18,.82);border:2px dashed var(--lb-accent);border-radius:10px;display:none;align-items:center;justify-content:center;
  flex-direction:column;gap:8px;color:var(--lb-accent-hi);font-size:14px;font-weight:700;pointer-events:none}
.fs-lib.filedrag .lb-dropall{display:flex}
.lb-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.lb-grid.g3{grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}
.lb-grid.g5{grid-template-columns:repeat(5,minmax(0,1fr));gap:5px}
.lb-card{position:relative;border-radius:9px;background:#0f1215;border:1px solid #262b33;overflow:hidden;cursor:pointer;display:flex;flex-direction:column}
.lb-card:hover{border-color:#3d4550}
.lb-card.used::before{content:"";position:absolute;top:6px;right:6px;width:7px;height:7px;border-radius:50%;background:var(--lb-accent-hi);z-index:3;box-shadow:0 0 0 2px rgba(0,0,0,.4)}
.lb-card .th{position:relative;aspect-ratio:16/10;background:#0b0d10;overflow:hidden;display:flex;align-items:center;justify-content:center}
.lb-card .th img,.lb-card .th canvas{width:100%;height:100%;object-fit:cover;display:block}
.lb-card .th .ph{color:#3d4550}
.lb-card .badge{position:absolute;left:5px;bottom:5px;font:10px/15px var(--mono,Consolas,monospace);padding:0 5px;border-radius:4px;background:rgba(0,0,0,.72);color:#fff;direction:ltr}
.lb-card .kind{position:absolute;right:5px;bottom:5px;width:18px;height:18px;border-radius:5px;background:rgba(0,0,0,.6);color:#fff;display:flex;align-items:center;justify-content:center}
.lb-card .nm{padding:5px 7px 6px;font-size:11px;color:var(--lb-text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;unicode-bidi:plaintext}
.lb-card .add{position:absolute;left:5px;top:5px;width:24px;height:24px;border-radius:6px;background:var(--lb-accent);color:#05222d;display:flex;align-items:center;justify-content:center;opacity:.88;transition:opacity .1s,transform .1s;border:0;cursor:pointer;z-index:4;box-shadow:0 1px 4px rgba(0,0,0,.45)}
.lb-card:hover .add,.lb-card .add:focus-visible{opacity:1}
.lb-card .add:hover{transform:scale(1.08)}
.lb-next{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;margin:0 0 8px;border-radius:9px;border:1px solid rgba(80,200,240,.35);background:rgba(80,200,240,.08);font-size:11.5px;line-height:1.45;color:var(--lb-text2)}
.lb-next b{color:#fff}
.lb-next .ic{flex:none;margin-top:1px;color:var(--lb-accent-hi)}
.lb-card .proc{position:absolute;inset:0;background:rgba(8,10,12,.62);display:flex;align-items:center;justify-content:center;gap:6px;color:#fff;font-size:11px}
.lb-card .err{position:absolute;inset:0;background:rgba(60,10,14,.6);display:flex;align-items:center;justify-content:center;color:#ff9a9e;font-size:11px;padding:6px;text-align:center}
.lb-up{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--lb-text2);margin-bottom:6px}
.lb-up .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:ltr;text-align:right}
.lb-up .bar{width:80px;height:4px;border-radius:2px;background:#252a31;overflow:hidden}
.lb-up .bar i{display:block;height:100%;background:var(--lb-accent)}

/* catalog tiles */
.lb-tile{display:flex;flex-direction:column;gap:4px;cursor:pointer;border-radius:9px;padding:4px;border:1px solid transparent;position:relative}
.lb-tile:hover{background:#1c2026;border-color:#2c323b}
.lb-tile .cv{width:100%;aspect-ratio:16/10;border-radius:7px;background:#0d0f12;display:block;overflow:hidden}
.lb-tile.sq .cv{aspect-ratio:1/1}
.lb-tile.wide .cv{aspect-ratio:2/1}
.lb-tile .nm{font-size:10.5px;color:var(--lb-text2);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.2}
.lb-tile .add{position:absolute;left:7px;top:7px;width:22px;height:22px;border-radius:6px;background:var(--lb-accent);color:#05222d;display:flex;align-items:center;justify-content:center;opacity:0;border:0;cursor:pointer}
.lb-tile:hover .add{opacity:1}
.lb-tile.cur{border-color:var(--lb-accent);background:rgba(19,182,228,.1)}
.lb-emoji{aspect-ratio:1/1;border-radius:8px;background:#13161a;border:1px solid #23282f;display:flex;align-items:center;justify-content:center;font-size:24px;cursor:pointer;
  font-family:"Segoe UI Emoji","Segoe UI",sans-serif}
.lb-emoji:hover{background:#1e2329;border-color:#3a414b;transform:scale(1.05)}
.lb-seg{display:flex;background:#101317;border:1px solid #2a3038;border-radius:8px;padding:2px;margin-bottom:8px}
.lb-seg button{flex:1;height:24px;border-radius:6px;border:0;background:transparent;color:var(--lb-text2);font:inherit;font-size:11.5px;cursor:pointer}
.lb-seg button.on{background:#262c34;color:#fff}
.lb-card-wide{display:flex;align-items:center;gap:10px;padding:8px;border-radius:9px;border:1px solid #262b33;background:#14171b;margin-bottom:8px}
.lb-card-wide .txt{flex:1;min-width:0;font-size:11.5px;color:var(--lb-text2);line-height:1.45}
.lb-card-wide .txt b{color:#fff;display:block;font-size:12.5px}
.lb-job{font-size:11.5px;color:var(--lb-text2);display:flex;align-items:center;gap:8px;margin:6px 0}
.lb-lic-md{direction:rtl;max-height:60vh;overflow:auto;font-size:12.5px;line-height:1.6;color:#d6dade;padding:4px 2px}
.lb-lic-md h1{font-size:16px;margin:4px 0 8px}.lb-lic-md h2{font-size:13.5px;margin:14px 0 6px;color:#fff}
.lb-lic-md ul{margin:4px 0;padding-inline-start:18px}.lb-lic-md code{font-family:var(--mono,Consolas,monospace);font-size:11px;background:#0f1215;padding:1px 4px;border-radius:4px;direction:ltr;unicode-bidi:embed}
.lb-lic-md table{border-collapse:collapse;width:100%;font-size:11.5px;margin-top:6px}.lb-lic-md td,.lb-lic-md th{border:1px solid #2c323b;padding:4px 6px;text-align:right}
.lb-lic-md th{background:#1b1f25}
/* caption style tiles: "name — detail" on two lines */
.lb-tile .nm.two{white-space:normal}
.lb-tile .nm.two small{display:block;font-size:9.5px;color:var(--lb-text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* selects never cut the file name: full width, ellipsis, room for the arrow */
.lb-select{height:30px;flex:1;min-width:0;text-overflow:ellipsis;padding-inline-start:9px;padding-inline-end:26px;cursor:pointer}
/* auto transcription not installed */
.lb-asr-off{display:flex;flex-direction:column;align-items:stretch;gap:8px;padding:10px;border-radius:9px;border:1px solid rgba(245,197,24,.3);background:rgba(245,197,24,.05);margin-bottom:10px}
.lb-asr-off .txt{font-size:11.5px;color:var(--lb-text2);line-height:1.55}
.lb-asr-off .txt b{display:flex;align-items:center;gap:6px;color:#fff;font-size:12.5px;margin-bottom:2px}
.lb-asr-off .lb-btn{justify-content:center;height:32px}
.lb-tag{font-size:10.5px;font-weight:600;color:#f5c518;background:rgba(245,197,24,.12);border-radius:6px;padding:1px 6px}
.lb-linkbtn{align-self:center;background:none;border:0;padding:0;color:var(--lb-text3);font:inherit;font-size:11px;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.lb-linkbtn:hover{color:var(--lb-text)}
.lb-asr-note{font-size:11px;color:var(--lb-text2);line-height:1.5;display:flex;gap:6px;align-items:flex-start}
.lb-asr-note:empty{display:none}
.lb-hint-line{font-size:11px;color:var(--lb-text3);margin:-2px 0 8px}
.lb-manual{margin-bottom:6px}
.lb-manual-box{padding:8px;border-radius:9px;border:1px solid #262b33;background:#14171b;margin:0 0 8px}
.lb-manual-box[hidden],.lb-manual-msg[hidden],.lb-check[hidden]{display:none}
.lb-manual-msg{font-size:11.5px;line-height:1.45;color:#fff;padding:6px 8px;margin-bottom:6px;border-radius:7px;background:rgba(80,200,240,.1);border:1px solid rgba(80,200,240,.3)}
.lb-input.lb-textarea{width:100%;height:auto;box-sizing:border-box;min-height:96px;resize:vertical;font-size:12.5px;line-height:1.5;padding:7px 8px;margin-bottom:6px;display:block}
.lb-check{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--lb-text2);margin:0 0 8px;cursor:pointer}
/* sound FX: one "סינון" button folds categories, length and folders */
.lb-filterbtn{height:30px;flex:none;display:inline-flex;align-items:center;gap:5px;padding:0 9px;border-radius:8px;border:1px solid #30363f;background:#171a1f;color:var(--lb-text2);font:inherit;font-size:12px;cursor:pointer}
.lb-filterbtn:hover{color:#fff;border-color:#3b424c}
.lb-filterbtn.on{border-color:var(--lb-accent);color:#fff}
.lb-filterbtn.active{color:var(--lb-accent-hi)}
.lb-filterbtn .lb-cnt{display:inline-block;min-width:16px;height:16px;line-height:16px;padding:0 4px;border-radius:8px;background:var(--lb-accent);color:#05222d;font-size:10.5px;text-align:center}
.lb-filters{border:1px solid #262b33;background:#13161a;border-radius:9px;padding:8px 8px 2px;margin-bottom:8px}
.lb-flbl{font-size:10.5px;color:var(--lb-text3);margin:0 2px 4px}
/* the tab rail fits small laptop screens (1366×768): tighter first, then icons only (labels stay as tooltips) */
@media (max-height:820px){
  .lb-tabs{gap:1px;padding:4px 3px}
  .lb-tab{padding:4px 2px 3px;gap:2px;font-size:10px}
  .lb-tab svg.ic{width:18px;height:18px}
}
@media (max-height:660px){
  .lb-tab span{display:none}
  .lb-tab{padding:6px 2px}
}
`;
