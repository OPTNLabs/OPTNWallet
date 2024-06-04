export const createTables = (db: any) => {
    db.run(
        `DROP TABLE IF EXISTS addresses;`
    );
    db.run(
        `DROP TABLE IF EXISTS wallets;`
    );
    db.run(
        `DROP TABLE IF EXISTS UTXOs;`
    );

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
            prefix VARCHAR(255),
            FOREIGN KEY (wallet_name) REFERENCES wallets(wallet_name),
            FOREIGN KEY (address) REFERENCES keys(address)
        );
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS UTXOs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          wallet_name VARCHAR(255),
          address VARCHAR(255) NOT NULL,
          height INT NOT NULL,
          tx_hash TEXT NOT NULL,
          tx_pos INT NOT NULL,
          amount INT NOT NULL,
          prefix VARCHAR(255) NOT NULL,
          FOREIGN KEY(wallet_name) REFERENCES wallets(wallet_name),
          FOREIGN KEY(address) REFERENCES addresses(address)
        );
    `);
};
