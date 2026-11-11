import { defineConfig } from 'vite';

export default defineConfig({
  // wasm-bindgen may copy adapter.js into a snippets directory. Worker URLs
  // stay rooted at this public location instead of following the copied module.
  base: '/web/dist/',
  optimizeDeps: { exclude: ['@powersync/web'] },
  worker: { format: 'es' },
  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
    rollupOptions: {
      input: 'src/adapter.ts',
      preserveEntrySignatures: 'strict',
      output: { entryFileNames: 'adapter.js', inlineDynamicImports: true }
    }
  }
});
