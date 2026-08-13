import { Address } from '../../types/types';
import DatabaseService from '../DatabaseManager/DatabaseService';

export default function AddressManager() {
  const dbService = DatabaseService();

  async function registerAddress(address: Address): Promise<void> {
    try {
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();
      if (db != null) {
        const registerAddressQuery = db.prepare(`
          INSERT INTO addresses (wallet_id, address, balance, hd_index, change_index, prefix) VALUES (?, ?, ?, ?, ?, ?);
        `);

        registerAddressQuery.run([
          address.wallet_id,
          address.address,
          address.balance,
          address.hd_index,
          address.change_index,
          address.prefix,
        ]);

        registerAddressQuery.free();
      } else {
        console.error('Database instance is null.');
      }
    } catch (error) {
      console.error('Failed to register address:', error);
    }
  }

  async function fetchTokenAddress(
    wallet_id: number,
    address: string
  ): Promise<string | null> {
    try {
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();
      if (db == null) {
        throw new Error('Database is null');
      }

      const fetchTokenAddressQuery = db.prepare(`
        SELECT token_address 
        FROM keys 
        WHERE wallet_id = ? AND address = ?;
      `);

      const result = fetchTokenAddressQuery.getAsObject([
        wallet_id,
        address,
      ]) as { token_address: string | null };

      fetchTokenAddressQuery.free();

      if (result && result.token_address) {
        return result.token_address;
      } else {
        console.warn(
          `No token_address found for wallet_id: ${wallet_id}, address: ${address}`
        );
        return null;
      }
    } catch (error) {
      console.error('Failed to fetch token_address:', error);
      return null;
    }
  }

  async function fetchTokenAddresses(
    wallet_id: number,
    addresses: string[]
  ): Promise<Record<string, string>> {
    try {
      await dbService.ensureDatabaseStarted();
      const db = dbService.getDatabase();
      if (db == null) {
        throw new Error('Database is null');
      }

      const uniqueAddresses = Array.from(new Set(addresses.filter(Boolean)));
      if (uniqueAddresses.length === 0) return {};

      const placeholders = uniqueAddresses.map(() => '?').join(', ');
      const query = db.prepare(`
        SELECT address, token_address
        FROM keys
        WHERE wallet_id = ? AND address IN (${placeholders});
      `);
      query.bind([wallet_id, ...uniqueAddresses]);

      const out: Record<string, string> = {};
      while (query.step()) {
        const row = query.getAsObject() as {
          address?: string;
          token_address?: string | null;
        };
        if (typeof row.address === 'string' && typeof row.token_address === 'string') {
          out[row.address] = row.token_address;
        }
      }
      query.free();

      return out;
    } catch (error) {
      console.error('Failed to fetch token_addresses:', error);
      return {};
    }
  }

  return {
    registerAddress,
    fetchTokenAddress,
    fetchTokenAddresses,
  };
}
