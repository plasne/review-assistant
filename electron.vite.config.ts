import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    build: {
      outDir: 'dist',
      rollupOptions: {
        external: ['@github/copilot-sdk', '@github/copilot'],
        input: {
          'main/main': resolve(__dirname, 'src/main/main.ts'),
          'agent/agent-process': resolve(__dirname, 'src/agent/agent-process.ts')
        },
        output: {
          entryFileNames: '[name].js'
        }
      }
    }
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          preload: resolve(__dirname, 'src/preload/preload.ts')
        },
        output: {
          entryFileNames: '[name].js'
        }
      }
    }
  },
  renderer: {
    root: '.',
    base: './',
    plugins: [react()],
    build: {
      outDir: 'dist/renderer',
      emptyOutDir: false,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true
    }
  }
});
