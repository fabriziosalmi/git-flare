import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd with the `dev` environment (mock Artifacts). Secrets below are test-only.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc', environment: 'dev' },
      miniflare: {
        bindings: {
          ADMIN_KEY: 'test-admin-key-0123456789abcdef0123456789abcdef',
          AUTH_SECRET: 'test-auth-secret-0123456789abcdef0123456789abcdef',
          QUEUE_BATCH_WINDOW_MS: '600000',
        },
      },
    }),
  ],
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 },
});
