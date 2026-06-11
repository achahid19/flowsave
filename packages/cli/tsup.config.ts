import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  target: 'node18',
  bundle: true,
  // Bundle @flowsave/core (workspace package — not on npm) and all other deps
  // so the published package has zero runtime dependencies.
  noExternal: [/.*/],
  clean: true,
  outDir: 'dist',
  // No type declarations needed for a CLI binary
  dts: false,
});
