/// <reference types="vitest/config" />
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))
const outDir = resolve(root, 'dist')

// Unit tests run in a fixed timezone with DST so date math is deterministic.
process.env.TZ = 'Europe/Berlin'

/**
 * The Go binary embeds web/dist (see embed.go), and the repository keeps
 * web/dist/.gitkeep so `go build` works without a frontend build. Vite's
 * emptyOutDir removes it, so recreate it once the bundle is written.
 */
function keepGitkeep(): Plugin {
  return {
    name: 'lucid:keep-gitkeep',
    apply: 'build',
    closeBundle() {
      mkdirSync(outDir, { recursive: true })
      writeFileSync(resolve(outDir, '.gitkeep'), '')
    },
  }
}

const backend = 'http://127.0.0.1:8080'

export default defineConfig({
  plugins: [react(), tailwindcss(), keepGitkeep()],
  resolve: {
    alias: { '@': resolve(root, 'src') },
  },
  // Only explicitly public variables could ever reach the bundle (NFR-31).
  envPrefix: 'LUCID_PUBLIC_',
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: backend, changeOrigin: false },
      '/healthz': { target: backend, changeOrigin: false },
    },
  },
  preview: {
    proxy: {
      '/api': { target: backend, changeOrigin: false },
      '/healthz': { target: backend, changeOrigin: false },
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    rolldownOptions: {
      output: {
        // Stable vendor chunks cache well across app releases.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/]\.pnpm[\\/](react|react-dom|scheduler)@/, priority: 30 },
            { name: 'radix', test: /node_modules[\\/]\.pnpm[\\/](@radix-ui|radix-ui|@floating-ui)/, priority: 20 },
            {
              name: 'vendor',
              test: /node_modules[\\/]\.pnpm[\\/](@tanstack|zod|react-hook-form|@hookform|i18next|react-i18next|zustand|sonner|tailwind-merge|clsx|class-variance-authority)/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/main.tsx', 'src/vite-env.d.ts'],
      thresholds: {
        // NFR-05: >= 80 % statement coverage for business logic.
        'src/lib/**': { statements: 80, branches: 70, functions: 80, lines: 80 },
      },
    },
  },
})
