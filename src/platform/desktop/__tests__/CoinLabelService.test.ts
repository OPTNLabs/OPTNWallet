import { beforeEach, describe, expect, it, vi } from 'vitest';

const runMock = vi.fn();
const freeMock = vi.fn();
const bindMock = vi.fn();
const stepMock = vi.fn();
const getAsObjectMock = vi.fn();

const prepareMock = vi.fn(() => ({
  bind: bindMock,
  step: stepMock,
  getAsObject: getAsObjectMock,
  free: freeMock,
}));

vi.mock('../../../apis/DatabaseManager/DatabaseService', () => ({
  default: () => ({
    ensureDatabaseStarted: vi.fn(async () => undefined),
    getDatabase: () => ({
      run: runMock,
      prepare: prepareMock,
    }),
  }),
}));

vi.mock('../desktopSchema', () => ({
  ensureDesktopLedgerTables: vi.fn(async () => undefined),
}));

describe('CoinLabelService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stepMock.mockReturnValue(false);
  });

  it('setCoinLabel upserts a non-empty label', async () => {
    const { setCoinLabel } = await import('../CoinLabelService');
    await setCoinLabel(5, 'outpoint', 'aa:0', '  salary  ');
    expect(runMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO coin_labels'),
      expect.arrayContaining([5, 'outpoint', 'aa:0', 'salary'])
    );
  });

  it('setCoinLabel deletes when label is empty', async () => {
    const { setCoinLabel } = await import('../CoinLabelService');
    await setCoinLabel(5, 'txid', 'deadbeef', '   ');
    expect(runMock).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM coin_labels'),
      [5, 'txid', 'deadbeef']
    );
  });

  it('outpointKey formats tx:pos', async () => {
    const { outpointKey } = await import('../CoinLabelService');
    expect(outpointKey('abc', 2)).toBe('abc:2');
  });

  it('exportCoinLabelsCsv includes header and rows', async () => {
    stepMock
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    getAsObjectMock.mockReturnValueOnce({
      kind: 'txid',
      ref_key: 'tx1',
      label: 'fuse test',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    const { exportCoinLabelsCsv } = await import('../CoinLabelService');
    const csv = await exportCoinLabelsCsv(5);
    expect(csv.startsWith('kind,ref_key,label,updated_at')).toBe(true);
    expect(csv).toContain('fuse test');
    expect(csv).toContain('tx1');
  });
});
