# Frame Studio — מדריך עריכה לקלוד · Claude Editing Reference

> **למי זה:** לקלוד (ולמי שכותב סקריפטים), כדי לערוך סרטונים ב-Frame Studio בקוד — בלי לחקות לחיצות עכבר —
> בזמן שהבעלים צופה בעורך ויכול להמשיך לערוך ביד.
> **Who this is for:** Claude. Every edit is a JSON *operation* (op) sent to the local server; the editor window updates live.

---

## 0. כלל הזהב · The golden loop

```
cutx show <id>          ← 1. קרא את המצב הנוכחי (ייתכן שהבעלים ערך ביד!)
cutx ops <id> edit.json ← 2. ערוך בפעולות (עם --summary בעברית — מוצג לבעלים כהודעה)
cutx snapshot <id> --at 0.5,3,word:ובום! --scale 0.5   ← 3. צלם פריימים
Read <png>              ← 4. הסתכל בתמונות בעיניים
(תקן → חזור ל-2)        ← 5. תקן מה שלא טוב
cutx export <id>        ← 6. ייצוא: ‎-14 LUFS + בדיקת "הקול מעל הרקע" ≥ 12 dB
```

**English:** read state → apply ops → snapshot → *look at the PNGs* → fix → export. Never assume the timeline is
what you left it: the owner edits by hand too. Always `show` (or `show --json`) before a new round of edits.

כללים קבועים (מהסקיל של Chordix):
1. **אפקטים קוליים רק מהספרייה** (`library/sounds`). לא מסנתזים ווש/מכה/עולה.
2. **הדיבור תמיד נשמע:** בכל חלון דיבור הקול ≥ 12 dB מעל מוזיקה + אפקטים. `cutx export` ו-`cutx check-audio` מודדים, `cutx balance` מתקן (9.10).
3. **עוצמה סופית ‎-14 LUFS**, שיא אמיתי ≤ ‎-1 dBTP (ברירת המחדל של הייצוא).
4. **בדיקה בעיניים** של כל סצנה לפני ייצוא (snapshot + Read).
5. **הודעות לבעלים בעברית** — גם ה-summary של כל batch.

---

## 1. הפעלה מהירה · Quick start

```bat
cutx.cmd new chordix-06 --name "06 — טונציה" --size 9:16 --fps 30
cutx.cmd open chordix-06                      :: הבעלים רואה את העריכה בזמן אמת
cutx.cmd import chordix-06 "C:\...\render\video.mp4" "C:\...\vo.wav"
cutx.cmd show chordix-06
```

- `cutx.cmd` נמצא בשורש (`<Frame Studio>/cutx.cmd`). מ-Git Bash / macOS / Linux: `./cutx …` מתוך השורש.
- השרת עולה לבד ברקע אם הוא לא פעיל (`server/main.mjs`, פורט 7788). לוג: `server.log`.
- `--json` בכל פקודה = פלט מכונה. קוד יציאה: `0` הצלחה, `2` חלק מהפעולות נכשלו / יעד לא הושג, `1` שגיאה.
- נתיבים עם עברית ורווחים — תמיד במרכאות.

### כל הפקודות · All commands

| פקודה | מה עושה |
|---|---|
| `cutx help [פקודה\|ops\|שם-פעולה]` | עזרה; `cutx help ops` = כל הפעולות; `cutx help addCaptions` = שדות + דוגמה |
| `cutx health` | בדיקת השרת |
| `cutx projects` | רשימת פרויקטים |
| `cutx new <id> [--name] [--size 1080x1920\|9:16\|16:9\|1:1\|4:5] [--fps 30] [--empty]` | פרויקט חדש (ערוצי ברירת מחדל, אלא אם `--empty`) |
| `cutx show <id> [--json]` | ערוצים, קליפים (מזהה, סוג, ערוץ, התחלה–סוף, טקסט/שם, מעברים, אפקטים, קיפריימים), סמנים, משך, אזהרות |
| `cutx ops <id> <file.json\|-\|'[…]'> [--summary "…"] [--atomic]` | שליחת פעולות (מערך, `{ops:[…]}` או JSON ישיר) |
| `cutx import <id> <path…> [--copy] [--wait]` | ייבוא קבצים (proxy/waveform נבנים ברקע) |
| `cutx add <id> <type> <path\|text\|kind\|id> [--at] [--dur] [--track\|--role] [--set k=v …] [--id]` | הוספת קליפ אחד |
| `cutx sfx <id> "<query\|soundId\|path>" --at <t> [--gain] [--len] [--fade] [--from]` | אפקט קולי מהספרייה |
| `cutx sounds "<query>" [--category] [--collection] [--min] [--max] [--limit]` | חיפוש צלילים |
| `cutx catalog [transitions\|effects\|filters\|anims\|text-anims\|captions\|text-presets\|stickers\|shapes\|fonts\|luts]` | קטלוגים לפי מזהה |
| `cutx transcript <id> [<asr.json>] [--script "…" \| --script-file f] [--hot "א,ב"]` | זמני מילים (`[[w,s,e]…]`, `[{w,s,e}]`, או פלט faster-whisper). **עם `--script`: מילות התסריט הנכונות על זמני ה-ASR** (4.9.1); בלי `asr.json` — מיישר את התמלול הקיים |
| `cutx words <id>` | התמלול עם אינדקסים והפניה מוכנה לכל מילה (`word:ובום!:1`) |
| `cutx captions <id> [--asr f] [--script "…" \| --script-file f] [--style chordix] [--max 3] [--chunks 1,3,3] [--hot "א,ב"] [--y\|--yabs 330] [--hold 0.7] [--hook0] [--replace]` | כתוביות מהתמלול (עם `--script` — קודם מתקן את התמלול לפי התסריט) |
| `cutx transcribe <id> <mediaId\|path> [--captions] [--style] [--model small]` | תמלול מקומי בחינם (faster-whisper) |
| `cutx set <id> <clipId[,…]> key=value …` | עדכון שדות |
| `cutx move\|trim\|split\|remove\|dup <id> <clipId> …` | עריכה בסיסית |
| `cutx key <id> <clipId> <prop> <t> <v> [--ease spring] [--abs]` | קיפריים |
| `cutx transition <id> <clipId> <transitionId\|none> [--dur 0.5] [--param k=v]` | מעבר לקליפ הבא |
| `cutx effect <id> <clipId> <effectId> [--param k=v]` | אפקט לקליפ |
| `cutx marker <id> <t\|word:…> [label]` | סמן |
| `cutx undo\|redo <id>` | ביטול / ביצוע מחדש (היסטוריה בשרת, 300 צעדים) |
| `cutx snapshot <id> --at 0.5,3,word:ובום! [--scale 0.5] [--sheet] [--out dir]` | PNG לכל זמן — **קרא אותם** |
| `cutx export <id> [--out f.mp4] [--from a --to b] [--crf 18] [--lufs -14] [--no-check]` | ייצוא MP4 + דוח |
| `cutx check-audio <id>` | רק בדיקת מרווח הדיבור |
| `cutx balance <id> [--target 12] [--max-rounds 8] [--dry]` | **איזון אוטומטי** של הקול מול הרקע: הנמכה מקומית רק של הקליפים האשמים, עד שכל חלון דיבור ≥ target dB (9.10) |
| `cutx media <id>` · `cutx validate <id>` · `cutx time <id> <ref>` · `cutx wait <job>` | עזר |
| `cutx open [<id>]` | פתיחת חלון העורך |
| `cutx import-chordix <dir> [--id] [--name]` | ייבוא פרויקט מסדנת Chordix (video.json) |

---

## 2. מושגים · Concepts

### 2.1 פרויקט, ערוצים, קליפים

- **Project** = `projects/<id>/project.json`: `settings` (width, height, fps, background, safeArea, targetLufs…), `media`, `tracks`, `clips`, `markers`, `transcript`.
- **סדר הערוצים** = סדר התצוגה בציר, מלמעלה למטה. **הערוץ הראשון (index 0) מצויר מעל כולם.**
- **זמנים בשניות** (float). הציר רץ משמאל לימין גם בממשק העברי.
- **קואורדינטות:** `transform.x / transform.y` = היסט בפיקסלים של **מרכז הקליפ ממרכז הקנבס**; y חיובי = למטה.
  בקנבס 1080×1920 המרכז הוא (540, 960). **ממיקום מוחלט מלמעלה:** `y = yAbs − 960`. למשל כתוביות ב-y=330 מלמעלה → `transform.y = -630`.
- **אזור בטוח (reels):** 250px למעלה, 350px למטה, 80px בצדדים, ו-140px מימין בחצי התחתון — אל תשים טקסט חשוב שם.

### 2.2 תפקידי ערוצים · Track roles

| role | kind | שם ברירת מחדל | מה יש בו |
|---|---|---|---|
| `effects` | video | אפקטים | קליפי `effect` / `adjustment` — חלים על **כל מה שמתחתיהם** |
| `text` | video | טקסט | טקסטים, כותרות. ערוץ הכתוביות הוא `text` עם `captions:true` ושם "כתוביות" |
| `overlay` | video | שכבה | וידאו/תמונה מעל הראשי (PIP), צורות, מדבקות |
| `main` | video | ראשי | השוטים הראשיים |
| `voice` | audio | קריינות | קריינות (מפתח להנמכת מוזיקה) |
| `music` | audio | מוזיקה | מוזיקה |
| `sfx` | audio | אפקטים קוליים | ווש, בום, עולה… |

