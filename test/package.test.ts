import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const readJson = async (rel: string) =>
  JSON.parse(await readFile(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8'));

describe('package metadata', () => {
  it('package.json version is valid semver', async () => {
    const pkg = await readJson('../package.json');
    assert.match(pkg.version, /^\d+\.\d+\.\d+/);
  });
  it('package.json and package-lock.json report the same version', async () => {
    const pkg = await readJson('../package.json');
    const lock = await readJson('../package-lock.json');
    assert.equal(lock.version, pkg.version, 'lockfile root version drifted from package.json');
    assert.equal(lock.packages[''].version, pkg.version, 'lockfile package version drifted from package.json');
  });
});
