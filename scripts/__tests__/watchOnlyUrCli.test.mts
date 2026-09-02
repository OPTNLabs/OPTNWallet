import { describe, expect, it } from 'vitest';

import {
  CliFailure,
  UsageError,
  USAGE,
  checkVectors,
  framesToPsbt,
  parseFrames,
  run,
  type Vector,
} from '../watch-only-ur.mts';
import vectorDocument from '../../src/services/psbt/__tests__/vectors/watchOnlyUr.vectors.json';

const vectors = vectorDocument.vectors as Vector[];

/** Collects what a command writes, so output can be asserted. */
function sink(): { text: () => string; stream: NodeJS.WritableStream } {
  let text = '';
  const stream = {
    write(chunk: string) {
      text += chunk;
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { text: () => text, stream };
}

describe('watch-only UR CLI', () => {
  describe('frame parsing', () => {
    it('reads frames one per line, ignoring blank lines and padding', () => {
      const text = `\n  ${vectors[0].frames[0]}  \n\n${vectors[0].frames[1]}\n`;
      expect(parseFrames(text)).toEqual([
        vectors[0].frames[0],
        vectors[0].frames[1],
      ]);
    });

    it('refuses a file that is not UR frames', () => {
      // Handing the decoder arbitrary text would fail somewhere deeper with a
      // message about CBOR rather than about the file that was passed.
      expect(() => parseFrames('70736274ff0100')).toThrow(CliFailure);
      expect(() => parseFrames('70736274ff0100')).toThrow(/not a UR frame/);
    });

    it('refuses an empty input rather than decoding nothing', () => {
      expect(() => parseFrames('   \n\n')).toThrow(/no UR frames/);
    });
  });

  describe('decode', () => {
    for (const vector of vectors) {
      it(`reassembles ${vector.name}`, () => {
        expect(Buffer.from(framesToPsbt(vector.frames)).toString('hex')).toBe(
          vector.psbtHex
        );
      });
    }

    it('says how far it got when frames are missing', () => {
      // A partial capture is the normal camera failure. "Incomplete, 40%
      // decoded" tells the user to keep scanning; a CBOR error does not.
      const partial = vectors[1].frames.slice(0, 2);
      expect(() => framesToPsbt(partial)).toThrow(/incomplete/);
      expect(() => framesToPsbt(partial)).toThrow(/decoded/);
    });

    it('accepts frames out of order', () => {
      // Frames arrive from a camera in whatever order the user catches them.
      const shuffled = [...vectors[1].frames].reverse();
      expect(Buffer.from(framesToPsbt(shuffled)).toString('hex')).toBe(
        vectors[1].psbtHex
      );
    });
  });

  describe('vectors', () => {
    it('reports every committed vector as matching', () => {
      const reports = checkVectors(vectors);
      expect(reports).toHaveLength(vectors.length);
      for (const report of reports) {
        expect(report.matches, `${report.name} should match`).toBe(true);
        expect(report.firstDifference).toBe(-1);
      }
    });

    it('locates the first frame that drifted', () => {
      // The check exists to catch a UR library or fragment-length change. If
      // it could not point at a frame, a drift would be reported as "something
      // changed" with nothing to compare.
      const tampered: Vector[] = [
        {
          ...vectors[0],
          frames: vectors[0].frames.map((frame, index) =>
            index === 2 ? 'UR:CRYPTO-PSBT/3-6/TAMPERED' : frame
          ),
        },
      ];
      const [report] = checkVectors(tampered);
      expect(report.matches).toBe(false);
      expect(report.firstDifference).toBe(2);
    });

    it('notices a vector with the wrong number of frames', () => {
      const truncated: Vector[] = [
        { ...vectors[1], frames: vectors[1].frames.slice(0, 3) },
      ];
      const [report] = checkVectors(truncated);
      expect(report.matches).toBe(false);
      expect(report.recordedFrames).toBe(3);
      expect(report.producedFrames).toBe(vectors[1].frameCount);
    });
  });

  describe('command dispatch', () => {
    it('shows usage for an unknown command', () => {
      const { stream } = sink();
      expect(() => run(['node', 'cli', 'sign'], stream)).toThrow(UsageError);
    });

    it('shows usage for --help', () => {
      const { stream } = sink();
      expect(() => run(['node', 'cli', 'encode', '--help'], stream)).toThrow(
        UsageError
      );
    });

    it('documents every command it accepts', () => {
      for (const command of ['encode', 'decode', 'verify', 'vectors']) {
        expect(USAGE, `${command} should be documented`).toContain(command);
      }
      // The Chipnet-only rule is a property of this channel, not a detail.
      expect(USAGE).toMatch(/Chipnet only/);
      expect(USAGE).toMatch(/Never reads keys/);
      expect(USAGE).toContain('--fragment-length 50|100|200|400');
    });

    it('runs the vectors command against the committed file', () => {
      const { text, stream } = sink();
      run(['node', 'cli', 'vectors'], stream);
      expect(text()).toContain(`${vectors.length} vector(s) match`);
      for (const vector of vectors) {
        expect(text()).toContain(`${vector.name}: ok`);
      }
    });
  });
});
