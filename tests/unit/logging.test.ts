import { describe, expect, it, vi } from 'vitest';
import { logError, logInfo, setLogFileWriter } from '../../src/shared/logging';

describe('structured logging file sink', () => {
  it('mirrors info and error log lines to a configured launch log writer', () => {
    const lines: string[] = [];
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      setLogFileWriter((line) => lines.push(line));
      logInfo('review-assistant.test-info', { value: 'hello world' });
      logError('review-assistant.test-error', { code: 1 });

      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('review-assistant.test-info value="hello world"');
      expect(lines[1]).toContain('review-assistant.test-error code=1');
      expect(info).toHaveBeenCalledWith(lines[0]);
      expect(error).toHaveBeenCalledWith(lines[1]);
    } finally {
      setLogFileWriter(undefined);
      info.mockRestore();
      error.mockRestore();
    }
  });
});
