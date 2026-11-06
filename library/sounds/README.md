# Sound effects library · ספריית אפקטים קוליים

**English** · [עברית](#עברית)

Frame Studio indexes **whatever audio files you put in this folder** (`.wav .mp3 .flac .ogg .m4a .aif .aiff`, any depth)
and makes them searchable in the editor's *Sound FX* tab, in `cutx sounds "<query>"` and in the `sfx` op that Claude uses.

**This repository ships no audio.** The free libraries recommended below allow you to use the sounds inside your own
videos, but their licenses do not allow handing out the raw sound files — so every user downloads them personally,
and `.gitignore` keeps everything in this folder (except this README) out of git.

## Recommended free, legal sources

### 1. Sonniss #GameAudioGDC bundles (recommended)

Every year Sonniss gives away a multi-gigabyte bundle of professional sound effects (booms, whooshes, risers, impacts,
UI clicks, foley, ambiences…). Download page: **https://sonniss.com/gameaudiogdc** (you download it yourself; the site
asks you to accept its license).

License summary (read the `License - GDC Game Audio.pdf` that comes with the bundle — it is the binding text):

- royalty-free, worldwide, for **personal and commercial** projects, unlimited projects, no time limit;
- **no attribution** required;
- you may **not sell the sound effects as they come** (only as part of your own project), and may not claim
  authorship of the original recordings;
- the recent bundles **forbid using the sounds to train AI** models.

How to install: unzip the bundle and put its pack folders inside one folder whose name contains **Sonniss**, e.g.

```
library/sounds/
  Sonniss GDC 2026/
    344 Audio - Bass Drops & Downers Vol. 1/…wav
    Epic Stock Media - …/…wav
```

The indexer reads the UCS category prefix of each file name (`DSGNBoom_…`, `WHSH_…`, `UI_…`) and files it under a
Hebrew/English category (booms, whooshes, risers, UI, foley…). A full bundle is several GB; indexing it the first time
takes a few minutes and is cached in `library/sounds/index.json`.

### 2. Mixkit sound effects (optional)

**https://mixkit.co/free-sound-effects/** — short, social-media-friendly whooshes, risers and hits under the Mixkit
Sound Effects Free License (free for commercial and personal projects, no attribution; you may not redistribute the
files as they are). Check the license on mixkit.co before use. Put them in a folder whose name contains **Mixkit**,
e.g. `library/sounds/Mixkit/whoosh/…` — the editor then shows them with a *Mixkit* license badge.

### 3. Your own sounds

Anything else you own can go here too. Your own **music and voice-over** folders do not need to be copied: list them in
`config.json` → `"library": { "music": ["D:/My music"] }` and they appear in the *Audio* tab, marked "mine".

## Notes

- Files are only read, never modified or copied.
- To force a re-index: open `/api/library/sounds?rebuild=1` or delete `index.json`.
- Licensing details for everything else in the editor (fonts, LUTs, effects): [`../LICENSES.md`](../LICENSES.md).

---

## עברית

Frame Studio מאנדקס **כל קובץ שמע שתשימו בתיקייה הזו** (`.wav .mp3 .flac .ogg .m4a .aif .aiff`, בכל עומק),
ומאפשר לחפש אותו בלשונית "אפקטים קוליים" בעורך, ב-`cutx sounds "<חיפוש>"` ובפעולת `sfx` שבה קלוד משתמש.

**המאגר לא כולל שום קובץ שמע.** הספריות החינמיות שמומלצות כאן מתירות להשתמש בצלילים בתוך הסרטונים שלכם,
אבל הרישיונות שלהן לא מתירים להפיץ את קובצי הצליל עצמם — לכן כל משתמש מוריד אותם בעצמו, וקובץ ה-`.gitignore`
משאיר את כל מה שבתיקייה הזו (חוץ מהקובץ הזה) מחוץ ל-git.

### 1. חבילות Sonniss ‏#GameAudioGDC (מומלץ)

בכל שנה Sonniss מחלקת בחינם חבילה של כמה ג'יגה של אפקטים קוליים מקצועיים (בומים, וושים, עולים, מכות, לחיצות ממשק,
פולי, אווירה…). דף ההורדה: **https://sonniss.com/gameaudiogdc** (מורידים בעצמכם ומאשרים את הרישיון באתר).

תקציר הרישיון (הנוסח המחייב הוא הקובץ `License - GDC Game Audio.pdf` שמגיע עם החבילה):

- ללא תמלוגים, לשימוש **אישי ומסחרי**, בכל מספר פרויקטים, בלי הגבלת זמן;
- **בלי קרדיט**;
- **אסור למכור את הצלילים כמו שהם** (רק כחלק מיצירה שלכם), ואסור להציג את ההקלטות המקוריות כיצירה שלכם;
- בחבילות האחרונות **אסור לאמן על הצלילים מודלים של בינה מלאכותית**.

התקנה: פורסים את החבילה ושמים את תיקיות החבילות בתוך תיקייה אחת שבשם שלה מופיעה המילה **Sonniss**, למשל
`library/sounds/Sonniss GDC 2026/344 Audio - Bass Drops & Downers Vol. 1/…`.
העורך מזהה את קידומת הקטגוריה (UCS) בשם כל קובץ (`DSGNBoom_…`, `WHSH_…`, `UI_…`) ומסדר לפי קטגוריות בעברית.
אינדוקס ראשון של חבילה מלאה לוקח כמה דקות ונשמר ב-`library/sounds/index.json`.

### 2. אפקטים של Mixkit (רשות)

**https://mixkit.co/free-sound-effects/** — וושים, עולים ומכות קצרים שמתאימים לרשתות, לפי רישיון Mixkit Sound Effects
Free License (חינם לשימוש מסחרי ואישי, בלי קרדיט, אסור להפיץ את הקבצים כמו שהם). בדקו את הרישיון באתר לפני שימוש.
שימו אותם בתיקייה שבשם שלה מופיעה המילה **Mixkit**, למשל `library/sounds/Mixkit/whoosh/…`, והעורך יציג אותם עם תג Mixkit.

### 3. צלילים שלכם

אפשר לשים כאן גם כל צליל אחר שבבעלותכם. את תיקיות **המוזיקה והקריינות** שלכם לא צריך להעתיק: מוסיפים אותן
ב-`config.json` תחת `"library": { "music": ["D:/המוזיקה שלי"] }` והן מופיעות בלשונית "אודיו" עם התג "שלי".

- הקבצים רק נקראים — לא משתנים ולא מועתקים.
- אינדוקס מחדש: `/api/library/sounds?rebuild=1` או מחיקת `index.json`.
- רישיונות של כל השאר (גופנים, LUT, אפקטים): [`../LICENSES.md`](../LICENSES.md).
