export const createTables = (db: any) => {
    db.run(
        `CREATE TABLE IF NOT EXISTS wallets (
            id INTEGER PRIMARY KEY,
            wallet_name VARCHAR(255),
            mnemonic VARCHAR(255),
            passphrase VARCHAR(255)
        );`
    );

    db.run(`
        CREATE TABLE IF NOT EXISTS keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            wallet_name VARCHAR(255),
            public_key BLOB,
            private_key BLOB,
            address VARCHAR(255),
            FOREIGN KEY(wallet_name) REFERENCES wallets(wallet_name)
        );
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS addresses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            wallet_name VARCHAR(255),
            address VARCHAR(255) NOT NULL,
            balance INT,
            hd_index INT,
            change_index BOOLEAN,
            FOREIGN KEY (address) REFERENCES keys(address)
        );
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS utxos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          wallet_name VARCHAR(255),
          address VARCHAR(255) NOT NULL,
          tx_id TEXT not NULL,
          tx_pos INT not NULL,
          amount INT NOT NULL,
          FOREIGN KEY(address) REFERENCES addresses(address)
        );
    `);
};
