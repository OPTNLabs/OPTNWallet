/** Node-only stub so chat-cli can import MLS without USB Ledger. */
export default class Transport {
  static async isSupported(): Promise<boolean> {
    return false;
  }
  static async list(): Promise<string[]> {
    return [];
  }
  static async open(): Promise<Transport> {
    throw new Error('ledger stub: no hardware in chat-cli');
  }
}