ערוצי ברירת מחדל: `t_text`, `t_overlay`, `t_main`, `t_voice`, `t_music`, `t_sfx`. ערוצים שנוצרים לפי צורך: `t_captions` (כתוביות), `t_effects` (אפקטים, תמיד למעלה).
אפשר להפנות לערוץ לפי **מזהה**, לפי **שם** ("כתוביות"), או לפי **תפקיד** (`"track":"main"`).

### 2.3 סוגי קליפים · Clip types

| type | משך ברירת מחדל | ערוץ אוטומטי | שדות עיקריים |
|---|---|---|---|
| `video` | אורך המדיה ÷ מהירות − in | ראשי (תפוס → שכבה → שכבה חדשה) | `mediaId`, `in`, `speed`, `reverse`, `volume`, `muteAudio`, `fit` |
| `image` | 3 שנ' | ראשי/שכבה | `mediaId`, `fit`, `animLoop:"kenBurns"` |
| `audio` | אורך המדיה | אפקטים קוליים (אלא אם `role`) | `volume` (ליניארי 0–4), `fadeIn`, `fadeOut`, `pan`, `audioFx` |
| `text` | 3 שנ' | טקסט | `text.{content,font,weight,size,color,stroke,shadow,background,glow,gradient,align,maxWidth}`, `textAnim` |
| `caption` | עד המקטע הבא | כתוביות | `caption.{words,style,activeColor,hotColor}` + `text` לעיצוב |
| `shape` | 2 שנ' | שכבה | `shape.{kind,w,h,fill,stroke,strokeWidth,radius,progressFrom,progressTo}` |
| `sticker` | 2 שנ' | שכבה | `sticker.{kind:"emoji"\|"builtin", value, size}` |
| `effect` | 1 שנ' | אפקטים (למעלה) | `effects:[{id,params}]` — חל על השכבות שמתחתיו |
| `adjustment` | 3 שנ' | אפקטים | `color`, `filter`, `lut`, `effects` — תיקון צבע לכל מה שמתחת |

---

## 3. זמנים · Time references

בכל מקום שמצפה לזמן (`start`, `at`, `end`, `from`, `to`, `t` של סמן, `t` של קיפריים עם `abs`) אפשר לכתוב:

| צורה | דוגמה | פירוש |
|---|---|---|
| מספר | `3.25` | שניות |
| מחרוזת מספר | `"3.25"`, `"2s"` | שניות |
| קוד זמן | `"00:03:15"` (MM:SS:FF) | 3 שנ' + 15 פריימים |
| מילה (אובייקט) | `{"word":"ובום!","n":1,"offset":-0.13,"edge":"start"}` | המופע ה-n (מ-0; ‎-1 = האחרון) של המילה בתמלול, ± היסט; `edge`: `start`/`end`/`center` |
| מילה (מחרוזת) | `"word:ובום!:1:-0.13"` · `"word:ובום!#1"` · `"word:אתר?:0:0:end"` | `word:<מילה>[:מופע[:היסט[:edge]]]` |
| מילה (מערך, כמו ב-video.json) | `["ובום!", 1, -0.13]` | `[מילה, מופע, היסט]` |
| סמן | `{"marker":"דרופ","offset":-0.5}` · `"marker:דרופ"` | זמן הסמן (לפי תווית או מזהה) |
| קליפ | `{"clip":"c_logo","edge":"end","offset":0.1}` · `"clip:c_logo:end:0.1"` | קצה של קליפ |
| סוף | `"end"` | סוף הפרויקט |

**התאמת מילים:** קודם התאמה מדויקת, אחר כך **בלי ניקוד, פיסוק, גרש/גרשיים וסימני כיווניות**. כך `{"word":"רגע"}` מוצא את `"רֶגַע!"`.
מילה שלא נמצאה מחזירה שגיאה עם הצעות ("אולי התכוונת ל: ובום!"). אם אין תמלול — משתמשים במילים של הכתוביות.
`cutx words <id>` מדפיס לכל מילה את ההפניה המדויקת. `cutx time <id> "word:ובום!:1"` מחשב זמן.

---

## 4. פעולות · Operations

שליחה: `cutx ops <id> file.json` (או `POST /api/projects/:id/ops {ops, by:"claude", summary}`).
כל פעולה מחזירה `{ok:true, id?, ids?, track?, warnings?}` או `{ok:false, error:"…"}`. **שגיאה בפעולה אחת לא עוצרת את השאר** —
אלא עם `--atomic` (`"atomic":true`): אז אם משהו נכשל, שום דבר לא נשמר. כל פעולה שנכשלה לא משאירה שינוי חלקי.
מזהים: כל פעולה שיוצרת משהו מקבלת `id` אופציונלי משלך (`"id":"hook"`), כך שפעולה מאוחרת יותר באותו batch יכולה להפנות אליו
(בפעולות שבהן `id` הוא המטרה — `splitClip`, `duplicateClip` — המזהה החדש הוא `newId`).

```json
{ "summary": "פתיחה: כותרת 'רגע!' עם מכה וזום",
  "ops": [
    { "op": "addClip", "type": "text", "id": "hook", "content": "רגע!", "at": {"word": "רגע!"}, "duration": 0.9,
      "y": -480, "animIn": "pop", "set": { "text.size": 180, "text.weight": 900, "text.stroke.width": 16 } },
    { "op": "sfx", "sound": "EffectiveTrailer_Booms_Vol2_011", "at": {"word": "רגע!", "offset": -0.05}, "gain_db": -8, "len": 2.5 },
    { "op": "setKeyframes", "id": "hook", "prop": "transform.scale", "keys": [ {"t":0,"v":1.3}, {"t":0.15,"v":1,"ease":"back"} ] }
  ] }
```

### 4.1 בחירת ערוץ אוטומטית וחפיפות · Auto track & overlap

בלי `track`: וידאו/תמונה → **ראשי** אם פנוי בזמן הזה, אחרת **שכבה** פנויה, אחרת **שכבה חדשה מעל**. טקסט → טקסט. כתובית → "כתוביות" (נוצר לפי צורך).
אודיו → אפקטים קוליים (או `role:"voice"|"music"`). אפקט/התאמה → ערוץ אפקטים עליון (נוצר באינדקס 0). צורה/מדבקה → שכבה.
`role` בוחר תפקיד במקום ברירת המחדל. ערוצים נעולים לא נבחרים אוטומטית.

`overlap` (ב-addClip, moveClip, duplicateClip, sfx, addCaptions):
| ערך | התנהגות |
|---|---|
| `newTrack` (ברירת מחדל) | אם הערוץ תפוס — ערוץ חדש מאותו תפקיד מעל (וידאו) / מתחת (אודיו). ראשי תפוס → שכבה |
| `allow` | לשים בכל זאת (חפיפה באותו ערוץ) |
| `overwrite` | לדרוס: מה שמתחת נחתך/מפוצל/נמחק (Premiere overwrite) |
| `insert` | לפתוח רווח: מה שמתחת מפוצל ונדחף קדימה בערוץ הזה (Premiere insert) |
| `error` | להיכשל אם תפוס |

התוצאה מחזירה `track` והאזהרה "נוצר ערוץ חדש…" כשזה קרה.

### 4.2 פרויקט וערוצים

```json
{ "op": "setSettings", "set": { "width": 1080, "height": 1920, "fps": 30, "background": "#071822", "safeArea": "reels", "targetLufs": -14, "masterGainDb": 0 } }
{ "op": "renameProject", "name": "06 — טונציה" }
{ "op": "addTrack", "kind": "audio", "role": "sfx", "name": "וושים", "id": "t_wh", "index": 7 }
{ "op": "updateTrack", "id": "t_music", "set": { "volume": 0.7, "muted": false, "hidden": false, "locked": false, "solo": false, "name": "שיר" } }
{ "op": "moveTrack", "id": "t_text", "index": 0 }
{ "op": "removeTrack", "id": "t_overlay" }
```
(`volume` של ערוץ ליניארי 0–4. ערוץ נעול חוסם עריכת הקליפים שבו, אלא עם `"force":true`.)

### 4.3 הוספת קליפים · addClip

