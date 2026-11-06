import json, io, os, re, difflib, sys
P = sys.argv[1]
C = json.load(io.open(os.path.join(P, 'video.json'), encoding='utf-8'))
heb = lambda s: re.sub(r'[^א-תA-Za-z0-9]', '', s)
A = json.load(io.open(os.path.join(P, C['asr']), encoding='utf-8'))
chars, times = [], []
for tok, s, e in A:
    t = heb(tok)
    for k, ch in enumerate(t):
        chars.append(ch); times.append(s + (e - s) * (k + 0.5) / max(1, len(t)))
words = re.split(r'[ \t\r\n]+', C['script'].strip())
S = ''.join(heb(x) for x in words); Aj = ''.join(chars)
m = [None] * len(S)
for a, b, n in difflib.SequenceMatcher(None, S, Aj, autojunk=False).get_matching_blocks():
    for k in range(n): m[a + k] = times[b + k]
known = [i for i, x in enumerate(m) if x is not None]
for i in range(len(m)):
    if m[i] is None:
        lo = max([k for k in known if k < i], default=None); hi = min([k for k in known if k > i], default=None)
        m[i] = m[lo] if hi is None else m[hi] if lo is None else m[lo] + (m[hi] - m[lo]) * (i - lo) / (hi - lo)
w, p = [], 0
for x in words:
    n = len(heb(x)); s, e = m[p], m[p + n - 1]; p += n
    w.append([x, round(s - 0.05, 3), round(e + 0.05, 3)])
for i in range(len(w) - 1): w[i][2] = min(w[i][2], w[i + 1][1])
json.dump(w, sys.stdout, ensure_ascii=False)
