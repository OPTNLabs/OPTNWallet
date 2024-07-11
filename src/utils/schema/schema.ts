export const createTables = (db: any) => {
  // Drop and create existing tables
  db.run(`
    DROP TABLE IF EXISTS UTXOs;
  `);
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

  db.run(`
    CREATE TABLE IF NOT EXISTS wallets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_name VARCHAR(255),
      mnemonic VARCHAR(255),
      passphrase VARCHAR(255),
      balance INT
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INTEGER,
      public_key BLOB,
      private_key BLOB,
      address VARCHAR(255),
      token_address VARCHAR(255),
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
      address VARCHAR(255) NOT NULL,
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
      token_data TEXT,
      FOREIGN KEY(wallet_id) REFERENCES wallets(id),
      FOREIGN KEY(address) REFERENCES addresses(address)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_id INT,
      txn TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      amount INT NOT NULL
    );
  `);

  // Add a trigger to reset the autoincrement value for the wallets table
  db.run(`
    CREATE TRIGGER IF NOT EXISTS reset_wallet_id
    AFTER DELETE ON wallets
    BEGIN
      UPDATE sqlite_sequence SET seq = (SELECT MAX(id) FROM wallets) WHERE name = 'wallets';
    END;
  `);

  // Create new tables for CashScript artifacts and addresses
  db.run(`
    CREATE TABLE IF NOT EXISTS cashscript_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_name VARCHAR(255),
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
      address VARCHAR(255) NOT NULL,
      artifact_id INT,
      constructor_args TEXT,
      balance INT,
      prefix VARCHAR(255),
      FOREIGN KEY(wallet_id) REFERENCES wallets(id),
      FOREIGN KEY(artifact_id) REFERENCES cashscript_artifacts(id)
    );
  `);
};
