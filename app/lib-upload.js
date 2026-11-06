// Frame Studio — upload files from Explorer into the current project (agent L).
// POST /api/projects/:id/upload?name=<file name>  (raw body) → Media | {media:[Media]}

import { api, state } from './api.js';

export const MEDIA_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|wmv|mts|m2ts|png|jpe?g|webp|gif|bmp|tiff?|heic|avif|svg|wav|mp3|m4a|aac|flac|ogg|opus|aiff?|wma)$/i;

function normalizeMediaResponse(res) {
  if (!res) return [];
  if (Array.isArray(res)) return res;
  if (Array.isArray(res.media)) return res.media;
  if (res.media && typeof res.media === 'object') return [res.media];
  if (res.id && res.kind) return [res];
  return [];
}

/** Upload one File with progress (XHR). Resolves Media[] (usually one). */
export function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const pid = state.projectId || (state.project && state.project.id);
    if (!pid) { reject(new Error('אין פרויקט פתוח')); return; }
    const xhr = new XMLHttpRequest();
    xhr.open('POST', api.url(`/api/projects/${encodeURIComponent(pid)}/upload?name=${encodeURIComponent(file.name)}`));
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { data = null; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(normalizeMediaResponse(data));
      else reject(new Error((data && data.error) || `ההעלאה נכשלה (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('אין חיבור לשרת — ההעלאה נכשלה'));
    xhr.send(file);
  });
}

/** Upload many files sequentially. onEach(file, progress0..1, media|null, error|null). Resolves Media[]. */
export async function uploadFiles(files, onEach) {
  const out = [];
  for (const f of files) {
    try {
      const media = await uploadFile(f, (pr) => onEach && onEach(f, pr, null, null));
      out.push(...media);
      if (onEach) onEach(f, 1, media[0] || null, null);
    } catch (e) {
      if (onEach) onEach(f, 1, null, e);
    }
  }
  return out;
}

/** Import absolute paths (no copy by default). Resolves Media[]. */
export async function importPaths(paths, { copy = false } = {}) {
  const pid = state.projectId || (state.project && state.project.id);
  if (!pid) throw new Error('אין פרויקט פתוח');
  const res = await api.post(`/api/projects/${encodeURIComponent(pid)}/import`, { paths, copy });
  return normalizeMediaResponse(res);
}

/** Files from a DataTransfer that look like media. */
export function mediaFilesOf(dt) {
  const files = dt && dt.files ? [...dt.files] : [];
  return files.filter((f) => MEDIA_EXT.test(f.name) || /^(video|audio|image)\//.test(f.type || ''));
}
