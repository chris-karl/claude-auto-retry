// Post-compile step for the packaged build (tsconfig.build.json): tsc emits only
// .js, so copy the two data files the runtime reads next to the binary —
// src/wrapper.sh (injected into .bashrc/.zshrc) and package.json (read by the
// `version` command; also pins dist/ to "type": "module" so the .js runs as ESM).
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

mkdirSync(join(dist, 'src'), { recursive: true });
copyFileSync(join(root, 'src', 'wrapper.sh'), join(dist, 'src', 'wrapper.sh'));
copyFileSync(join(root, 'package.json'), join(dist, 'package.json'));

console.log('copy-assets: wrapper.sh + package.json -> dist/');
