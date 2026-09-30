import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * packages/web を無改変のまま Databricks Apps 向けにビルドする Vite 設定。
 * 元の vite.config.ts と同じ設定に、Amplify / AWS SDK のブラウザ向け互換シムへの alias を足したもの。
 */
const web = path.resolve(__dirname, '../../web');
const shim = (f: string) => path.resolve(__dirname, 'shims', f);

export default defineConfig({
  root: web,
  resolve: {
    alias: [
      { find: '@', replacement: path.join(web, 'src') },
      { find: './runtimeConfig', replacement: './runtimeConfig.browser' },
      { find: /^aws-amplify\/auth$/, replacement: shim('aws-amplify-auth.ts') },
      { find: /^aws-amplify\/utils$/, replacement: shim('aws-amplify-utils.ts') },
      { find: /^aws-amplify$/, replacement: shim('aws-amplify.ts') },
      { find: /^@aws-amplify\/ui-react\/styles\.css$/, replacement: shim('empty.css') },
      { find: /^@aws-amplify\/ui-react$/, replacement: shim('amplify-ui-react.tsx') },
      { find: /^@aws-sdk\/client-lambda$/, replacement: shim('client-lambda.ts') },
      {
        find: /^@aws-sdk\/credential-provider-cognito-identity$/,
        replacement: shim('credential-provider-cognito-identity.ts'),
      },
    ],
  },
  plugins: [react(), tailwindcss()],
  build: {
    outDir: path.resolve(__dirname, '../dist/web'),
    emptyOutDir: true,
  },
});
