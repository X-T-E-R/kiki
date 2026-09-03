#!/usr/bin/env node
import { cp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const extensionRoot = resolve(import.meta.dirname, '..');
const source = resolve(extensionRoot, '..', 'kiki-gui', 'dist');
const target = resolve(extensionRoot, 'media', 'gui');

await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
