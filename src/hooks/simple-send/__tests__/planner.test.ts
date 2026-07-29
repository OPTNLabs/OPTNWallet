import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TransactionOutput, UTXO } from '../../../types/types';
import { DUST } from '../../../utils/constants';
import { createSimpleSendPlanner } from '../planner';

const { buildTransactionMock } = vi.hoisted(() => ({
  buildTransactionMock: vi.fn(),
}));

vi.mock('../../../services/TransactionService', () => ({
  default: {
    buildTransaction: buildTransactionMock,
  },
}));

function makeUtxo(value: number, height: number): UTXO {
  return {
    address: 'bchtest:qsource',
    height,
    tx_hash: 'a'.repeat(64),
    tx_pos: 1,
    value,
    amount: value,
    token: null,
  };
}

function buildResult(finalOutputs: TransactionOutput[], bytecodeSize = 100) {
  return {
    bytecodeSize,
    finalTransaction: '00',
    finalOutputs,
    errorMsg: '',
  };
}

function createPlanner(dbUtxos: UTXO[]) {
  return createSimpleSendPlanner({
    recipient: 'bchtest:qrecipient',
    selectedCategory: '',
    amountToken: '',
    tokenChangeAddress: 'bchtest:zchange',
    selectedChangeAddress: 'bchtest:qchange',
    dbUtxos,
  });
}

describe('simple-send planner', () => {
  beforeEach(() => {
    buildTransactionMock.mockReset();
  });

  it('uses the actual fee paid instead of transaction byte count', async () => {
    buildTransactionMock.mockResolvedValue(
      buildResult(
        [
          { recipientAddress: 'bchtest:qrecipient', amount: 9000 },
          { recipientAddress: 'bchtest:qchange', amount: 780 },
        ],
        200
      )
    );

    const result = await createPlanner([
      makeUtxo(10_000, 100),
    ]).addBchOnlyUntilBuild(9000);

    expect(result).toMatchObject({
      ok: true,
      feeSats: 220,
      totalSats: 9220,
      changeSats: 780,
    });
  });

  it('can build a fixed-amount send from an unconfirmed BCH UTXO', async () => {
    buildTransactionMock.mockResolvedValue(
      buildResult([
        { recipientAddress: 'bchtest:qrecipient', amount: 9000 },
        { recipientAddress: 'bchtest:qchange', amount: 780 },
      ])
    );

    const result = await createPlanner([
      makeUtxo(10_000, 0),
    ]).addBchOnlyUntilBuild(9000);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.inputs[0].height).toBe(0);
  });

  it('uses unconfirmed BCH UTXOs for Max when no confirmed UTXO exists', async () => {
    buildTransactionMock.mockImplementation(
      async (outputs: TransactionOutput[]) => {
        const requestedAmount = Number(
          'opReturn' in outputs[0] ? 0 : outputs[0].amount
        );

        if (requestedAmount === DUST) {
          return buildResult([
            { recipientAddress: 'bchtest:qrecipient', amount: DUST },
            { recipientAddress: 'bchtest:qchange', amount: 9344 },
          ]);
        }

        return buildResult([
          { recipientAddress: 'bchtest:qrecipient', amount: 9890 },
        ]);
      }
    );

    const result = await createPlanner([
      makeUtxo(10_000, 0),
    ]).sweepAllBchUntilBuild();

    expect(result).toMatchObject({
      ok: true,
      feeSats: 110,
      inputs: [expect.objectContaining({ height: 0 })],
    });
    if (result.ok) {
      expect(result.finalOutputs[0]).toMatchObject({ amount: 9890 });
    }
  });
});
