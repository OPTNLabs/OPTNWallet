export type BroadcastFailureInfo = {
  ambiguous: boolean;
  userMessage: string;
};

export function isAmbiguousBroadcastError(message: string): boolean {
  return /(timed out|timeout|socket|network|disconnect|connection|backoff|failed to fetch|websocket|offline|temporar)/i.test(
    message
  );
}

export function classifyBroadcastFailure(message: string): BroadcastFailureInfo {
  if (isAmbiguousBroadcastError(message)) {
    return {
      ambiguous: true,
      userMessage:
        'Broadcast status is uncertain due to a network issue. The wallet will retry until the transaction becomes visible or you clear the lock.',
    };
  }

  if (/bad-txns-inputs-duplicate/i.test(message)) {
    return {
      ambiguous: false,
      userMessage:
        'Broadcast rejected: the transaction attempts to spend the same input more than once. Refresh the quote and try again.',
    };
  }

  if (/mandatory-script-verify-flag-failed|script evaluated without error/i.test(message)) {
    return {
      ambiguous: false,
      userMessage:
        'Broadcast rejected by contract rules. Refresh the quote and rebuild the transaction before trying again.',
    };
  }

  if (/min relay fee not met|insufficient fee|mempool min fee not met|insufficient priority/i.test(message)) {
    return {
      ambiguous: false,
      userMessage:
        'Broadcast rejected for insufficient fee. Rebuild the transaction so the wallet can recalculate the network fee.',
    };
  }

  if (/dust/i.test(message)) {
    return {
      ambiguous: false,
      userMessage:
        'Broadcast rejected because one of the outputs is below dust. Adjust the amount and try again.',
    };
  }

  if (/txn-mempool-conflict|already spent|missing inputs|bad-txns-inputs-missingorspent/i.test(message)) {
    return {
      ambiguous: false,
      userMessage:
        'Broadcast rejected because one or more inputs are already spent or no longer available. Refresh wallet UTXOs and try again.',
    };
  }

  return {
    ambiguous: false,
    userMessage: `Error sending transaction: ${message}`,
  };
}

export function isDeterministicBroadcastError(message: string | null | undefined): boolean {
  if (!message) return false;
  return !classifyBroadcastFailure(message).ambiguous;
}
