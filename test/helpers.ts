import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import type { ScreenAdapter } from '../src/monitor.ts';

type MockScreen = ScreenAdapter & { _sent: string[]; _escaped: number; _content: string };

// failSend: send() throws (PTY gone). escapeShows: what the screen renders after an
// Escape (default: unchanged, i.e. the Escape did not dismiss what is on screen).
export function mockScreen(content = '', { failSend = false, escapeShows }: { failSend?: boolean; escapeShows?: string } = {}): MockScreen {
  const s: MockScreen = {
    _sent: [], _escaped: 0, _content: content,
    capture: async () => s._content,
    send: async (text) => {
      if (failSend) throw new Error('PTY destroyed');
      s._sent.push(text);
    },
    sendEscape: async () => {
      s._escaped++;
      if (escapeShows !== undefined) s._content = escapeShows;
    },
  };
  return s;
}

// Load a config from raw file contents written to a temp dir.
export async function loadFromRaw(raw: string): Promise<Config> {
  const dir = await mkdtemp(join(tmpdir(), 'car-cfg-'));
  const f = join(dir, 'config.json');
  await writeFile(f, raw);
  try { return await loadConfig(f); } finally { await rm(dir, { recursive: true, force: true }); }
}

export const loadFrom = (obj: unknown): Promise<Config> => loadFromRaw(JSON.stringify(obj));
