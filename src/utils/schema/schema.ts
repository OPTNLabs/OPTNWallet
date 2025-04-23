export const createTables = (db: any) => {
  // // Drop and create existing tables
  // db.run(`
  //   DROP TABLE IF EXISTS UTXOs;
  // `);
  // db.run(`
  //     DROP TABLE IF EXISTS wallets;
  // `);
  // db.run(`
  //     DROP TABLE IF EXISTS keys;
  // `);
  // db.run(`
  //     DROP TABLE IF EXISTS addresses;
  // `);
  // db.run(`
  //     DROP TABLE IF EXISTS transactions;
  // `);
  // db.run(`
  //   DROP TABLE IF EXISTS cashscript_artifacts;
  // `);
  // db.run(`
  //   DROP TABLE IF EXISTS cashscript_addresses;
  // `);
  // db.run(`
  //   DROP TABLE IF EXISTS instantiated_contracts;
  // `);
  // db.run(`
  //   DROP TABLE IF EXISTS bcmr;
  // `);
  // db.run(`
  //   DROP TABLE IF EXISTS bcmr_tokens;
  // `);

  db.run(`
    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_name VARCHAR(255),
      mnemonic TEXT,
      passphrase TEXT,
      networkType TEXT,
      balance INT
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER,
      public_key BLOB,
      private_key BLOB,
      address VARCHAR(255) UNIQUE,
      token_address VARCHAR(255) UNIQUE,
      pubkey_hash BLOB,
      account_index INT,
      change_index INT,
      address_index INT,
      FOREIGN KEY(wallet_id) REFERENCES wallets(id)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INT,
      address VARCHAR(255) NOT NULL UNIQUE,
      token_address VARCHAR(255),
      balance INT,
      hd_index INT,
      change_index BOOLEAN,
      prefix VARCHAR(255),
      FOREIGN KEY(wallet_id) REFERENCES wallets(id),
      FOREIGN KEY(address) REFERENCES keys(address)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS UTXOs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INT,
      address VARCHAR(255) NOT NULL,
      height INT NOT NULL,
      tx_hash TEXT NOT NULL,
      tx_pos INT NOT NULL,
      amount INT NOT NULL,
      prefix VARCHAR(255) NOT NULL,
      token TEXT,
      contractFunction TEXT, -- New Field
      contractFunctionInputs TEXT, -- New Field
      FOREIGN KEY(wallet_id) REFERENCES wallets(id),
      FOREIGN KEY(address) REFERENCES addresses(address),
      UNIQUE(wallet_id, address, tx_hash, tx_pos)
    );
  `);

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

  // BCMR: “on‑chain metadata registry” cache
  db.run(`
      CREATE TABLE IF NOT EXISTS bcmr (
        authbase        TEXT PRIMARY KEY,        -- 32‑byte hex TXID
        registryUri     TEXT NOT NULL,           -- the URI we fetched from OP_RETURN or DNS
        lastFetch       TEXT NOT NULL,           -- ISO timestamp of when we last refreshed
        registryHash    TEXT NOT NULL,            -- sha256 of the JSON we imported
        registryData    TEXT NOT NULL            -- the raw JSON we fetched
      );
    `);

  // map each token “category” to its authbase
  db.run(`
      CREATE TABLE IF NOT EXISTS bcmr_tokens (
        category        TEXT PRIMARY KEY,        -- cashtoken category hex
        authbase        TEXT NOT NULL,           -- points into bcmr.authbase
        FOREIGN KEY(authbase) REFERENCES bcmr(authbase)
      );
    `);
};
