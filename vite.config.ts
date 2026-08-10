/**
 * One config, five passes.
 *
 * The passes exist because MV3 surfaces disagree about module format: the side
 * panel and the service worker are ES modules, but content scripts are not -
 * Chrome loads them as classic scripts, so each must be a self-contained IIFE
 * with no import statements. Rollup can only emit one IIFE per build, hence a
 * pass per content script.
 *
 * `pnpm build` runs them in order; the first pass empties `dist/`.
 */

import { chmodSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin, type UserConfig } from 'vite';

const root = import.meta.dirname;
const outDir = resolve(root, 'dist');

type Target = 'panel' | 'worker' | 'content-script' | 'page-bridge' | 'native-host';

const target = (process.env['SOCRATES_TARGET'] ?? 'panel') as Target;

/** Vite emits the panel as `index.html`; the manifest wants `panel.html`. */
function renamePanelHtml(): Plugin {
  return {
    name: 'socrates:rename-panel-html',
    closeBundle() {
      renameSync(resolve(outDir, 'index.html'), resolve(outDir, 'panel.html'));
    },
  };
}

function makeExecutable(file: string): Plugin {
  return {
    name: 'socrates:chmod',
    closeBundle() {
      chmodSync(file, 0o755);
    },
  };
}

/** A single-entry IIFE bundle, the only shape MV3 content scripts accept. */
function contentScript(entry: string, fileName: string, name: string): UserConfig {
  return {
    publicDir: false,
    build: {
      outDir,
      emptyOutDir: false,
      target: 'chrome116',
      minify: false,
      lib: { entry: resolve(root, entry), name, formats: ['iife'], fileName: () => fileName },
    },
  };
}

const configs: Record<Target, UserConfig> = {
  panel: {
    root: resolve(root, 'src/panel'),
    base: './',
    publicDir: resolve(root, 'public'),
    plugins: [react(), renamePanelHtml()],
    build: {
      outDir,
      emptyOutDir: true,
      target: 'chrome116',
      rollupOptions: {
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  },

  worker: {
    publicDir: false,
    build: {
      outDir,
      emptyOutDir: false,
      target: 'chrome116',
      minify: false,
      rollupOptions: {
        // A single entry with no dynamic imports, so this stays one file - which
        // is what an MV3 module service worker wants.
        input: { 'service-worker': resolve(root, 'src/background/service-worker.ts') },
        output: { format: 'es', entryFileNames: '[name].js' },
      },
    },
  },

  'content-script': contentScript('src/content/content-script.ts', 'content-script.js', 'SocratesContent'),
  'page-bridge': contentScript('src/content/page-bridge.ts', 'page-bridge.js', 'SocratesBridge'),

  'native-host': {
    publicDir: false,
    plugins: [makeExecutable(resolve(outDir, 'native-host/socrates-host.mjs'))],
    build: {
      outDir: resolve(outDir, 'native-host'),
      emptyOutDir: false,
      target: 'node20',
      minify: false,
      lib: {
        entry: resolve(root, 'src/native-host/main.ts'),
        formats: ['es'],
        fileName: () => 'socrates-host.mjs',
      },
      rollupOptions: {
        external: [/^node:/],
        output: { banner: '#!/usr/bin/env node' },
      },
    },
  },
};

export default defineConfig(configs[target]);
