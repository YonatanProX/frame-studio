# רישיונות — Frame Studio

התוכנה עובדת בלי אינטרנט ולא מעלה שום דבר לשום מקום. מה שאתם יוצרים בה שלכם.
הקוד של Frame Studio מופץ ברישיון MIT (הקובץ `LICENSE` בשורש). כאן מפורט מה מותר לעשות עם כל סוג של חומר בספרייה.
(English summary at the bottom.)

## אפקטים קוליים — לא כלולים במאגר

המאגר **לא מפיץ שום קובץ שמע**. כל משתמש מוריד את הספריות בעצמו לתיקייה `library/sounds/`
(הוראות ב-`library/sounds/README.md`), והתיקייה הזו לא נכנסת ל-git. כך הרישיונות של הספריות נשמרים.

### Sonniss · חבילות ‎#GameAudioGDC

תיקייה: כל תיקייה תחת `library/sounds/` (מומלץ בשם שמכיל "Sonniss"). הורדה: https://sonniss.com/gameaudiogdc

- **ללא תמלוגים (Royalty-free)**, בכל העולם. מותר לשימוש **אישי ומסחרי**, בכל מספר פרויקטים, בלי הגבלת זמן: סרטוני רשתות, פרסומות, יוטיוב, סרטים, משחקים.
- **בלי קרדיט.** לא צריך לציין את Sonniss או את יוצרי הצלילים.
- **אסור למכור את הצלילים כמו שהם** — רק כחלק מיצירה שלכם. אסור להציג את ההקלטה המקורית כיצירה שלכם.
- **אסור להשתמש בצלילים כדי לאמן בינה מלאכותית** (סעיף NO AI TRAINING בחבילות האחרונות).
- הנוסח המחייב: `License - GDC Game Audio.pdf` שמגיע עם החבילה.

### Mixkit Sound Effects (רשות)

תיקייה: תיקייה שבשם שלה מופיעה המילה "Mixkit" (למשל `library/sounds/Mixkit/`). הורדה: https://mixkit.co/free-sound-effects/

- **רישיון Mixkit Sound Effects Free License**: חינם לשימוש מסחרי ואישי בתוך פרויקטים, **בלי קרדיט**.
- **אסור להפיץ את הקבצים כמו שהם** (למשל להעלות אותם כספריית צלילים או למכור אותם בנפרד).
- הנוסח המחייב נמצא באתר mixkit.co.

### מוזיקה וקריינות שלכם

תיקיות שמוגדרות ב-`config.json` תחת `"library": {"music": […]}` (או בקובץ הישן `library/sources.json`): קבצים שלכם, בבעלותכם.
בממשק הם מסומנים "שלי". הם לא נכנסים למאגר.

## מעברים, אפקטים, פילטרים, אנימציות, מדבקות, צורות ו-LUT

- כולם **קוד מקורי של Frame Studio** (שיידרים, ציור וקטורי וחישוב צבע שנכתבו מאפס). לא נלקח שום נכס של צד שלישי.
- הקוד מופץ ברישיון **MIT**. מה שהם מייצרים בסרטון שלכם — **חופשי לשימוש** בכל סרטון, כולל מסחרי, בלי קרדיט.
- קובצי ה-LUT ב-`library/luts/` (teal-orange, warm-film, cool-night, bleach-bypass, vintage-fade, mono-contrast, golden-hour, chordix-cyan) נוצרים על ידי הקוד (`tools/make-luts.mjs`, ונוצרים מחדש אוטומטית אם נמחקו). מותר להשתמש בהם גם מחוץ לתוכנה, לפי MIT.
- מדבקות האימוג'י מצוירות בגופן Segoe UI Emoji של Windows שבמחשב שלכם, ולכן חל עליהן רישיון הגופן (בהמשך).

## גופנים

- **Heebo** ו-**Assistant** (`library/fonts/`): רישיון **SIL Open Font License 1.1** — הנוסח המלא ב-`library/fonts/OFL.txt`, וזכויות היוצרים ב-`library/fonts/FONTS.md`.
  חופשי לשימוש בכל תוצר, כולל מסחרי. מותר להטמיע אותם בסרטונים ובקבצים. אסור למכור את קובצי הגופן עצמם.
- **גופני Windows** (Arial, David, Frank Ruehl, Gisha, Rod, Segoe UI, Tahoma, Bahnschrift, Impact, Segoe UI Emoji): **לא כלולים במאגר**. העורך קורא אותם מההתקנה של Windows.
  הם מורשים לכם יחד עם Windows. מותר להשתמש בהם כדי ליצור תוצרים (טקסט בתוך סרטון או תמונה). אסור להעתיק את קובצי הגופן ולהפיץ אותם.

## סיכום מהיר

| מקור | במאגר? | מסחרי | קרדיט | מגבלה עיקרית |
|---|---|---|---|---|
| Sonniss GDC | לא — מורידים בעצמכם | מותר | לא צריך | אסור למכור את הצלילים כמו שהם; אסור לאמן עליהם בינה מלאכותית |
| Mixkit | לא — מורידים בעצמכם | מותר | לא צריך | אסור להפיץ את הקבצים עצמם |
| מוזיקה וקריינות שלכם | לא | שלכם | — | — |
| מעברים, אפקטים, פילטרים, מדבקות, LUT | כן (קוד) | מותר | לא צריך | קוד ברישיון MIT |
| Heebo, Assistant | כן | מותר | לא צריך | SIL OFL: אסור למכור את קובצי הגופן |
| גופני Windows | לא | מותר בתוצרים | לא צריך | אסור להפיץ את קובצי הגופן |

---

## English summary

- **Code** (server, renderer, editor, CLI, shaders, effects, transitions, filters, stickers, shapes, LUT generator): MIT, see `LICENSE`.
  What it renders into your videos is yours to use, commercially, without credit.
- **Sound effects are not distributed with this repository.** Download them yourself into `library/sounds/`
  (see `library/sounds/README.md`):
  - *Sonniss #GameAudioGDC bundles* — royalty-free, personal + commercial use, no attribution; you may not sell the
    sounds as they come or claim authorship of the recordings; no AI training. Binding text: the PDF in the bundle.
  - *Mixkit Sound Effects Free License* — free for commercial and personal projects, no attribution; do not
    redistribute the files themselves. Binding text: mixkit.co.
- **Your own music / voice folders** configured in `config.json` → `library.music` stay on your machine.
- **Fonts**: Heebo and Assistant are bundled under the SIL Open Font License 1.1 (`library/fonts/OFL.txt`,
  attribution in `library/fonts/FONTS.md`). Windows system fonts are not bundled; they are used from your Windows install.
