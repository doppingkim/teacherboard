import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    port: Number(process.env.PW_PORT || 5173),
    proxy: { '/api': { target: `http://localhost:${process.env.PORT ?? process.env.API_PORT ?? 8787}`, ws: true } },
  },
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
  },
});
