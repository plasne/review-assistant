import '@testing-library/jest-dom/vitest';

class TestResizeObserver {
  observe(): void {
    return undefined;
  }

  unobserve(): void {
    return undefined;
  }

  disconnect(): void {
    return undefined;
  }
}

globalThis.ResizeObserver = globalThis.ResizeObserver ?? TestResizeObserver;

if (globalThis.CSSStyleSheet && !globalThis.CSSStyleSheet.prototype.replaceSync) {
  Object.defineProperty(globalThis.CSSStyleSheet.prototype, 'replaceSync', {
    value: () => undefined
  });
}
