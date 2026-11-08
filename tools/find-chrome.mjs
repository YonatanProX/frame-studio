// Frame Studio — prints the browser used for the editor window and for exports (Chrome → Chromium → Edge), or nothing.
// Same detection as the server (server/config.mjs: env FRAME_STUDIO_CHROME → config.json "chrome" → per-OS search).
// Used by start.cmd.   node tools/find-chrome.mjs [--no-edge]
import { findChrome } from '../server/config.mjs';

const exe = findChrome({ allowEdge: !process.argv.includes('--no-edge') });
if (exe) process.stdout.write(exe + '\n');
process.exitCode = exe ? 0 : 1;
