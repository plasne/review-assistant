import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('vite dev server config', () => {
  it('allows concurrent dev instances to increment from the default renderer port', () => {
    expect(readFileSync('electron.vite.config.ts', 'utf8')).toMatch(/port:\s*5173,\s*\n\s*strictPort:\s*false/);
    expect(readFileSync('vite.config.ts', 'utf8')).toMatch(/port:\s*5173,\s*\n\s*strictPort:\s*false/);
  });
});
