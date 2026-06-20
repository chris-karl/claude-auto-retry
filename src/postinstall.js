// Runs after `npm install`. Restores the exec bit on node-pty's spawn-helper
// (see ensureNativeHelperExecutable in pty.js for why it gets stripped). The
// launcher also self-heals at runtime, so this is just defense-in-depth — and
// it must NEVER fail the install, hence the catch-all and clean exit.
import { ensureNativeHelperExecutable } from './pty.js';

try {
  ensureNativeHelperExecutable();
} catch {
  // Swallow everything: a perms fix is not worth breaking `npm install` over.
}
