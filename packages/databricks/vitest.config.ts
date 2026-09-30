import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { 'genai-dbx-runtime': path.resolve(__dirname, 'src/runtime/index.ts') },
  },
  test: { include: ['tests/**/*.test.ts'] },
});
