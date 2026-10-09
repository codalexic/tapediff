import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: false,
    splitting: true,
    clean: ['dist/*.js'],
  },
  {
    entry: ['src/tools/index.ts'],
    outDir: 'dist/tools',
    format: ['esm', 'cjs'],
    platform: 'node',
    target: 'node20',
    dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
    clean: true,
  },
]);