```json
{ "op": "addClip", "type": "video", "path": "C:/…/render/video.mp4", "start": 0, "id": "main1", "muteAudio": true, "name": "וידאו מהסדנה" }
{ "op": "addClip", "type": "video", "mediaId": "m_ab12cd34", "start": 5.4, "in": 2.0, "duration": 3.2, "speed": 1.5 }
{ "op": "addClip", "type": "image", "mediaId": "m_logo", "start": "word:קורדיקס!", "end": "end", "fit": "contain", "animIn": "zoomIn", "animLoop": "breathe" }
{ "op": "addClip", "type": "audio", "mediaId": "m_vo", "start": 0, "role": "voice", "audioFx": { "voiceEnhance": true } }
{ "op": "addClip", "type": "audio", "mediaId": "m_song", "start": 0, "role": "music", "volume": 0.5, "fadeOut": 1.0, "audioFx": { "duckUnderVoice": true, "duckDb": -10 } }
{ "op": "addClip", "type": "text", "content": "חינם, נסו עכשיו", "start": 17.4, "duration": 2.6, "yAbs": 1290, "preset": "chordixBrand" }
{ "op": "addClip", "type": "shape", "kind": "roundrect", "start": 2, "duration": 1.5, "shape": { "w": 760, "h": 150, "fill": "#f2f8fb", "radius": 75 }, "y": 120 }
{ "op": "addClip", "type": "sticker", "value": "🔥", "start": 6.3, "x": 300, "y": -200, "animIn": "pop", "animLoop": "wobble" }
{ "op": "addClip", "type": "effect", "effect": "zoomPunch", "params": { "strength": 0.3 }, "at": {"word":"סולם!"}, "duration": 0.5 }
{ "op": "addClip", "type": "adjustment", "filter": "cinematic", "start": 0, "end": "end", "color": { "contrast": 0.1, "vibrance": 0.15 } }
{ "op": "addClip", "type": "caption", "words": [["שלום",1.0,1.3],["לכם!",1.35,1.8]], "style": "chordix", "hot": ["לכם"] }
```
- `path` (במקום `mediaId`) — השרת מייבא את הקובץ לפני ההפעלה. אפשר `"from"` כשם נרדף ל-`in`.
- קיצורים: `content` → `text.content`; `x`,`y`,`scale`,`rotation`,`opacity` → `transform.*`; `animIn:"pop"` → `{id:"pop"}`; `filter:"vivid"`; `lut:"teal-orange.cube"`;
  `gain_db` → `volume`; `fade` → `fadeOut`; `kind` (צורה); `value` (מדבקה; אימוג'י = emoji, מזהה לטיני = builtin); `effect` (+`params`) לקליפ אפקט.
- `end` במקום `duration`; `append:true` = מיד אחרי הקליפ האחרון בערוץ; `set:{…}` = עדכוני נתיב אחרי ההוספה.
- מיקום מוחלט: `xAbs` / `yAbs` (פיקסלים מהפינה השמאלית-עליונה של הקנבס, למרכז הקליפ) במקום `x` / `y` (היסט מהמרכז).
- `fit` ברירת מחדל לוידאו/תמונה: `cover` אם היחס קרוב לקנבס (±5%), אחרת `contain`.

### 4.4 עדכון · updateClip

```json
{ "op": "updateClip", "id": "hook", "set": { "text.content": "רגע אחד!", "text.color": "#3fe0f5", "transform.scale": 1.2, "animIn.id": "slamIn", "animIn.duration": 0.3 } }
{ "op": "updateClip", "ids": ["c_a","c_b"], "set": { "transform.opacity": 0.8 } }
{ "op": "updateClip", "id": "main1", "merge": { "color": { "contrast": 0.15, "saturation": 0.1 }, "audioFx": { "denoise": true } } }
```
- `set` = נתיב → ערך. ערכים מספריים/בוליאניים במחרוזת מומרים (`"1.5"`, `"true"`). ערכים מחוץ לטווח מוגבלים עם אזהרה (volume 0–4, opacity 0–1, color ‎-1..1, hue ‎-180..180).
- `set:{"start": …}` מזיז (כולל מילות הכתובית). `set:{"trackId": …}` מעביר ערוץ (רק לאותו סוג).
- `set:{"text":"שלום"}` = `text.content`; `set:{"color":"#ff0000"}` = צבע הקליפ בציר (`tint`); `filter:"noir"`, `animIn:"pop"` וכו' — קיצורים.
- אובייקט שלם ב-`set` (`"transform": {"x": 10}`) **מתמזג** עם הקיים.

### 4.5 מחיקה, הזזה, חיתוך, פיצול · remove / move / trim / split

```json
{ "op": "removeClip", "id": "c_old", "ripple": true }
{ "op": "removeClips", "ids": ["c_1","c_2"], "ripple": false }
{ "op": "moveClip", "id": "c_logo", "start": "word:קורדיקס!", "track": "t_overlay" }
{ "op": "moveClip", "id": "c_logo", "by": -0.2 }
{ "op": "moveClips", "ids": ["c_a","c_b","c_c"], "delta": 0.5 }
{ "op": "trimClip", "id": "shot2", "start": 5.6, "end": "word:מבנה!:0:0:end" }
{ "op": "trimClip", "id": "shot2", "head": 0.2, "tail": 0.1 }
{ "op": "slipClip", "id": "shot2", "by": 0.5 }
{ "op": "splitClip", "id": "shot2", "at": "word:קצב!", "newId": "shot2b" }
{ "op": "splitAt", "at": 9.8 }
{ "op": "duplicateClip", "id": "c_hit", "start": 12.0, "newId": "c_hit2" }
{ "op": "setSpeed", "id": "shot3", "speed": 2 }
{ "op": "detachAudio", "id": "shot1" }
{ "op": "closeGaps", "track": "main" }
{ "op": "rippleDelete", "from": 4.0, "to": 4.6 }
{ "op": "insertGap", "at": "word:ובום!:1", "duration": 0.5 }
```
- **trimClip** מעדכן את `in` במדיה לפי המהירות (גם בהפוך), לא חורג מאורך המדיה, ולא נכנס לקליפ השכן (אלא עם `overlap:"allow"`). קיפריימים שומרים זמן מוחלט.
- **splitClip** מחזיר `ids:[שמאל, ימין]`: מפצל קיפריימים כך שהתנועה רציפה **בדיוק** (גם spring/easeInOut — באמצעות ease מסוג `part(a,b,…)`),
  מחלק את מילות הכתובית, דעיכה-פנימה נשארת משמאל ודעיכה-החוצה מימין, המעבר עובר לחלק הימני, אנימציית כניסה משמאל ויציאה מימין, ולולאות ממשיכות באותה פאזה.
- **rippleDelete / insertGap** בלי `tracks` חלים על כל הערוצים וגם מזיזים **סמנים ותמלול**; עם `tracks:[…]` — רק אותם ערוצים.
- **setSpeed** משנה גם את המשך (כמו ב-CapCut), אלא אם `keepDuration:true`.

### 4.6 קיפריימים · Keyframes

```json
{ "op": "setKeyframe", "id": "shot2", "prop": "transform.scale", "t": 0.9, "v": 1.85, "ease": "spring" }
{ "op": "setKeyframe", "id": "shot2", "prop": "transform.scale", "t": "word:סולם!", "v": 1.85 }
{ "op": "setKeyframes", "id": "shot2", "prop": "transform.scale", "abs": true,
  "keys": [ {"t":"word:סולם!","v":1}, {"t":"word:סולם!:0:0.18","v":1.85,"ease":"easeOut"}, {"t":"word:קצב!","v":1,"ease":"easeInOut"} ] }
{ "op": "removeKeyframe", "id": "shot2", "prop": "transform.scale", "t": 0.9 }
{ "op": "clearKeyframes", "id": "shot2", "prop": "transform.scale" }
```
- `t` **יחסי לתחילת הקליפ**, אלא אם `abs:true` או שהזמן הוא הפניה (`word:`/`marker:`/`clip:`) — אז מוחלט.
- `v` חסר = הערך הנוכחי באותו רגע (כמו לחיצה על היהלום).
- **ה-ease של קיפריים חל על המקטע שמגיע אליו** (מהקיפריים הקודם אליו).
- מאפיינים: `transform.x|y|scale|scaleX|scaleY|rotation|opacity|anchorX|anchorY`, `volume`, `pan`, `color.<מפתח>`, `crop.l|t|r|b`,
  `effects.<אינדקס>.<פרמטר>`, `mask.x|y|w|h|rotation|feather`, `filter.amount`, `lut.amount`, `text.size|letterSpacing`, `shape.w|h|radius|strokeWidth|progressFrom|progressTo`.
- eases: `linear`, `easeIn`, `easeOut`, `easeInOut`, `hold`, `spring`, `bounce`, `back`, `elastic`, וגם `smooth`, `easeInQuad…easeInOutExpo`, `easeOutBack`, `springSoft`, `springBouncy`,
  `bezier(x1,y1,x2,y2)` (כמו CSS), `spring(zeta,omega)`, `part(a,b,<ease>)` (חלק מעקומה — נוצר אוטומטית בפיצול).

### 4.7 מעברים · Transitions

```json
{ "op": "setTransition", "id": "shot1", "transition": "zoomBlur", "duration": 0.35 }
{ "op": "setTransition", "id": "shot2", "transition": "flashWhite", "duration": 0.3, "params": {} }
{ "op": "removeTransition", "id": "shot1" }
```
המעבר מוגדר על **הקליפ היוצא** ופועל מול הקליפ שמתחיל **בדיוק בסופו באותו ערוץ** (±פריים), ממורכז על החיתוך (חצי לפני, חצי אחרי).
אין קליפ צמוד → שגיאה (או `force:true`). משך מוגבל ל-2× הקליפ הקצר. לאודיו אין מעברים — `fadeIn`/`fadeOut`.

### 4.8 אפקטים לקליפ · Effects

```json
{ "op": "addEffect", "id": "shot2", "effect": "shake", "params": { "strength": 0.4 }, "index": 0 }
{ "op": "updateEffect", "id": "shot2", "index": 0, "params": { "strength": 0.2 }, "enabled": true }
{ "op": "moveEffect", "id": "shot2", "from": 1, "to": 0 }
{ "op": "removeEffect", "id": "shot2", "index": 0 }
```
האפקטים חלים לפי הסדר על השכבה של הקליפ. קיפריימים `effects.<i>.<param>` מתעדכנים לבד כשמוסיפים/מוחקים/מזיזים אפקט.
לאפקט על **כל הפריים** (כולל כל השכבות שמתחת) — קליפ `effect` בערוץ האפקטים (4.3).

### 4.9 כתוביות · Captions

```json
{ "op": "setTranscript", "words": [["רֶגַע!",0.12,0.48],["יש",0.80,0.95],["לכם",0.97,1.20]] }
{ "op": "addCaptions", "words": "transcript", "style": "chordix", "chunks": [1,3,3,2], "hot": ["אקורדים","ובום!"], "yAbs": 330, "hook0": true }
{ "op": "addCaptions", "style": "pill", "maxWords": 3, "maxChars": 18, "y": 520, "replace": true }
{ "op": "styleCaptions", "style": "boxHighlight", "activeColor": "#13b6e4", "yAbs": 1250 }
{ "op": "setHotWords", "words": ["חינם"] }
{ "op": "setCaptionWord", "id": "c_cap3", "index": 2, "set": { "w": "אקורדים!", "hot": true } }
{ "op": "splitCaption", "id": "c_cap3", "index": 2 }
{ "op": "mergeCaptions", "ids": ["c_cap3","c_cap4"] }
```
- **מקטע = קליפ אחד** (1–6 מילים): מהרגע שהמילה הראשונה נאמרת עד שהמקטע הבא מתחיל; האחרון — עד סוף המילה האחרונה + `tail` (0.4).
- חלוקה אוטומטית: לא חוצה סוף משפט (`. ! ? …`), שובר אחרי פסיק (`commaBreak`, ברירת מחדל כן) ובהפסקה ארוכה (`pauseBreak` 0.6 שנ'),
  ובתוך כל משפט — הכי מעט מקטעים שעומדים ב-`maxWords` (3) ו-`maxChars` (18, בלי ניקוד), מאוזנים (4 מילים → 2+2).
- `chunks:[…]` = חלוקה מפורשת (כמו `chunks` ב-video.json). מילים שנשארו — חלוקה אוטומטית.
- `hot` = מילים מודגשות (צבע `hotColor`), מושוות **בלי ניקוד ופיסוק**. `hold` = כמה זמן מקסימום להשאיר אחרי המילה האחרונה (בשתיקות; ב-Chordix ‏0.7).
- `hook0:true` = המקטע הראשון כבר בפריים 0 (Chordix: **בכל סרטון חדש**). `gap` = רווח בין מקטעים. `replace:true` = מחליף כתוביות קיימות בטווח (בלי זה נוצר ערוץ כתוביות נוסף).
- מיקום: `y` (היסט מהמרכז) או `yAbs` (מלמעלה). ברירת מחדל: 14% מתחת למרכז.
- מילות הכתובית שומרות זמנים **מוחלטים** וזזות יחד עם הקליפ בכל הזזה/ripple.
- `addCaptions` בלי `words` (או `"transcript"`) משתמש בתמלול **כמו שהוא** — אותן מילים, אותו פיסוק. לכן קודם מתקנים את התמלול (4.9.1) ואז יוצרים כתוביות.

#### 4.9.1 תיקון התמלול לפי התסריט · Script ↔ ASR alignment

Whisper טועה בכתיב בעברית (`"וום,"` במקום `"ובום!"`, `"סלם,"` במקום `"סולם!"`, `"הכובץ"` במקום `"הקובץ"`), מאחד מילים (`"הולה"` = "לא עולה")
ומשמיט מילים קצרות ("רק"). לתסריט יש את המילים הנכונות, ל-ASR יש את הזמנים — `script` מחבר ביניהם:

```json
{ "op": "setTranscript", "words": [["רגע,",0.0,0.8],["יש",1.06,1.42],["לכם",1.42,1.64],["הולה",9.1,9.34],["וום,",12.0,12.16]], "script": "רגע! יש לכם לא עולה ובום!", "hot": ["ובום!"] }
{ "op": "setTranscript", "words": "transcript", "script": "רגע! יש לכם לא עולה ובום!" }
{ "op": "addCaptions", "words": "transcript", "style": "chordix", "replace": true }
```
- **התוצאה:** התמלול = מילות התסריט (מפוצל לפי רווחים, **עם הפיסוק**) עם זמני ה-ASR. הפניות כמו `word:ובום!` עובדות מיד.
- **איך:** יישור לפי **אותיות** (בלי ניקוד/פיסוק; אותיות סופיות = רגילות) בשיטת `build-video.py` / `server/chordix-import.mjs`
  (`shared/align.js`, `alignScriptToAsr`). מילה שה-ASR **איחד** (`"הולה"` ← "לא עולה") — הזמן מתחלק **לפי מספר האותיות** (לא 9.10–9.18, עולה 9.18–9.34);
  מילה שה-ASR **פיצל** (`"קור" "דיקס"`) — מתחילת הראשון עד סוף האחרון; מילה **שהושמטה** ("רק") — לרווח אמיתי אם יש, אחרת חולקת זמן עם השכנה האיטית יותר.
  מילת ASR שאין בתסריט (`"אממ"`) — מדולגת. מילה שתואמת 1:1 מקבלת **בדיוק** את זמני ה-ASR.
- `words:"transcript"` + `script` = יישור התמלול **הקיים** (למשל אחרי `cutx transcribe`). `mediaId` נשמר.
- התוצאה מחזירה `coverage` (חלק האותיות שהותאמו), `method` (`letters`; `index` = התסריט כמעט לא תואם — אזהרה!) ו-`changes` — כל תיקון (`"וום," → "ובום!"`).
  מתחת ל-75% התאמה — אזהרה: בדוק שזה התסריט של ההקלטה הזו.
- גם `addCaptions` מקבל `script` — מיישר רק לכתוביות, בלי לשנות את התמלול.

```bat
cutx transcript <id> vo3-asr.json --script-file "…\05-בלדה-עממית\video.json"   :: --script-file: טקסט, או JSON עם שדה "script" (video.json)
cutx transcript <id> --script "רגע! יש לכם שיר, …"                              :: יישור התמלול הקיים
cutx captions <id> --asr vo3-asr.json --script-file video.json --style chordix --chunks 1,3,3,2 --replace
```
הפלט מדפיס כל תיקון: `12.00  "וום," → "ובום!"`, `9.10  "הולה" → "לא עולה"`, `18.46  "להתחבר." → "רק להתחבר!"`.

### 4.10 אפקטים קוליים · sfx

```json
{ "op": "sfx", "sound": "Air zoom vacuum", "at": {"word":"סולם!","offset":-0.1}, "gain_db": -14, "len": 0.6, "fade": 0.1 }
{ "op": "sfx", "sound": "נבחרים לסושיאל/מיקסקיט/עולים/Cinematic trailer riser.wav", "at": {"word":"ובום!","n":1,"offset":-2.45}, "gain_db": -14, "len": 2.5 }
{ "op": "sfx", "sound": "a1b2c3d4e5f6", "at": 9.67, "gain_db": -10, "len": 3.5, "fade": 0.5, "from": 0.0, "name": "בראאם בדרופ" }
```
`sound` = חיפוש חופשי (הכי מתאים), מזהה צליל (`cutx sounds`), נתיב יחסי ל-`library/sounds` או נתיב מלא. השרת מאתר את הקובץ.
`gain_db` → עוצמה (0 = כמו בקובץ), `len` = משך, `fade` = דעיכה בסוף, `from` = היסט בתוך הקובץ (להתחיל קרוב לשיא). צליל שכבר בפרויקט ממוחזר.
חפיפה → ערוץ אפקטים קוליים נוסף (כמו ב-CapCut). **לבדוק את שיא הקובץ** (`peakDb` ב-`cutx sounds`) לפני שקובעים gain: קבצים שונים בעד 15 dB.

### 4.11 סמנים, מדיה · Markers, media

```json
{ "op": "addMarker", "t": {"word":"ובום!","n":1}, "label": "דרופ", "color": "#ff8a66", "id": "mk_drop" }
{ "op": "updateMarker", "id": "mk_drop", "set": { "t": 9.75 } }
{ "op": "removeMarker", "id": "דרופ" }
{ "op": "clearMarkers" }
{ "op": "removeMedia", "id": "m_old" }
```

### 4.12 כל הפעולות · Full op list

`setSettings, renameProject, addTrack, updateTrack, removeTrack, moveTrack, addClip, updateClip, removeClip, removeClips, moveClip, moveClips,
trimClip, slipClip, splitClip, splitAt, duplicateClip, pasteClips, setSpeed, detachAudio, closeGaps, setKeyframe, setKeyframes, removeKeyframe,
clearKeyframes, setTransition, removeTransition, addEffect, updateEffect, removeEffect, moveEffect, addCaptions, styleCaptions, setHotWords,
setCaptionWord, splitCaption, mergeCaptions, setTranscript, addMarker, updateMarker, removeMarker, clearMarkers, rippleDelete, insertGap, sfx,
addMedia, updateMedia, removeMedia` — `cutx help <op>` לשדות ודוגמה.

---

## 5. שדות קליפ לעדכון · Clip field paths

| נתיב | ערכים |
|---|---|
| `name`, `tint` (צבע בציר), `disabled` | |
| `start`, `duration`, `in`, `speed`, `reverse` | שניות; מהירות 0.05–100 |
| `transform.x/y` | px מהמרכז · `scale`, `scaleX`, `scaleY` · `rotation` (מעלות) · `opacity` 0–1 · `anchorX/Y` 0–1 · `flipX/Y` |
| `fit` | `contain` · `cover` · `fill` · `none` |
| `crop.l/t/r/b` | שבר מהמקור 0–0.95 |
| `blend` | `normal, multiply, screen, overlay, add, darken, lighten, softlight, difference` |
| `color.*` | `exposure, brightness, contrast, saturation, vibrance, temperature, tint, highlights, shadows, vignette, sharpen, grain, fade` (‎-1..1), `hue` (‎-180..180) |
| `filter.id`, `filter.amount` | מזהה מ-FILTERS, 0–1 |
| `lut.file`, `lut.amount` | שם קובץ ב-`library/luts` |
| `mask.*` | `type: none\|rect\|ellipse\|linear\|mirror`, `x,y,w,h` (שבר מהשכבה), `rotation`, `feather`, `invert` |
| `chroma.*` | `enabled, color, similarity, smoothness, spill` (מסך ירוק) |
| `animIn.id/duration`, `animOut.id/duration`, `animLoop.id/speed/intensity` | ראה §6 |
| `transitionOut.*` | דרך setTransition |
| `volume` (0–4 ליניארי; ‎-6 dB ≈ 0.5), `fadeIn`, `fadeOut`, `pan` (‎-1..1), `muteAudio` | אודיו |
| `audioFx.voiceEnhance/denoise/eqPreset/duckUnderVoice/duckDb` | שיפור קול, הנמכת מוזיקה מתחת לקריינות |
| `text.content/font/weight/size/color/align/lineHeight/letterSpacing/maxWidth/dir/italic/underline` | טקסט |
| `text.stroke.color/width`, `text.shadow.color/blur/x/y`, `text.background.color/opacity/padding/radius`, `text.glow.color/blur`, `text.gradient {from,to,angle}` | עיצוב טקסט |
| `textAnim.in/out/loop/inDuration/outDuration/perWord` | אנימציות טקסט (TEXT_ANIMS) |
| `caption.style/activeColor/hotColor/words` | כתוביות |
| `shape.*`, `sticker.*` | ראה 2.3 |

---

## 6. אנימציות קליפ · Clip animations (`animIn` / `animOut` / `animLoop`)

כניסה (במשך `animIn.duration` הראשונים) · יציאה (במשך `animOut.duration` האחרונים) · לולאה (כל הזמן, `speed`, `intensity`).
לקליפים במסך מלא (וידאו/תמונה) התנועות במלוא הקנבס; לטקסט/מדבקה/צורה — תנועות קצרות ועדינות עם דהייה.

| animIn | | animOut | | animLoop | |
|---|---|---|---|---|---|
| `none` | ללא | `none` | ללא | `none` | ללא |
| `fadeIn` | דהייה פנימה | `fadeOut` | דהייה החוצה | `pulse` | פעימה |
| `zoomIn` | זום פנימה (גדל למקום) | `zoomIn` | זום פנימה (לעבר הצופה) | `float` | ריחוף |
| `zoomOut` | זום החוצה (מתכווץ למקום) | `zoomOut` | זום החוצה | `shake` | רעידה |
| `slideLeft` | החלקה שמאלה | `slideLeft` | החלקה שמאלה | `wobble` | התנודדות |
| `slideRight` | החלקה ימינה | `slideRight` | החלקה ימינה | `spin` | סיבוב |
| `slideUp` | החלקה למעלה | `slideUp` | החלקה למעלה | `swing` | נדנוד |
| `slideDown` | החלקה למטה | `slideDown` | החלקה למטה | `heartbeat` | דופק |
| `pop` | קפיצה (קפיץ) | `popOut` | קפיצה החוצה | `flicker` | הבהוב |
| `bounceIn` | קפיצת גומי | `spinOut` | סיבוב החוצה | `kenBurns` | קן ברנס (זום ופאן איטיים) |
| `spinIn` | סיבוב פנימה | `blurOut` | טשטוש החוצה | `drift` | סחיפה |
| `blurIn` | טשטוש פנימה | `dropOut` | נפילה החוצה | `breathe` | נשימה |
| `dropIn` | נפילה עם קפיצות | `flipOut` | היפוך החוצה | `jiggle` | רטט |
| `swingIn` | נדנוד פנימה | `whipOut` | שוט החוצה | `bounce` | קפיצות |
| `flipIn` | היפוך פנימה | `glitchOut` | גליץ' החוצה | `glitch` | גליץ' מחזורי |
| `stretchIn` | מתיחה | `sinkOut` | שקיעה רכה | | |
| `glitchIn` | גליץ' פנימה | | | | |
| `whipIn` | שוט פנימה (טשטוש תנועה) | | | | |
| `riseIn` | עלייה רכה | | | | |
| `slamIn` | נחיתה חזקה + רעידה | | | | |

```json
{ "op": "updateClip", "id": "c_logo", "set": { "animIn": {"id":"slamIn","duration":0.35}, "animLoop": {"id":"breathe","speed":1,"intensity":1} } }
```

---

## 7. קטלוגים · Catalog ids

> המזהים כאן נלקחו ממודולי הרינדור (נובמבר 2026). **הרשימה החיה + פרמטרים וערכי ברירת מחדל:** `cutx catalog transitions` / `cutx catalog effects --json` וכו'.
> כל המעברים, האפקטים, הפילטרים, ה-LUT, הצורות והמדבקות הם קוד מקורי של Frame Studio — חופשיים לשימוש.
> כשהקטלוג טעון (בשרת ובעורך), מזהה לא מוכר נדחה עם רשימת המזהים הקיימים, ופרמטרים חסרים מקבלים ערכי ברירת מחדל.

**מעברים (TRANSITIONS, 54) — `setTransition.transition`** (משך ברירת מחדל בסוגריים):
- בסיסי: `crossfade` (0.5), `dipBlack`, `dipWhite`, `dipColor` (0.6), `flashWhite` (0.4), `blurDissolve` (0.6), `lumaDissolve` (0.8)
- החלקה: `slideLeft`, `slideRight`, `slideUp`, `slideDown`, `pushLeft`, `pushRight`, `pushUp`, `pushDown`, `coverLeft`, `coverRight`, `coverUp`, `coverDown` (0.5), `splitReveal` (0.6)
- ניגוב: `wipeLeft`, `wipeRight`, `wipeUp`, `wipeDown`, `wipeDiagonal` (0.5), `clockWipe`, `blinds` (0.7), `lightSweep` (0.6)
- זום: `zoomIn`, `zoomOut` (0.5), `zoomBlur` (0.45 — whip zoom), `crossZoom` (0.6)
- צורות: `circleOpen`, `circleClose`, `diamond` (0.6), `heartWipe`, `starWipe` (0.7), `squares`, `inkSpread` (0.8)
- דיגיטלי: `pixelate` (0.6), `glitch` (0.5), `rgbSplit` (0.45)
- קולנועי: `whipLeft`, `whipRight`, `whipUp`, `whipDown` (0.4 — טשטוש תנועה), `spin` (0.5), `swirl` (0.7), `ripple`, `filmBurn` (0.8), `shake` (0.5)
- תלת־ממד: `cube`, `doorway`, `pageFlip` (0.7)

**אפקטים (EFFECTS, 51) — `addEffect.effect` / קליפ `effect`:**
- טשטוש: `blur`, `directionalBlur`, `zoomBlur`, `radialBlur`, `sharpen`
- תנועה: `shake`, `zoomPunch` (`strength` 0–1, `time` משך, `at` התחלה), `whip`
- אור: `flash`, `strobe`, `flicker`, `lightLeak`, `glow`, `bloom`, `shine`, `spotlight`, `vignette`
- דיגיטלי: `glitch`, `rgbSplit`, `chromaticAberration`, `pixelate`, `mosaicBlocks`, `dither`
- רטרו: `scanlines`, `vhs`, `crt`, `filmGrain`
- מסגרות: `letterbox`, `splitScreen`, `tvOff`
- עיוות: `wave`, `mirror`, `kaleidoscope`, `fisheye`, `lensDistortion`, `shockwave`, `heatHaze`
- צבע: `invert`, `posterize`, `duotone`, `blackWhite`, `sepia`, `colorPop`, `rainbow`, `thermal`, `nightVision`
- אמנותי: `neonEdges`, `sketch`, `halftone`, `outline`, `dropShadow`

לאפקטים תלויי זמן יש `time`/`progress` מתחילת הקליפ. פרמטרים לכל אפקט: `cutx catalog effects`.

**פילטרים (FILTERS, 27) — `filter.id`:** טבעי: `natural, vivid, cleanSkin, summer, winter, warm, cool, golden` · קולנועי: `cinematic, tealOrange, dramatic, moody, bleach` ·
רטרו: `vintage, fadeMatte, film, retro80, pastel` · צבעוני: `sunset, neonNight, cyberpunk, forest` · מותג: `chordix` (ציאן/לילה) · שחור־לבן: `blackWhite, noir, silver, sepia`.

**LUT — `lut.file`:** `teal-orange.cube, warm-film.cube, cool-night.cube, bleach-bypass.cube, vintage-fade.cube, mono-contrast.cube, golden-hour.cube, chordix-cyan.cube` (`cutx catalog luts`).

**אנימציות טקסט (TEXT_ANIMS) — `textAnim.in/out/loop`** (וגם `perWord`, `inDuration`, `outDuration`):
- in: `fade, typewriter, typewriterWords, wordPop, wordSlideUp, wordSlideDown, wordFade, wordBlur, scaleWords, bounceWords, elasticWords, flipIn, spinIn, swingIn,
  karaokeFill, charFade, charDrop, charRise, trackingIn, glitchType, blurIn, zoomIn, zoomOut, popIn, springIn, slideUp, slideDown, slideLeft, slideRight, rise, stretchIn, dropIn`
- out: `fade, wordFadeOut, wordPopOut, wordSlideDown, wordSlideUp, spinOut, flipOut, charFadeOut, typeErase, scatterOut, blurOut, zoomOut, zoomIn, slideUp, slideDown, slideLeft, slideRight, dropOut`
- loop: `wave, waveWords, shimmer, pulse, heartbeat, breathe, float, swing, shake, wobble, jiggle, bounce, flicker, glowPulse, rainbow, glitch`

מילים עבריות זזות **כמילים שלמות** (לא נחשפות דרך קו מסכה). `textAnim` מנפיש את הטקסט עצמו (מילים/אותיות); `animIn/animOut/animLoop` (§6) מזיזים את כל הקליפ — אפשר לשלב.

**סגנונות כתוביות (CAPTION_STYLES, 14) — `style`:**

| style | מראה |
|---|---|
| `chordix` | Heebo 900, ‏98px, paper ‎#f2f8fb, קו מתאר כהה 14px וצל. המילה הנאמרת cyan ‎#3fe0f5, מודגשות coral ‎#ff8a66. כל מילה קופצת 1.28→1 ב-0.13 שנ' ועולה 30px בדיוק כשהיא נאמרת; המילים הבאות שומרות מקום |
| `chordixSlam` | כמו chordix, והמילה המודגשת "נוחתת" גדולה |
| `pill` | מלבן לבן מעוגל, טקסט שחור 800, מתחלף בפריים אחד |
| `kinetic` | מילים נכנסות בקפיץ מטשטוש; המודגשת כבדה וגדולה עם קו תחתון |
| `karaoke` | כל המקטע גלוי בלבן, המילה הפעילה צבועה ומוגדלת |
| `boldPop` | מילה אחת בכל פעם (מתוך המקטע), ענקית, קפיצה |
| `wordByWord` | מילה אחת בכל פעם, בלי אנימציה |
| `boxHighlight` | למילה הפעילה מלבן צבעוני מאחור |
| `highlighter` | מרקר צבעוני על המילה הפעילה |
| `minimal` | לבן עם צל רך, דהייה |
| `typewriter` | אותיות מופיעות לפי קצב הדיבור |
| `neon` | זוהר ניאון |
| `bounce` | נחיתה קופצנית |
| `softFade` | חשיפה רכה |

**סגנונות טקסט (TEXT_PRESETS, 38) — `preset` ב-addClip (טקסט):** בסיסי: `title, subtitle, body, minimalLight` · זוהר: `neonCyan, neonPink, fire` ·
קו מתאר: `outlineBold, outlineOnly` · רקע: `whitePill, blackBox, yellowHighlight, lowerThird, paperLabel, breaking, ctaButton, classicSubtitle` ·
צבע: `gradientPop, sunset, retro80, shimmerGold` · צל: `shadow3D, extrude3D` · מיוחד: `handwriting, quote, elegantSerif, comic` ·
מותג: `chordixBrand` (Heebo 900 paper + coral), `chordixUrl`, `bpmTag` · מספרים: `countdown, counterUp, percent, price` · דיגיטלי: `glitchTitle` ·
אנימציה: `typewriterNote, kineticWords, waveText`.

```json
{ "op": "addClip", "type": "text", "preset": "chordixBrand", "content": "חינם, נסו עכשיו", "start": "word:חינם,", "end": "end", "yAbs": 1290 }
```

**צורות — `shape.kind` / `kind` ב-addClip:** בסיסיות: `rect, roundrect, ellipse, line, arrow, star, triangle, heart, burst, progress`.
סגנונות מוכנים (כ-`kind` או `preset`): `card, glassCard, gradientCard, frame, circle, ring, dashedLine, arrowLeft, badge, highlightBar, progressLtr, progressStories, progressRing`.
פס התקדמות: `shape.progressFrom` → `shape.progressTo` לאורך הקליפ (ניתן גם לקיפריימים).

**מדבקות (STICKERS, 98) — `value` ב-addClip (מזהה מהקטלוג או האימוג'י עצמו):**
- וקטוריות (`builtin-<שם>`): `arrow, curvedArrow, circleHighlight, underlineSwoosh, starBurst, speechBubble, thoughtBubble, checkmark, xMark, bell, heart, fire, sparkles,
  clickCursor, fingerTap, magnifier, playButton, searchBar, subscribeButton, likeButton, musicNotes, lightning, exclamation, newBadge, pin, crown, timer, soundWave, recDot,
  chordBox, guitarPick, loading, swipeUp`
- אימוג'י (`emoji-<שם>`): fire🔥 joy😂 heartEyes😍 mindBlown🤯 scream😱 clap👏 raised🙌 thumbsUp👍 thumbsDown👎 redHeart❤️ hundred💯 sparkles✨ star⭐ party🎉 note🎵 notes🎶
  guitar🎸 piano🎹 mic🎤 headphones🎧 drum🥁 sax🎷 trumpet🎺 violin🎻 boom💥 zap⚡ eyes👀 thinking🤔 cool😎 partyFace🥳 sob😭 pray🙏 muscle💪 pointRight👉 pointLeft👈
  pointUp👆 pointDown👇 check✅ cross❌ warning⚠️ rocket🚀 bulb💡 chartUp📈 pushpin📌 bell🔔 speech💬 trophy🏆 crown👑 target🎯 starStruck🤩 sweat😅 heartHands🫶
  question❓ exclaim❗ loud🔊 phone📱 laptop💻 clapper🎬 alarm⏰ money💰 gift🎁 wink😉 shush🤫 salute🫡 wave👋

```json
{ "op": "addClip", "type": "sticker", "value": "builtin-searchBar", "start": 17.2, "duration": 2.8, "yAbs": 1080, "animIn": "pop" }
{ "op": "addClip", "type": "sticker", "value": "🔥", "at": "word:ובום!:1", "x": 320, "y": -300, "animIn": "slamIn", "animLoop": "wobble" }
```

**גופנים — `text.font`:** `Heebo` (100–900, משתנה), `Assistant`, ומערכת: `Arial, David, Frank Ruehl, Gisha, Rod, Segoe UI, Tahoma, Bahnschrift, Impact, Segoe UI Emoji` — `cutx catalog fonts`.

---

## 8. ספריית הצלילים · Sound library

`library/sounds/` (מקומי, בלי אינטרנט):
- **`Sonniss GDC 2026 - ספרייה מלאה/`** — כ-120 חבילות (344 Audio, Effective Trailer, …). רישיון Sonniss GDC: מסחרי, בלי קרדיט, לתמיד; אסור לאמן עליו בינה מלאכותית.
- **`נבחרים לסושיאל/סוניס-נבחרים/`** — `1 בומים ובראאאם`, `2 בס נופל`, `3 מכות וווש`, `4 מתח`, `5 ממשק ופולי`, `6 מכות וקרב`.
- **`נבחרים לסושיאל/מיקסקיט/`** — `ווש`, `עולים`. רישיון Mixkit: מסחרי ברשתות ובפרסומות, בלי קרדיט; אסור להפיץ את הקבצים עצמם.
- מוזיקה מקורית: תיקיות שמוגדרות ב-`library.music` ב-`config.json`.

`cutx sounds "whoosh"` · `cutx sounds "" --category "בומים ומכות"` · `cutx sounds braam --max 4`. שדות: `id`, `name`, `category` (עברית), `duration`, `peakDb`, `license`, `role`.

### מפת האפקטים של Chordix (ברירת מחדל, כמו בסרטון 05)

| רגע | `sound` | gain_db | len |
|---|---|---|---|
| מכה בפתיחה ("רגע!") | `EffectiveTrailer_Booms_Vol2_011` | ‎-8 | 2.5 |
| "לא נמצאו תוצאות" | `Bass Drop & Downer Fast 16` | ‎-12 | 2 |
| הטלפון נכנס | `Cinematic whoosh fast transition` | ‎-12 | 1.3 |
| הקובץ נוחת | `Woosh Sweep Slide Infographics Basic` | ‎-14 | 0.5 |
| מתח בזמן הניתוח | `Alarms_Vol2_QuarterNotes_013` | ‎-22 | 3.3 |
| "לא עולה לשרת" | `Impact Electric Tonal Deep Movement` | ‎-14 | 1.4 |
| זום (סולם / קצב / מבנה) | `Air zoom vacuum` | ‎-14 | 0.6 |
| עולה לפני הדרופ (2.45 שנ' לפני) | `Cinematic trailer riser` | ‎-14 | 2.5 |
| הדרופ ("ובום!") | `Cinematic Horn Braam … Huge-32` + `Bass Drop & Downer Medium 04` | ‎-10 / ‎-12 | 3.5 / 3 |
| זום בית / פזמון | `Fast whoosh transition` | ‎-18 | 1 |
| מעבר לנגינה | `Movie whoosh impact presentation` | ‎-14 | 1.5 |
| כרטיס הסיום | `Impact Hit Rapid Chord Reverb` | ‎-10 | 3.2 |

כללים: לא יותר מ-2 אפקטים חופפים; בום גדול רק בפתיחה, בדרופ ובסיום; אותו ווש עד 3 פעמים; מכה גדולה — **ברווח בין מילים** (פתח רווח עם `insertGap` אם צריך).

---

## 9. מתכונים · Recipes

### 9.1 בניית סרטון מאפס · Build a video from scratch

```bat
cutx new chordix-07 --name "07 — הקובץ לדף"
cutx import chordix-07 "C:\…\shots\a.mp4" "C:\…\shots\b.mp4" "C:\…\vo.wav" --wait
cutx show chordix-07          :: מזהי המדיה (m_…)
cutx transcript chordix-07 "C:\…\vo-asr.json"       :: או: cutx transcribe chordix-07 m_vo
cutx words chordix-07          :: הפניות מוכנות למילים
```
`build.json`:
```json
{ "summary": "בניית הסרטון: שוטים, קריינות, כתוביות, אפקטים",
  "ops": [
    { "op": "setSettings", "set": { "background": "#071822" } },
    { "op": "addClip", "type": "audio", "mediaId": "m_vo", "start": 0, "role": "voice", "id": "vo", "audioFx": { "voiceEnhance": true } },
    { "op": "addClip", "type": "video", "mediaId": "m_a", "start": 0, "end": "word:תסתכלו", "id": "s1", "animIn": "zoomOut" },
    { "op": "addClip", "type": "video", "mediaId": "m_b", "start": "word:תסתכלו", "end": "word:קורדיקס!", "id": "s2" },
    { "op": "addClip", "type": "image", "mediaId": "m_end", "start": "word:קורדיקס!", "end": "end", "id": "endcard", "fit": "contain" },
    { "op": "setTransition", "id": "s1", "transition": "whipLeft", "duration": 0.3 },
    { "op": "setTransition", "id": "s2", "transition": "flashWhite", "duration": 0.25 },
    { "op": "addCaptions", "style": "chordix", "maxWords": 3, "hot": ["אקורדים", "ובום!", "חינם"], "yAbs": 330, "hook0": true }
  ] }
```
```bat
cutx ops chordix-07 build.json
cutx snapshot chordix-07 --at 0,1.5,word:תסתכלו,word:ובום!:1,end --scale 0.5 --sheet
```
→ קרא את ה-PNG/דף המגע, תקן, ואז ייצוא (9.7).

### 9.2 כתוביות מתמלול · Captions from the voice-over word timings

1. זמני מילים בחינם: `cutx transcribe <id> m_vo` (faster-whisper מקומי + יישור לתחילת האנרגיה), או מקובץ קיים: `cutx transcript <id> vo-p-asr-snap.json`.
   **תמיד תקן לפי התסריט** (Whisper טועה בכתיב): `cutx transcript <id> --script "<התסריט>"` (או `--script-file video.json`) — ראה 4.9.1.
2. מקטעים לפי משמעות (כמו `chunks` ב-video.json): "יש לכם שיר," / "שאין לו אקורדים" / "באף אתר?"; מילה עם "!" — לבד.
```bat
cutx captions <id> --style chordix --chunks 1,3,3,2,3,1 --hot "אקורדים,ובום!,חינם" --yabs 330 --hook0 --hold 0.7 --replace
```
3. בהוק הכתובית ב-y≈880, ומהטלפון והלאה ב-y=330 (מוחלט):
```json
{ "op": "styleCaptions", "ids": ["c_cap1","c_cap2"], "yAbs": 880 }
```
4. בכרטיס הסיום אין כתוביות (הטקסט כבר על המסך): `cutx remove <id> <מזהי המקטעים של הסיום>`.
5. בדוק: `cutx snapshot <id> --at word:רגע!,word:אקורדים,word:ובום!:1`.

### 9.3 וושים על כל זום · A whoosh on every zoom

זום "אגרוף" על מילת מפתח (נכנס ב-0.15–0.2 שנ', 1.85×) + ווש שמתחיל 0.1 שנ' לפני המילה:
```json
{ "summary": "זומים עם וושים על סולם/קצב/מבנה",
  "ops": [
    { "op": "setKeyframes", "id": "s2", "prop": "transform.scale", "abs": true, "keys": [
      {"t":"word:סולם!","v":1}, {"t":"word:סולם!:0:0.18","v":1.85,"ease":"easeOut"},
      {"t":"word:קצב!","v":1.85}, {"t":"word:קצב!:0:0.15","v":1.6,"ease":"spring"},
      {"t":"word:מבנה!","v":1.6}, {"t":"word:מבנה!:0:0.2","v":1.3,"ease":"easeInOut"} ] },
    { "op": "sfx", "sound": "Air zoom vacuum", "at": "word:סולם!:0:-0.1", "gain_db": -14, "len": 0.6, "fade": 0.1 },
    { "op": "sfx", "sound": "Air zoom vacuum", "at": "word:קצב!:0:-0.1",  "gain_db": -14, "len": 0.6, "fade": 0.1 },
    { "op": "sfx", "sound": "Fast whoosh transition", "at": "word:מבנה!:0:-0.1", "gain_db": -18, "len": 1.0, "fade": 0.2 },
    { "op": "addClip", "type": "effect", "effect": "zoomPunch", "params": {"strength": 0.3}, "at": "word:סולם!", "duration": 0.45 },
    { "op": "addClip", "type": "effect", "effect": "zoomPunch", "params": {"strength": 0.3}, "at": "word:קצב!",  "duration": 0.45 },
    { "op": "addClip", "type": "effect", "effect": "zoomPunch", "params": {"strength": 0.15}, "at": "word:מבנה!", "duration": 0.45 }
  ] }
```
(מרכז הזום: `transform.anchorX/anchorY` או קיפריימים של `transform.x/y` כדי למשוך את המוקד למרכז המסך.)

### 9.4 בום בדרופ ועולה לפניו · Riser into a boom on the drop

"שקט ואז בום": רווח של ~0.5 שנ' לפני המילה, סוף העולה בתוך הרווח, הבראאם 0.13 שנ' לפני "ובום!", הבזק ואגרוף חזק.
```json
{ "summary": "דרופ: עולה, בראאם, בס נופל, הבזק",
  "ops": [
    { "op": "insertGap", "at": "word:ובום!:1:-0.05", "duration": 0.4 },
    { "op": "sfx", "sound": "Cinematic trailer riser", "at": "word:ובום!:1:-2.45", "gain_db": -14, "len": 2.5, "fade": 0.05 },
    { "op": "sfx", "sound": "Cinematic Horn Braam Huge-32", "at": "word:ובום!:1:-0.13", "gain_db": -10, "len": 3.5, "fade": 0.5 },
    { "op": "sfx", "sound": "Bass Drop & Downer Medium 04", "at": "word:ובום!:1:-0.13", "gain_db": -12, "len": 3, "fade": 0.4 },
    { "op": "addClip", "type": "effect", "effect": "flash", "at": "word:ובום!:1", "duration": 0.25 },
    { "op": "addClip", "type": "effect", "effect": "zoomPunch", "params": {"strength": 0.5}, "at": "word:ובום!:1", "duration": 0.6 },
    { "op": "addClip", "type": "effect", "effect": "shake", "params": {"strength": 0.6}, "at": "word:ובום!:1", "duration": 0.35 },
    { "op": "addMarker", "t": "word:ובום!:1", "label": "דרופ", "color": "#ff8a66" }
  ] }
```
(`insertGap` בלי `tracks` מזיז גם את התמלול, כך שהפניות המילים אחריו נשארות נכונות.)

### 9.5 מעברים בין שוטים · Transitions

השוטים צריכים להיגע (הסוף של אחד = ההתחלה של הבא באותו ערוץ). `closeGaps` מצמיד. אחר כך:
```bat
cutx transition <id> s1 zoomBlur --dur 0.35
cutx transition <id> s2 whipLeft --dur 0.3
cutx transition <id> s3 none
```
מעבר מהיר (0.2–0.35) מתאים לסושיאל; `crossfade`/`dipBlack` לרגעים רגועים; `glitch`/`rgbSplit` ל"שגיאה".

### 9.6 בדיקה בתמונות · Snapshot-and-look loop

```bat
cutx snapshot <id> --at 0.3,1.5,word:תסתכלו,word:סולם!:0:0.2,word:ובום!:1,end --scale 0.5 --sheet
```
הפקודה מדפיסה נתיבי PNG (ודף מגע עם `--sheet`) — **קרא כל אחד** וחפש: טקסט שנחתך/יוצא מהאזור הבטוח, כתובית מעל אלמנט חשוב,
מסך ריק/שחור, מילה עברית הפוכה, שוט לא נכון, זום שלא נוחת על המוקד. שנה ובדוק שוב לפני ייצוא. (`--scale 1` לבדיקת פרטים.)

### 9.7 ייצוא · Export (‎-14 LUFS, 12 dB speech margin)

```bat
cutx export <id> --out "C:\…\סרטונים\07-שם.mp4" --lufs -14
```
הדוח: משך, גודל, **LUFS** (יעד ‎-14 ± 1), **שיא אמיתי**, ו**"הקול מעל הרקע"** (מינימום/חציון בחלונות 0.1 שנ' שבהם יש דיבור, וזמני החלונות מתחת ל-12 dB).
קוד יציאה 2 = מרווח הדיבור לא עומד ביעד. **מה עושים:**
0. **`cutx balance <id>`** — מאזן אוטומטית (9.10), ואז שוב ייצוא. אם הוא מציע להזיז אפקט לרווח — עדיף לעשות זאת (ואז שוב `balance`).
1. אפקט שנופל על מילה — הזז אותו לרווח בין מילים (`moveClip … --by`), או `set <clip> volume=…` נמוך יותר (‎-3 dB ≈ ×0.71).
2. מוזיקה חזקה מתחת לדיבור — `audioFx.duckUnderVoice:true` על קליפ המוזיקה (`duckDb` ‎-10…‎-14), או קיפריימים של `volume` רק במקום הבעייתי.
3. לא להגביר את הקול מעבר ל-‎+6 dB (עיוות). שיפור קול: `audioFx.voiceEnhance:true`.
4. שוב `cutx check-audio <id>` (מהיר — שמע בלבד) עד ≥ 12 dB, ואז ייצוא.

בדיקה מהירה של קטע: `cutx export <id> --from 8 --to 12 --out C:\…\test.mp4`.

### 9.8 ייבוא מסדנת Chordix · Import a workshop project

```bat
cutx import-chordix "05-בלדה-עממית"  :: יחסי לתיקיית הסדנה ב-config.json (chordix.workshop), או נתיב מלא --id chordix-05 --name "05 — בלדה עממית"
```
נוצר פרויקט עם: הוידאו המרונדר (מושתק, עם כתוביות צרובות — "וידאו מהסדנה"), קריינות, מוזיקה, כל אפקט מ-`video.json.sfx` כקליפ (שם = cue),
תמלול, ערוץ כתוביות **מוסתר** (כי הכתוביות כבר צרובות), וסמנים לכל beat. משם עורכים כרגיל (למשל להחליף אפקט, להזיז מכה, ולייצא מחדש).

### 9.9 תיקונים · Fix-ups

- טעות? `cutx undo <id>` (גם הבעלים רואה). `cutx redo <id>`.
- מחיקת קטע מכל הציר (כולל תמלול/סמנים): `{ "op": "rippleDelete", "from": 4.0, "to": 4.6 }`.
- פתיחת עצירה בקריינות שכבר בציר: `{ "op": "insertGap", "at": "word:קצב!:0:-0.05", "duration": 0.35 }` — מפצל את קליפ הקריינות (וכל קליפ שחוצה את הרגע) ופותח שתיקה בכל הערוצים; התמלול והסמנים זזים איתו. לחתוך **בשקט שבין מילים** (קצת לפני תחילת המילה), לא באמצע מילה.
- הבעלים שינה משהו? `cutx show <id>` מראה את המצב העדכני; בנה את הפעולות הבאות לפי המזהים שבו.

### 9.10 איזון אוטומטי של הקול מול הרקע · `cutx balance` (ה"מאזן" של Chordix)

הכלל: **בכל חלון דיבור (0.1 שנ') הקול ≥ 12 dB מעל מוזיקה + אפקטים.** `cutx balance` עושה את מה שהמאזן של `build-video.py` עשה — מקומית ובלי לגעת בקול:

```bat
cutx balance <id>                      :: יעד 12 dB, עד 8 סבבים
cutx balance <id> --target 14 --max-rounds 4
cutx balance <id> --dry                :: רק התוכנית: אילו קליפים, באילו זמנים, כמה dB — בלי לשנות כלום
```
**הלולאה:** `check-audio` → לכל חלון שנכשל: מי מהקליפים שאינם קריינות נשמע שם (אודיו בערוצי מוזיקה/אפקטים, וגם וידאו עם סאונד),
וכמה כל אחד תורם — לפי צורת הגל (`cache/peaks`) × `volume` × קיפריימים × דעיכות × עוצמת הערוץ × הנמכת `duckUnderVoice` (אותו מודל כמו המנוע) →
**מנמיכים רק את האשמים** (הכי חזקים, עד שמה שנשאר זניח): קיפריימים של `volume` — שקע שמכסה את החלון ±0.1 שנ' עם רמפות של 0.05 שנ',
עומק = **החוסר + 1 dB** (יותר, אם גם קליפים שלא הונמכו תורמים), שקעים קרובים (≤ 0.2 שנ') מתמזגים. קיפריימים קיימים נשמרים (העקומה מוכפלת בשקע;
מקטעי ease מפוצלים בדיוק), `fadeIn/fadeOut` לא נוגעים. כל סבב = batch אחד עם summary **"איזון קול מול רקע (סבב N)"** (by claude — אפשר `undo`) → בדיקה שוב.
עוצרים כשעומד ביעד או אחרי `--max-rounds`. **הקול לא מוגבר לעולם.**

**הדוח:** כל סבב (מינימום/חציון/מספר חלונות), סה"כ ההנמכות לכל קליפ (אזורים, שניות, העומק המרבי), המינימום והחציון הסופיים.
**אפקט שיושב בעיקר על דיבור** (> 50% מהאנרגיה שלו בזמן מילים) — הצעה להזיז אותו לרווח בין מילים, עם הפקודה:
`cutx move <id> c_boom 0.66  (ואז שוב cutx balance <id>)` — עדיף מבום מונמך ב-28 dB.
קוד יציאה: `0` עומד ביעד, `2` לא הגענו (הדוח אומר איפה; שקול להזיז אפקט, `duckUnderVoice` למוזיקה, או `gain` נמוך יותר). ערוץ **נעול** — לא מונמך (מדווח).

דוגמה (`e2e-demo`): לפני — מינימום ‎-15.1 dB ב-1.3 שנ' (הבום של הפתיחה + המוזיקה), 65 חלונות מתחת ליעד; אחרי 2 סבבים — מינימום 12.2 dB, חציון 15.0 dB, 0 חלונות;
`cutx export` מאשר: "מרווח הדיבור תקין".

---

## 10. HTTP API (ישירות, בלי CLI)

| Method | Path | גוף / תשובה |
|---|---|---|
| GET | `/api/health` | `{ok, version, root, port}` |
| GET/POST | `/api/projects` | רשימה / `{id?, name, width?, height?, fps?, tracks?:"default"\|"empty"}` → project |
| GET/DELETE | `/api/projects/:id` | project / העברה ל-`.trash` |
| POST | `/api/projects/:id/ops` | `{ops, by:"claude", summary, atomic?}` → `{rev, results, project}` |
| POST | `/api/projects/:id/undo` · `/redo` | `{rev, project}` |
| POST | `/api/projects/:id/import` | `{paths, copy?}` → `{media}` (status processing → SSE `media`) |
| POST | `/api/projects/:id/transcribe` | `{mediaId\|path, model?, captions?:{…addCaptions}}` → job |
| POST | `/api/projects/:id/snapshot` | `{times, scale?, sheet?}` → job |
| POST | `/api/projects/:id/export` | `{out?, from?, to?, fps?, crf?, preset?, lufs?, check?}` → job |
| GET | `/api/jobs/:job` · `/api/jobs/:job/wait` | מצב משימה (progress, outputs, report) |
| GET | `/api/library/sounds?q=&category=&collection=&min=&max=&limit=` | חיפוש צלילים |
| GET | `/api/library/sounds/categories` · `/api/library/fonts` · `/api/library/luts` · `/api/library/licenses` | |
| GET | `/api/events?project=:id` | SSE: `project`, `media`, `job`, `hello` |
| POST | `/api/open` · `/api/import-chordix` | חלון עורך / ייבוא סדנה |

כל עריכה של קלוד נשלחת עם `by:"claude"` — בעורך מופיעה הודעה "קלוד ערך: <summary>" והקליפים שהשתנו מהבהבים.

---

## 11. תקלות נפוצות · Troubleshooting

| הודעה | פתרון |
|---|---|
| `המילה "X" לא נמצאה בתמלול` | `cutx words <id>`; השתמש בהפניה שהוא מדפיס, או במופע הנכון (`:1`) |
| `אין קליפ צמוד אחרי …` (מעבר) | הקליפים לא נוגעים — `closeGaps` / `trimClip` / `moveClip`, ואז שוב |
| `הערוץ "…" נעול` | הבעלים נעל — שאל לפני `force:true` או `updateTrack locked:false` |
| `הקובץ … עוד לא יובא` | שלח דרך השרת (`cutx ops`) — השרת מייבא נתיבים; או `cutx import` ואז `mediaId` |
| `לא ניתן לאתר את הצליל …` | `cutx sounds "<חיפוש>"` ושימוש במזהה/נתיב יחסי |
| קליפ ב"ערוץ חדש" שלא ציפית לו | הזמן היה תפוס; `overlap:"overwrite"` / `"allow"` / `"insert"` לפי הכוונה |
| כתוביות כפולות | `addCaptions … replace:true` או `cutx remove` לערוץ הכתוביות הישן |
| `השרת לא פעיל` | `cutx health`; השרת עולה לבד מ-`server/main.mjs`; לוג ב-`server.log` |
