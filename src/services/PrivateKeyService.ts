import DatabaseService from '../apis/DatabaseManager/DatabaseService';
import { store } from '../redux/store';

// Utility functions for type checking
function isString(value: any): value is string {
  return typeof value === 'string';
}

function isArrayBufferLike(value: any): value is ArrayBufferLike {
  return value instanceof Uint8Array || value instanceof ArrayBuffer;
}

export default function PrivateKeyService() {
  const dbService = DatabaseService();

  // Fetch the private key for a specific address
  async function fetchPrivateKey(address: string): Promise<Uint8Array | null> {
    await dbService.ensureDatabaseStarted();
    const db = dbService.getDatabase();

    if (!db) {
      throw new Error('Could not get database');
    }

    const privateKeyQuery = `SELECT private_key FROM keys WHERE wallet_id = ? AND address = ?`;
    const privateKeyStatement = db.prepare(privateKeyQuery);
    privateKeyStatement.bind([
      store.getState().wallet_id.currentWalletId,
      address,
    ]);

    let privateKey = new Uint8Array();
    while (privateKeyStatement.step()) {
      const row = privateKeyStatement.getAsObject();
      if (row.private_key) {
        privateKey = isArrayBufferLike(row.private_key)
          ? new Uint8Array(row.private_key)
          : isString(row.private_key)
            ? Uint8Array.from(atob(row.private_key), (c) => c.charCodeAt(0))
            : new Uint8Array();
      }
    }
    privateKeyStatement.free();
    return privateKey.length > 0 ? privateKey : null;
  }

  return {
    fetchPrivateKey,
  };
}
