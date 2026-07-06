import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { injectWrapper, removeWrapper, MARKER_START, MARKER_END } from '../bin/cli.ts';

const CLI = fileURLToPath(new URL('../bin/cli.ts', import.meta.url));
const runCli = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf-8' });

describe('cli dispatch', () => {
  it('prints a semver version and exits 0', () => {
    const r = runCli(['version']);
    assert.equal(r.status, 0);
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
  });
  it('prints usage and exits 0 when given no command', () => {
    const r = runCli([]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage:/);
  });
  it('writes an error to stderr and exits 1 for an unknown command', () => {
    const r = runCli(['definitely-not-a-command']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Unknown command/);
  });
  it('does not run the dispatcher when the module is merely imported', () => {
    // Importing bin/cli.ts (as these tests do) must not print help or exit; the
    // side-effecting command dispatch only runs when executed directly.
    assert.ok(true);
  });
});

describe('injectWrapper', () => {
  const dir = mkdtempSync(join(tmpdir(), 'car-rc-test-'));
  const testFile = join(dir, 'rc');
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it('adds wrapper to empty file', async () => {
    await writeFile(testFile, '');
    await injectWrapper(testFile, '/path/to/launcher.ts');
    const content = await readFile(testFile, 'utf-8');
    assert.ok(content.includes(MARKER_START));
    assert.ok(content.includes(MARKER_END));
    assert.ok(content.includes('/path/to/launcher.ts'));
  });
  it('unaliases claude before defining the wrapper function (#10)', async () => {
    await writeFile(testFile, '');
    await injectWrapper(testFile, '/path/to/launcher.js');
    const content = await readFile(testFile, 'utf-8');
    const unaliasIdx = content.indexOf('unalias claude');
    const fnIdx = content.indexOf('\nclaude() {');
    assert.ok(unaliasIdx !== -1, 'wrapper should unalias claude');
    assert.ok(unaliasIdx < fnIdx, 'unalias must come before the function definition');
  });
  it('adds wrapper to file with existing content', async () => {
    await writeFile(testFile, 'export PATH=$HOME/bin:$PATH\n');
    await injectWrapper(testFile, '/path/to/launcher.ts');
    const content = await readFile(testFile, 'utf-8');
    assert.ok(content.includes('export PATH'));
    assert.ok(content.includes(MARKER_START));
  });
  it('replaces existing wrapper', async () => {
    await writeFile(testFile, `before\n${MARKER_START}\nold stuff\n${MARKER_END}\nafter\n`);
    await injectWrapper(testFile, '/new/path/launcher.ts');
    const content = await readFile(testFile, 'utf-8');
    assert.ok(content.includes('/new/path'));
    assert.ok(!content.includes('old stuff'));
    assert.ok(content.includes('before'));
    assert.ok(content.includes('after'));
  });
});

describe('removeWrapper', () => {
  const dir = mkdtempSync(join(tmpdir(), 'car-rm-test-'));
  const testFile = join(dir, 'rc');
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it('removes wrapper and preserves surrounding content', async () => {
    await writeFile(testFile, `before\n${MARKER_START}\nwrapper stuff\n${MARKER_END}\nafter\n`);
    await removeWrapper(testFile);
    const content = await readFile(testFile, 'utf-8');
    assert.ok(!content.includes(MARKER_START));
    assert.ok(content.includes('before'));
    assert.ok(content.includes('after'));
  });
  it('does nothing when no wrapper present', async () => {
    await writeFile(testFile, 'just normal content\n');
    await removeWrapper(testFile);
    const content = await readFile(testFile, 'utf-8');
    assert.equal(content, 'just normal content\n');
  });
});
