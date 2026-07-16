import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['workspace/**', '.cowork/**', 'dist/**', 'node_modules/**'],
  },
});
