// // src/services/BcmrSnapshotStorage.ts
// import DatabaseService from '../apis/DatabaseManager/DatabaseService';
// import { IdentitySnapshot } from '@bitauth/libauth';
// import { Database } from 'sql.js';

// export default class BcmrSnapshotStorage {
//   private db: Database | null = null;

//   private async getDb(): Promise<Database> {
//     if (!this.db) {
//       await DatabaseService().ensureDatabaseStarted();
//       const db = DatabaseService().getDatabase();
//       if (!db) throw new Error('Database failed to initialize');
//       this.db = db;
//     }
//     return this.db;
//   }

//   /**
//    * Store the BCMR snapshot data in the database.
//    * @param category The token category (tokenId)
//    * @param snapshot The BCMR snapshot data
//    */
//   public async storeSnapshot(category: string, snapshot: IdentitySnapshot): Promise<void> {
//     const db = await this.getDb();
//     const query = db.prepare(`
//       INSERT OR REPLACE INTO bcmr_metadata (
//         category, name, description, decimals, symbol, is_nft, nfts, uris, extensions
//       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
//     `);
//     const name = snapshot.name || '';
//     const description = snapshot.description || '';
//     const decimals = snapshot.token?.decimals || 0;
//     const symbol = snapshot.token?.symbol || '';
//     const is_nft = !!snapshot.token?.nfts;
//     const nfts = snapshot.token?.nfts ? JSON.stringify(snapshot.token.nfts) : null;
//     const uris = snapshot.uris ? JSON.stringify(snapshot.uris) : null;
//     const extensions = snapshot.extensions ? JSON.stringify(snapshot.extensions) : null;
//     query.run([category, name, description, decimals, symbol, is_nft, nfts, uris, extensions]);
//     query.free();
//   }

//   /**
//    * Retrieve the BCMR snapshot data from the database.
//    * @param category The token category (tokenId)
//    * @returns The BCMR snapshot data or null if not found
//    */
//   public async getSnapshot(category: string): Promise<IdentitySnapshot | null> {
//     const db = await this.getDb();
//     const query = db.prepare(`
//       SELECT * FROM bcmr_metadata WHERE category = ?;
//     `);
//     query.bind([category]);
//     if (query.step()) {
//       const result = query.getAsObject();
//       query.free();
//       return {
//         name: result.name as string,
//         description: result.description as string,
//         token: {
//           category: result.category as string,
//           decimals: result.decimals as number,
//           symbol: result.symbol as string,
//           nfts: result.nfts ? JSON.parse(result.nfts as string) : undefined,
//         },
//         uris: result.uris ? JSON.parse(result.uris as string) : undefined,
//         extensions: result.extensions ? JSON.parse(result.extensions as string) : undefined,
//       };
//     }
//     query.free();
//     return null;
//   }
// }