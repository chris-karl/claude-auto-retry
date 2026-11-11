import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { injectWrapper, removeWrapper, MARKER_START, MARKER_END, WRAPPER_TEMPLATE, FISH_WRAPPER_TEMPLATE, PS_WRAPPER_TEMPLATE } from '../bin/cli.ts';

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
  it('injects a fish function when given the fish template', async () => {
    await writeFile(testFile, '');
    await injectWrapper(testFile, '/path/to/launcher.js', FISH_WRAPPER_TEMPLATE);
    const content = await readFile(testFile, 'utf-8');
    assert.ok(content.includes(MARKER_START));
    assert.ok(content.includes(MARKER_END));
    assert.ok(content.includes('function claude'));
    assert.ok(content.includes('env CLAUDE_AUTO_RETRY_ACTIVE=1 node "/path/to/launcher.js" $argv'));
    assert.ok(!content.includes('claude() {'), 'fish template must not contain sh syntax');
  });
  it('injects a PowerShell function when given the ps1 template', async () => {
    await writeFile(testFile, '');
    await injectWrapper(testFile, 'C:\\Users\\me\\launcher.js', PS_WRAPPER_TEMPLATE);
    const content = await readFile(testFile, 'utf-8');
    assert.ok(content.includes(MARKER_START) && content.includes(MARKER_END));
    assert.ok(content.includes('function claude {'));
    assert.ok(content.includes("node 'C:\\Users\\me\\launcher.js' @args"));
    assert.ok(!content.includes('claude() {'), 'ps1 template must not contain sh syntax');
  });
  it('fish wrapper passes fish syntax check (skipped without fish)', { skip: spawnSync('fish', ['--version']).error !== undefined }, async () => {
    await writeFile(testFile, '');
    await injectWrapper(testFile, '/path/to/launcher.js', FISH_WRAPPER_TEMPLATE);
    const r = spawnSync('fish', ['--no-execute', testFile], { encoding: 'utf-8' });
    assert.equal(r.status, 0, r.stderr ?? String(r.error));
  });
});

describe('wrapper function', () => {
  const dir = mkdtempSync(join(tmpdir(), 'car-wrap-test-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "real:$*"\n', { mode: 0o755 });
  const launcher = join(dir, 'launcher.js');
  writeFileSync(launcher, 'console.log(`launcher:${process.env.CLAUDE_AUTO_RETRY_ACTIVE}:${process.argv.slice(2).join(" ")}`);\n');
  const missing = join(dir, 'gone', 'launcher.js');
  after(() => rmSync(dir, { recursive: true, force: true }));

  // PATH holds the stub claude and node's own dir (the wrapper runs `node`). The
  // suite may itself run inside a wrapped session, so drop the guard variable.
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}` };
  delete env.CLAUDE_AUTO_RETRY_ACTIVE;

  async function run(shell: string, template: string, launcherPath: string, extraEnv: Record<string, string> = {}): Promise<string> {
    const rc = join(dir, shell === 'pwsh' ? 'rc.ps1' : `rc.${shell}`); // pwsh dot-sources .ps1 files only
    await writeFile(rc, '');
    await injectWrapper(rc, launcherPath, template);
    const cmd = shell === 'pwsh' ? ['-NoProfile', '-Command', `. '${rc}'; claude one two`] : ['-c', `source "${rc}"; claude one two`];
    const r = spawnSync(shell, cmd, { encoding: 'utf-8', env: { ...env, ...extraEnv } });
    assert.equal(r.status, 0, r.stderr ?? String(r.error));
    return r.stdout.trim();
  }

  for (const shell of ['bash', 'zsh']) {
    const skip = spawnSync(shell, ['--version']).error !== undefined;
    it(`${shell}: runs the launcher with the recursion guard set`, { skip }, async () => {
      assert.equal(await run(shell, WRAPPER_TEMPLATE, launcher), 'launcher:1:one two');
    });
    it(`${shell}: runs the real claude inside a monitored session`, { skip }, async () => {
      assert.equal(await run(shell, WRAPPER_TEMPLATE, launcher, { CLAUDE_AUTO_RETRY_ACTIVE: '1' }), 'real:one two');
    });
    it(`${shell}: falls back to the real claude when the launcher is gone`, { skip }, async () => {
      assert.equal(await run(shell, WRAPPER_TEMPLATE, missing), 'real:one two');
    });
  }
  const noPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion']).error !== undefined;
  it('pwsh: runs the launcher, and falls back when it is gone', { skip: noPwsh }, async () => {
    assert.equal(await run('pwsh', PS_WRAPPER_TEMPLATE, launcher), 'launcher:1:one two');
    assert.equal(await run('pwsh', PS_WRAPPER_TEMPLATE, launcher, { CLAUDE_AUTO_RETRY_ACTIVE: '1' }), 'real:one two');
    assert.equal(await run('pwsh', PS_WRAPPER_TEMPLATE, missing), 'real:one two');
  });
  const noFish = spawnSync('fish', ['--version']).error !== undefined;
  it('fish: runs the launcher, and falls back when it is gone', { skip: noFish }, async () => {
    assert.equal(await run('fish', FISH_WRAPPER_TEMPLATE, launcher), 'launcher:1:one two');
    assert.equal(await run('fish', FISH_WRAPPER_TEMPLATE, missing), 'real:one two');
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
