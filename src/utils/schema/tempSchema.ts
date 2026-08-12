/**
 * schema.ts
 *
 * Defines the schema for the OPTN Wallet local database (SQLite via sql.js).
 * This includes wallet data, addresses, keys, UTXOs, transactions, contract artifacts,
 * instantiated contracts, and BCMR metadata.
 *
 * ⚠️ Note: Foreign keys must be explicitly enabled with `PRAGMA foreign_keys = ON;`
 * in sql.js for enforcement. By default, they are not enforced.
 */

export const createTables = (db: any) => {
  // Ensure foreign keys are enforced
  db.run("PRAGMA foreign_keys = ON;");

  // Wallets: Root wallet info and balances
  db.run(`
    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_name VARCHAR(255),
      mnemonic TEXT,
      passphrase TEXT,
      networkType TEXT,
      balance INTEGER DEFAULT 0
    );
  `);

  // Keys: HD-derived keys tied to wallets
  db.run(`
    CREATE TABLE IF NOT EXISTS keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER,
      public_key BLOB,
      private_key BLOB,
      address VARCHAR(255) UNIQUE,
      token_address VARCHAR(255) UNIQUE,
      pubkey_hash BLOB,
      account_index INTEGER,
      change_index INTEGER,
      address_index INTEGER,
      FOREIGN KEY(wallet_id) REFERENCES wallets(id)
    );
  `);

  // Addresses: derived addresses with balances
  db.run(`
    CREATE TABLE IF NOT EXISTS addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER,
      address VARCHAR(255) NOT NULL UNIQUE,
      token_address VARCHAR(255),
      balance INTEGER DEFAULT 0,
      hd_index INTEGER,
      change_index BOOLEAN,
      prefix VARCHAR(255),
      FOREIGN KEY(wallet_id) REFERENCES wallets(id),
      FOREIGN KEY(address) REFERENCES keys(address)
    );
  `);

  // UTXOs: unspent transaction outputs per wallet/address
  db.run(`
    CREATE TABLE IF NOT EXISTS UTXOs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INT,
      address VARCHAR(255) NOT NULL,
      token_address VARCHAR(255),
      height INT NOT NULL,
      tx_hash TEXT NOT NULL,
      tx_pos INT NOT NULL,
      amount INT NOT NULL,
      prefix VARCHAR(255) NOT NULL,
      token TEXT,
      contractFunction TEXT,
      contractFunctionInputs TEXT,
      FOREIGN KEY(wallet_id) REFERENCES wallets(id),
      FOREIGN KEY(address) REFERENCES addresses(address),
      UNIQUE(wallet_id, address, tx_hash, tx_pos)
    );
  `);

  // Transactions: recorded per wallet
  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INT,
      tx_hash TEXT NOT NULL,
      height INT NOT NULL,
      timestamp TEXT NOT NULL,
      amount INT NOT NULL,
      FOREIGN KEY(wallet_id) REFERENCES wallets(id)
      UNIQUE(wallet_id, tx_hash)
    );
  `);

  // CashScript compilation artifacts
  db.run(`
    CREATE TABLE IF NOT EXISTS cashscript_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_name VARCHAR(255) UNIQUE,
      constructor_inputs TEXT,
      abi TEXT,
      bytecode TEXT,
      source TEXT,
      compiler_name VARCHAR(255),
      compiler_version VARCHAR(255),
      updated_at TEXT
    );
  `);

  // CashScript addresses linked to artifacts
  db.run(`
    CREATE TABLE IF NOT EXISTS cashscript_addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INT,
      address VARCHAR(255) NOT NULL UNIQUE,
      artifact_id INT,
      constructor_args TEXT,
      balance INT,
      prefix VARCHAR(255),
      FOREIGN KEY(wallet_id) REFERENCES wallets(id),
      FOREIGN KEY(artifact_id) REFERENCES cashscript_artifacts(id)
    );
  `);

  // Instantiated contracts with metadata
  db.run(`
    CREATE TABLE IF NOT EXISTS instantiated_contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_name VARCHAR(255),
      address VARCHAR(255) UNIQUE,
      token_address VARCHAR(255),
      opcount INT,
      bytesize INT,
      bytecode TEXT,
      balance INT,
      utxos TEXT,
      created_at TEXT,
      updated_at TEXT,
      artifact TEXT,
      abi TEXT,
      redeemScript TEXT,
      unlock TEXT
    );
  `);

  // BCMR registries (authbase + metadata)
  db.run(`
      CREATE TABLE IF NOT EXISTS bcmr (
        authbase        TEXT PRIMARY KEY,
        registryUri     TEXT NOT NULL,
        lastFetch       TEXT NOT NULL,
        registryHash    TEXT NOT NULL,
        registryData    TEXT NOT NULL
      );
    `);

  db.run(`
      CREATE TABLE IF NOT EXISTS bcmr_tokens (
        category        TEXT PRIMARY KEY,
        authbase        TEXT NOT NULL,
        FOREIGN KEY(authbase) REFERENCES bcmr(authbase)
      );
    `);

  db.run(`
    CREATE TABLE IF NOT EXISTS bcmr_metadata (
      category TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      decimals INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      is_nft BOOLEAN NOT NULL,
      nfts TEXT,
      uris TEXT,
      extensions TEXT,
      FOREIGN KEY(category) REFERENCES bcmr_tokens(category)
    );
  `);
};
