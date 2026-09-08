import { Session } from 'node:inspector';
import { describe, expect, it } from 'vitest';
import { callPageFunction } from '../e2e-cdp.mjs';

describe('E2E CDP page arguments', () => {
  it('round-trips hostile input as data using the real Runtime protocol', async () => {
    const session = new Session();
    session.connect();
    const methods: string[] = [];
    const client = {
      command(method: string, params: Record<string, unknown>) {
        methods.push(method);
        return new Promise((resolve, reject) => {
          session.post(method, params, (error, result) => {
            if (error) reject(error);
            else resolve({ result });
          });
        });
      },
    };
    const value =
      '"\'); throw new Error("injected"); //\\\n\u2028\u2029</script>';
    try {
      expect(
        await callPageFunction(
          client,
          (selector: string, index: number, value: string) => ({
            selector,
            index,
            value,
          }),
          'input[data-label="quoted"]',
          3,
          value
        )
      ).toEqual({ selector: 'input[data-label="quoted"]', index: 3, value });
      expect(methods).toEqual([
        'Runtime.evaluate',
        'Runtime.callFunctionOn',
        'Runtime.releaseObject',
      ]);
      methods.length = 0;
      await expect(
        callPageFunction(
          client,
          (value: string) => {
            throw new Error(value);
          },
          value
        )
      ).rejects.toThrow('WebView function call failed');
      expect(methods.at(-1)).toBe('Runtime.releaseObject');
    } finally {
      session.disconnect();
    }
  });
});
