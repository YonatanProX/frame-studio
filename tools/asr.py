# Frame Studio — local, free transcription with per-word timestamps (faster-whisper on the CPU).
# Run it with cwd = the audio folder and RELATIVE file names
# (absolute Hebrew paths break this python):
#     python -u asr.py <input.wav> <output.json> [model=small] [language=he]
# stdout: one JSON object per line (ASCII-escaped): {"stage":...} / {"progress":0..1} / {"done":true,"count":N}
# output.json: [[word, start, end], ...]  (UTF-8)
import sys, json, subprocess

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass


def say(**k):
    print(json.dumps(k, ensure_ascii=True), flush=True)


def main():
    if len(sys.argv) < 3:
        say(error='usage: asr.py <input> <output.json> [model] [language]')
        sys.exit(2)
    src, out = sys.argv[1], sys.argv[2]
    model_name = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else 'small'
    lang = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else 'he'

    say(stage='load', model=model_name)
    import numpy as np
    from faster_whisper import WhisperModel
    model = WhisperModel(model_name, device='cpu', compute_type='int8')

    say(stage='decode')
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', src, '-f', 's16le', '-ac', '1', '-ar', '16000', '-'],
                         capture_output=True, check=True).stdout
    pcm = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
    dur = len(pcm) / 16000.0
    say(stage='transcribe', duration=round(dur, 2))

    segs, _info = model.transcribe(pcm, language=lang, word_timestamps=True, beam_size=5, vad_filter=False)
    words = []
    for s in segs:
        for w in (s.words or []):
            t = w.word.strip()
            if t:
                words.append([t, round(w.start, 2), round(w.end, 2)])
        if dur > 0:
            say(progress=round(min(1.0, s.end / dur), 3))

    with open(out, 'w', encoding='utf-8') as f:
        json.dump(words, f, ensure_ascii=False)
    say(done=True, count=len(words))


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as e:
        say(error='ffmpeg failed: ' + (e.stderr or b'').decode('utf-8', 'replace')[-400:])
        sys.exit(3)
    except Exception as e:  # report to the server instead of a bare traceback
        say(error='%s: %s' % (type(e).__name__, e))
        sys.exit(1)
