// Test stub of render/compositor.js (agent A tests only): deterministic 2D drawing, same interface.
export class Compositor {
  constructor(canvas, { mode = 'export', scale = 1 } = {}) { this.canvas = canvas; this.mode = mode; this.scale = scale; this.g = null; }
  setProject(p) {
    this.p = p;
    this.w = p.settings.width; this.h = p.settings.height;
    if (this.canvas.width !== this.w) this.canvas.width = this.w;
    if (this.canvas.height !== this.h) this.canvas.height = this.h;
    this.g = this.canvas.getContext('2d', { willReadFrequently: true });
    let end = 0; for (const c of Object.values(p.clips || {})) end = Math.max(end, c.start + c.duration);
    this.dur = end || 1;
  }
  setScale(s) { this.scale = s; }
  async renderFrame(t) {
    await new Promise((r) => setTimeout(r, 0));
    const g = this.g, w = this.w, h = this.h;
    g.fillStyle = '#000000'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#3b82f6'; g.fillRect(0, 0, w, Math.round(h * 0.06));
    const bar = Math.round((t / this.dur) * (w - 40));
    g.fillStyle = '#ffffff'; g.fillRect(bar, Math.round(h * 0.3), 40, Math.round(h * 0.4));
    g.fillStyle = '#ff4d6d'; g.font = `bold ${Math.round(h / 16)}px Arial`; g.textAlign = 'center';
    g.fillText(t.toFixed(2) + 's', w / 2, h * 0.9);
  }
  renderFrameSync(t) { this.renderFrame(t); }
  readPixels() { return new Uint8Array(this.g.getImageData(0, 0, this.w, this.h).data.buffer); }
  hitTest() { return null; }
  clipBounds() { return null; }
  dispose() {}
}
