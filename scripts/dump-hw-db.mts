import { chromium } from 'playwright';
import initSqlJs from 'sql.js';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  await page.goto('http://localhost:5173/', {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  });
  await page.waitForTimeout(2500);

  const meta = await page.evaluate(async () => {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('keyval-store');
      open.onerror = () => reject(String(open.error));
      open.onsuccess = () => {
        const db = open.result;
        if (![...db.objectStoreNames].includes('keyval')) {
          resolve({ empty: true, stores: [...db.objectStoreNames] });
          return;
        }
        const tx = db.transaction('keyval', 'readonly');
        const store = tx.objectStore('keyval');
        const req = store.get('OPTNDatabase');
        req.onsuccess = () => {
          const v = req.result;
          if (!v) return resolve({ empty: true });
          const u8 =
            v instanceof ArrayBuffer
              ? new Uint8Array(v)
              : v instanceof Uint8Array
                ? v
                : null;
          resolve({
            empty: !u8,
            len: u8?.length ?? 0,
            type: Object.prototype.toString.call(v),
          });
        };
        req.onerror = () => reject(String(req.error));
      };
    });
  });
  console.log('meta', JSON.stringify(meta));

  if (meta.empty) {
    // try other store names
    const stores = await page.evaluate(async () => {
      return new Promise((resolve) => {
        const req = indexedDB.databases
          ? indexedDB.databases().then(resolve)
          : resolve([]);
      });
    });
    console.log('databases', JSON.stringify(stores));
    process.exit(0);
  }

  const bytes = await page.evaluate(async () => {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('keyval-store');
      open.onerror = () => reject(String(open.error));
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('keyval', 'readonly');
        const store = tx.objectStore('keyval');
        const req = store.get('OPTNDatabase');
        req.onsuccess = () => {
          const v = req.result;
          const u8 =
            v instanceof ArrayBuffer
              ? Array.from(new Uint8Array(v))
              : Array.from(v);
          resolve(u8);
        };
        req.onerror = () => reject(String(req.error));
      };
    });
  });

  const SQL = await initSqlJs();
  const db = new SQL.Database(Uint8Array.from(bytes));

  const q = (sql) => {
    try {
      return db.exec(sql);
    } catch (e) {
      return { error: String(e.message || e) };
    }
  };

  console.log(
    'wallets',
    JSON.stringify(
      q(
        `SELECT id, wallet_name, networkType, walletType, derivation_path,
                CASE WHEN account_xpub IS NULL THEN 0 ELSE length(account_xpub) END AS xpub_len,
                CASE WHEN account_xpub IS NULL THEN NULL ELSE substr(account_xpub,1,12) END AS xpub_pre
         FROM wallets`
      ),
      null,
      2
    )
  );
  console.log(
    'hw_key_counts',
    JSON.stringify(
      q(
        `SELECT w.id, w.wallet_name, w.networkType, COUNT(k.id) AS key_count
         FROM wallets w
         LEFT JOIN keys k ON k.wallet_id = w.id
         WHERE w.walletType = 'hardware'
         GROUP BY w.id`
      ),
      null,
      2
    )
  );
  console.log(
    'wallet12_keys',
    JSON.stringify(
      q(
        `SELECT change_index, address_index, address
         FROM keys WHERE wallet_id = 12
         ORDER BY change_index, address_index LIMIT 8`
      ),
      null,
      2
    )
  );
  console.log(
    'wallet12_utxos',
    JSON.stringify(
      q(
        `SELECT COUNT(*) AS c, IFNULL(SUM(amount),0) AS sats
         FROM UTXOs WHERE wallet_id = 12`
      ),
      null,
      2
    )
  );
  console.log(
    'wallet12_addrs_table',
    JSON.stringify(
      q(`SELECT COUNT(*) AS c FROM addresses WHERE wallet_id = 12`),
      null,
      2
    )
  );
} catch (e) {
  console.error('ERR', e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
