# Sound effects · אפקטים קוליים

**English** · [עברית](#עברית)

## Out of the box

Frame Studio comes with a **Starter Pack of 24 original sound effects**: whooshes, pops, clicks, a ding, a
notification, booms, risers, a bass downer, a glitch, typing, a camera shutter, a swipe, a success chime and a sparkle.
They are synthesized by `tools/make-starter-sounds.mjs` the first time the editor starts (into
`library/sounds/Starter Pack/`), so the repository itself ships no audio. They are original and MIT-licensed: use them
in any video, commercial too, no credit needed.

## Add your own sounds (nothing is copied or moved)

In the editor: **Audio → Sound effects → "Add a sound folder"** (or the folder button at the top of the panel).
Pick any folder on your computer: Downloads, another drive, an external disk. Frame Studio only **reads** it.
Nothing is copied, moved or written into it. The folder is scanned in the background and its sounds show up while
it is being scanned. You can remove it from the same list at any time (your files are not touched).

- Files longer than 45 seconds in a sound folder appear under **Audio → Music & voice-over** (unless they are clearly
  sound effects, e.g. a Sonniss ambience).
- A folder on a drive that is unplugged is shown as "not found". Its sounds come back, without re-scanning, when the
  drive is plugged in again.
- Formats: `.wav .mp3 .flac .ogg .m4a .aif .aiff`, any depth.
- Claude uses the same library: `cutx sounds "<query>"`, and the `sfx` op picks sounds by description.
- For scripts: `GET /api/library/folders`, `POST /api/library/folders {"path":"D:/Sounds"}`,
  `DELETE /api/library/folders {"path":"D:/Sounds"}`.

## Free, legal sound libraries

### Sonniss #GameAudioGDC bundles (recommended)

Every year Sonniss gives away several gigabytes of professional sound effects. Download page:
**https://sonniss.com/gameaudiogdc** (the editor's "Download a free sound pack" button opens it). Download, unzip
anywhere, then "Add a sound folder". License summary (the binding text is the PDF inside the bundle): royalty-free,
personal **and commercial** use, **no attribution**. You may not sell the sounds as they come or claim the recordings
as your own, and recent bundles forbid using them to train AI.

### Mixkit sound effects (optional)

**https://mixkit.co/free-sound-effects/**, under the Mixkit Sound Effects Free License: free for commercial and
personal projects, no attribution. Do not redistribute the files themselves.

Sounds from a folder whose path contains "Sonniss" or "Mixkit" get the matching license badge in the editor.
The repository never includes these files (their licenses do not allow redistribution). `.gitignore` keeps everything
in this folder except this README out of git.

---

## עברית

### מה יש מההתחלה

Frame Studio מגיע עם **חבילת פתיחה של 24 אפקטים קוליים מקוריים**: וושים, פופים, קליקים, דינג, התראה, בומים,
רייזרים, בס נופל, גליץ׳, הקלדה, צמצם מצלמה, החלקה, צליל הצלחה ונצנוץ. הם נוצרים מקוד (`tools/make-starter-sounds.mjs`)
בהפעלה הראשונה של העורך, לתוך `library/sounds/Starter Pack/`, ולכן המאגר עצמו לא כולל קובצי שמע. הצלילים מקוריים
וברישיון MIT: מותר להשתמש בהם בכל סרטון, גם מסחרי, בלי קרדיט.

### הוספת צלילים משלכם (בלי להעתיק ובלי להזיז)

בעורך: **אודיו ← אפקטים קוליים ← "הוסף תיקיית צלילים"** (או כפתור התיקייה בראש הלוח).
בוחרים כל תיקייה במחשב: הורדות, כונן אחר, דיסק חיצוני. Frame Studio רק **קורא** אותה. שום דבר לא מועתק, לא מוזז
ולא נכתב לתוכה. התיקייה נסרקת ברקע, והצלילים מופיעים כבר תוך כדי. אפשר להסיר אותה מאותה רשימה בכל רגע
(הקבצים שלכם לא נמחקים).

- קבצים ארוכים מ-45 שניות מופיעים ב**אודיו ← מוזיקה וקריינות** (אלא אם ברור שהם אפקט, כמו אווירה של Sonniss).
- תיקייה בכונן שלא מחובר מסומנת "לא נמצאה". כשמחברים אותו שוב הצלילים חוזרים בלי סריקה מחדש.
- פורמטים: `.wav .mp3 .flac .ogg .m4a .aif .aiff`, בכל עומק.
- קלוד משתמש באותה ספרייה: `cutx sounds "<חיפוש>"`, ופעולת `sfx` בוחרת צליל לפי תיאור.

### ספריות צלילים חינמיות וחוקיות

**Sonniss ‏#GameAudioGDC** (מומלץ): כמה ג׳יגה של אפקטים מקצועיים בחינם בכל שנה, בכתובת **https://sonniss.com/gameaudiogdc**
(הכפתור "הורד חבילת צלילים חינמית" בעורך פותח את הדף). הורידו, חלצו לאן שנוח, ולחצו "הוסף תיקיית צלילים".
תקציר הרישיון (הנוסח המחייב הוא קובץ ה-PDF שבחבילה): ללא תמלוגים, לשימוש **אישי ומסחרי**, **בלי קרדיט**. אסור
למכור את הצלילים כמו שהם או להציג את ההקלטות כיצירה שלכם, ובחבילות האחרונות אסור לאמן עליהם בינה מלאכותית.

**Mixkit** (רשות): **https://mixkit.co/free-sound-effects/**. חינם לשימוש מסחרי ואישי, בלי קרדיט. אסור להפיץ את
הקבצים עצמם.

צלילים מתיקייה שבנתיב שלה מופיעה המילה Sonniss או Mixkit מקבלים בעורך את תג הרישיון המתאים.
המאגר אף פעם לא כולל את הקבצים האלה (הרישיונות שלהם לא מתירים הפצה). `.gitignore` משאיר את כל מה שבתיקייה הזו,
חוץ מהקובץ הזה, מחוץ ל-git.
