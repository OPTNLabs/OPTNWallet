import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeCashAddress } from '@bitauth/libauth';

import type { TransactionOutput, UTXO } from '../../../types/types';
import { DUST, TOKEN_OUTPUT_SATS } from '../../../utils/constants';
import { createSimpleSendPlanner } from '../planner';

const { buildTransactionMock } = vi.hoisted(() => ({
  buildTransactionMock: vi.fn(),
}));

const RECIPIENT = encodeCashAddress({
  payload: Uint8Array.from([0x11, ...new Uint8Array(19).fill(0x22)]),
  prefix: 'bchtest',
  type: 'p2pkh',
}).address;

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

  it('uses the configured BCH value for a CashToken recipient output', () => {
    const planner = createSimpleSendPlanner({
      recipient: RECIPIENT,
      selectedCategory: 'a'.repeat(64),
      amountToken: '1',
      tokenOutputSats: 2500,
      tokenChangeAddress: 'bchtest:zchange',
      selectedChangeAddress: 'bchtest:qchange',
      dbUtxos: [],
    });

    expect(planner.makeTokenOutputForRecipientFT()).toMatchObject({
      amount: 2500,
      token: { amount: 1n },
    });
  });

  it('keeps the protocol minimum when a smaller BCH value is provided', () => {
    const planner = createSimpleSendPlanner({
      recipient: RECIPIENT,
      selectedCategory: 'a'.repeat(64),
      amountToken: '1',
      tokenOutputSats: 500,
      tokenChangeAddress: 'bchtest:zchange',
      selectedChangeAddress: 'bchtest:qchange',
      dbUtxos: [],
    });

    expect(planner.makeTokenOutputForRecipientFT()).toMatchObject({
      amount: TOKEN_OUTPUT_SATS,
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

  it('estimates Max locally for standard BCH UTXOs', () => {
    const result = createPlanner([makeUtxo(10_000, 100)]).estimateSweepAllBch();

    expect(result).toMatchObject({
      ok: true,
      inputs: [expect.objectContaining({ tx_hash: 'a'.repeat(64), tx_pos: 1 })],
      feeSats: 224,
      totalSats: 10_000,
      finalOutputs: [{ recipientAddress: 'bchtest:qrecipient', amount: 9_776 }],
    });
    expect(buildTransactionMock).not.toHaveBeenCalled();
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
