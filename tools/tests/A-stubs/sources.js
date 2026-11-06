// Test stub of render/sources.js (agent A tests only).
export class SourceProvider {
  constructor(opts) { this.opts = opts; }
  setProject(p) { this.p = p; }
  getSync() { return null; }
  async getExact() { return null; }
  startPlayback() {} stopPlayback() {} tick() {} preloadAround() {}
  dispose() {}
}
