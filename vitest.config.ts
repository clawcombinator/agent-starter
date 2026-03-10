import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Allow .js extension imports (NodeNext ESM resolution)
    globals: false,
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
  },
  resolve: {
    // Map .js imports to .ts source files during test runs
    extensions: ['.ts', '.js'],
  },
});
