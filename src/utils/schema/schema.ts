export const createTables = (db: any) => {
    db.run(
        `CREATE TABLE IF NOT EXISTS wallets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            wallet_name VARCHAR(255),
            mnemonic VARCHAR(255),
            passphrase VARCHAR(255),
            balance INT
        );`
    );

    db.run(`
        CREATE TABLE IF NOT EXISTS keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            wallet_id VARCHAR(255),
            public_key BLOB,
            private_key BLOB,
            address VARCHAR(255),
            FOREIGN KEY(wallet_id) REFERENCES wallets(id)
        );
    `);
    const getAllKeysQuery = db.prepare("SELECT * FROM wallets;");
    console.log('All keys in the keys table:');
    while (getAllKeysQuery.step()) {
        const row = getAllKeysQuery.getAsObject();
        console.log('row', row);
    }

    db.run(`
        CREATE TABLE IF NOT EXISTS addresses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            wallet_id INT,
            address VARCHAR(255) NOT NULL,
            balance INT,
            hd_index INT,
            change_index BOOLEAN,
            prefix VARCHAR(255),
            FOREIGN KEY (wallet_id) REFERENCES wallets(id),
            FOREIGN KEY (address) REFERENCES keys(address)
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
          private_key BLOB,
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
};
