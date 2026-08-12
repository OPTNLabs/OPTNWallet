import ElectrumServer from '../apis/ElectrumServer/ElectrumServer';
import { RequestResponse } from '@electrum-cash/network';

export interface ElectrumAdapter {
  connect(customServer?: string): Promise<unknown>;
  reconnect(customServer?: string): Promise<unknown>;
  disconnect(): Promise<boolean>;
  request(method: string, ...params: unknown[]): Promise<RequestResponse>;
  subscribe(method: string, params?: unknown[]): Promise<void>;
  unsubscribe(method: string, params?: unknown[]): Promise<void>;
}

export default function getElectrumAdapter(): ElectrumAdapter {
  const server = ElectrumServer();
  return {
    connect: (customServer?: string) => server.electrumConnect(customServer),
    reconnect: (customServer?: string) => server.electrumReconnect(customServer),
    disconnect: () => server.electrumDisconnect(),
    request: (method: string, ...params: unknown[]) =>
      server.request(method, ...(params as never[])),
    subscribe: (method: string, params?: unknown[]) =>
      server.subscribe(method, params as never[] | undefined),
    unsubscribe: (method: string, params?: unknown[]) =>
      server.unsubscribe(method, params as never[] | undefined),
  };
}
