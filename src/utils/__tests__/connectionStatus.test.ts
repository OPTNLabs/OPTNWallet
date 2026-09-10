import { describe, expect, it } from 'vitest';
import {
  walletConnectSessionStatus,
  wizardConnectionStatus,
} from '../connectionStatus';

describe('connection evidence', () => {
  it('never mistakes a relay connection for a completed dApp handshake', () => {
    expect(wizardConnectionStatus('connected')).toBe(
      'connection.relayAvailable'
    );
    expect(wizardConnectionStatus('reconnecting')).toBe(
      'connection.reconnecting'
    );
    expect(wizardConnectionStatus('disconnected')).toBe(
      'connection.disconnected'
    );
    expect(wizardConnectionStatus('session_deleted')).toBe(
      'connection.sessionEnded'
    );
    expect(wizardConnectionStatus('new-sdk-status')).toBe('connection.unknown');
  });

  it('requires acknowledgement and unexpired authorization, without asserting peer liveness', () => {
    expect(
      walletConnectSessionStatus({ expiry: 101, acknowledged: false }, 100)
    ).toBe('connection.awaitingAcknowledgement');
    expect(
      walletConnectSessionStatus({ expiry: 101, acknowledged: true }, 100)
    ).toBe('connection.sessionAuthorized');
    expect(
      walletConnectSessionStatus({ expiry: 100, acknowledged: true }, 100)
    ).toBe('connection.expired');
    expect(
      walletConnectSessionStatus({ expiry: 99, acknowledged: false }, 100)
    ).toBe('connection.expired');
    expect(walletConnectSessionStatus({}, 100)).toBe('connection.unknown');
    expect(walletConnectSessionStatus({ expiry: Infinity }, 100)).toBe(
      'connection.unknown'
    );
  });
});
