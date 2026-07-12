// Runs after `npm install`. Restores the exec bit on node-pty's prebuilt
// `spawn-helper` (dropped whenever node_modules is copied/zipped/perm-stripped);
// without it the launcher degrades to an unmonitored session ("posix_spawnp failed.").
//
// Standalone plain JS, duplicating src/pty.ts's ensureNativeHelperExecutable rather
// than importing it: once installed the package lives under node_modules (Node won't
// run .ts there), and postinstall can run before `prepare` builds dist/. The launcher
// self-heals the same way at runtime, so this is defense-in-depth — NEVER fail install.
import { chmodSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const EXEC_BITS = 0o111; // owner/group/other execute — mirrors src/pty.ts

try {
  if (process.platform !== 'win32') {
    const require = createRequire(import.meta.url);
    let root = null;
    try {
      // require.resolve('node-pty') -> <root>/lib/index.js (its package `main`).
      root = dirname(dirname(require.resolve('node-pty')));
    } catch {
      // node-pty not resolvable (e.g. optional/skipped) — nothing to fix.
    }
    if (root) {
      const candidates = [
        join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
        join(root, 'build', 'Release', 'spawn-helper'),
        join(root, 'build', 'Debug', 'spawn-helper'),
      ];
      for (const helper of candidates) {
        try {
          const { mode } = statSync(helper);
          if ((mode & EXEC_BITS) !== EXEC_BITS) chmodSync(helper, mode | EXEC_BITS);
        } catch {
          // missing candidate or unwritable — best effort, keep going
        }
      }
    }
  }
} catch {
  // A perms fix is not worth breaking `npm install` over.
}
