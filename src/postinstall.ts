// Runs after `npm install`. Restores the exec bit on node-pty's spawn-helper
// (see ensureNativeHelperExecutable in pty.ts). The launcher also self-heals at
// runtime, so this is defense-in-depth — and it must NEVER fail the install.
import { ensureNativeHelperExecutable } from './pty.ts';

try {
  ensureNativeHelperExecutable();
} catch {
  // A perms fix is not worth breaking `npm install` over.
}
