import type { Database } from 'sql.js';

export const WALLET_CHILD_TABLES = [
  'keys',
  'addresses',
  'UTXOs',
  'transactions',
  'transaction_details',
  'cashscript_addresses',
  'quantumroot_vaults',
  'multisig_policies',
  'multisig_cosigners',
  'multisig_addresses',
  'multisig_address_keys',
  'multisig_spend_sessions',
] as const;

type SqlValue = string | number | null | Uint8Array;
type SqlRow = Record<string, SqlValue>;
type WalletChildCopy = {
  table: string;
  columns: string[];
  rows: SqlValue[][];
  sourceIds?: number[];
};

const WALLET_CHILD_TABLES_FOR_DELETION: readonly string[] = [
  'multisig_address_keys',
  ...WALLET_CHILD_TABLES.filter(
    (table) => table !== 'multisig_address_keys'
  ),
];

const GLOBAL_TABLE_KEYS = {
  cashscript_artifacts: 'contract_name',
  cashscript_addresses: 'address',
  instantiated_contracts: 'address',
  bcmr: 'authbase',
  bcmr_tokens: 'category',
  bcmr_metadata: 'category',
} as const;

type GlobalTableName = keyof typeof GLOBAL_TABLE_KEYS;

function globalRowFilter(table: GlobalTableName): string {
  return table === 'cashscript_addresses' ? ' WHERE wallet_id IS NULL' : '';
}

export type GlobalTableSnapshot = Partial<
  Record<
    GlobalTableName,
    {
      columns: string[];
      rows: Map<string, SqlRow>;
    }
  >
>;

function quoted(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function tableExists(database: Database, table: string): boolean {
  const statement = database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
  );
  statement.bind([table]);
  const exists = statement.step();
  statement.free();
  return exists;
}

function tableColumns(database: Database, table: string): string[] {
  const columns: string[] = [];
  const statement = database.prepare(`PRAGMA table_info(${quoted(table)})`);
  while (statement.step()) {
    const row = statement.getAsObject() as Record<string, unknown>;
    if (typeof row.name === 'string') columns.push(row.name);
  }
  statement.free();
  return columns;
}

function normalizeSqlValue(value: unknown): SqlValue {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value;
  throw new Error('Unsupported SQLite value while merging wallet data.');
}

function readRows(
  database: Database,
  table: string,
  columns: string[],
  selectorColumn: 'id' | 'wallet_id',
  walletId: number
): SqlValue[][] {
  const statement = database.prepare(
    `SELECT ${columns.map(quoted).join(', ')}
       FROM ${quoted(table)}
      WHERE ${quoted(selectorColumn)} = ?`
  );
  statement.bind([walletId]);
  const rows: SqlValue[][] = [];
  while (statement.step()) {
    const row = statement.getAsObject() as Record<string, unknown>;
    rows.push(columns.map((column) => normalizeSqlValue(row[column])));
  }
  statement.free();
  return rows;
}

function insertRows(
  database: Database,
  table: string,
  columns: string[],
  rows: SqlValue[][]
): void {
  if (rows.length === 0) return;
  const placeholders = columns.map(() => '?').join(', ');
  const statement = database.prepare(
    `INSERT INTO ${quoted(table)} (${columns.map(quoted).join(', ')})
     VALUES (${placeholders})`
  );
  for (const row of rows) statement.run(row);
  statement.free();
}

function generatedRowId(database: Database): number {
  const statement = database.prepare('SELECT last_insert_rowid() AS id');
  try {
    if (!statement.step()) {
      throw new Error('Could not read generated SQLite row id.');
    }
    const id = statement.getAsObject().id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error('SQLite generated an invalid row id.');
    }
    return id;
  } finally {
    statement.free();
  }
}

function insertMultisigAddresses(
  database: Database,
  copy: WalletChildCopy,
  addressIds: Map<number, number>
): void {
  if (!copy.sourceIds || copy.sourceIds.length !== copy.rows.length) {
    throw new Error('Multisig address merge is missing source row ids.');
  }
  if (copy.rows.length === 0) return;
  const statement = database.prepare(
    `INSERT INTO ${quoted(copy.table)} (${copy.columns.map(quoted).join(', ')})
     VALUES (${copy.columns.map(() => '?').join(', ')})`
  );
  try {
    for (const [index, row] of copy.rows.entries()) {
      statement.run(row);
      addressIds.set(copy.sourceIds[index], generatedRowId(database));
    }
  } finally {
    statement.free();
  }
}

function remapMultisigAddressKeys(
  copy: WalletChildCopy,
  addressIds: Map<number, number>
): SqlValue[][] {
  const addressIdIndex = copy.columns.indexOf('address_id');
  if (addressIdIndex === -1) return copy.rows;
  return copy.rows.map((row) => {
    const sourceAddressId = row[addressIdIndex];
    if (
      typeof sourceAddressId !== 'number' ||
      !Number.isSafeInteger(sourceAddressId) ||
      sourceAddressId <= 0
    ) {
      throw new Error('Multisig address key has an invalid address id.');
    }
    const addressId = addressIds.get(sourceAddressId);
    if (addressId === undefined) {
      throw new Error(
        'Multisig address key refers to an address missing from this wallet merge.'
      );
    }
    const remapped = [...row];
    remapped[addressIdIndex] = addressId;
    return remapped;
  });
}

function valueEquals(left: SqlValue | undefined, right: SqlValue | undefined) {
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return (
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }
  return left === right;
}

function valueFingerprint(value: SqlValue): string {
  if (value instanceof Uint8Array) {
    return `b:${Array.from(value, (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('')}`;
  }
  if (value === null) return 'n:';
  return `${typeof value === 'number' ? 'd' : 's'}:${String(value)}`;
}

function rowEquals(
  left: SqlRow | undefined,
  right: SqlRow | undefined,
  columns: string[]
): boolean {
  if (!left || !right) return left === right;
  return columns.every((column) => valueEquals(left[column], right[column]));
}

function readRowsByKey(
  database: Database,
  table: GlobalTableName,
  keyColumn: string,
  columns: string[]
): Map<string, SqlRow> {
  const rows = new Map<string, SqlRow>();
  if (
    !tableExists(database, table) ||
    !columns.includes(keyColumn) ||
    columns.length === 0
  ) {
    return rows;
  }
  const statement = database.prepare(
    `SELECT ${columns.map(quoted).join(', ')}
       FROM ${quoted(table)}${globalRowFilter(table)}`
  );
  while (statement.step()) {
    const raw = statement.getAsObject() as Record<string, unknown>;
    const row: SqlRow = {};
    for (const column of columns) {
      row[column] = normalizeSqlValue(raw[column]);
    }
    const key = row[keyColumn];
    if (typeof key === 'string' && key.length > 0) rows.set(key, row);
  }
  statement.free();
  return rows;
}

export function snapshotGlobalTables(database: Database): GlobalTableSnapshot {
  const snapshot: GlobalTableSnapshot = {};
  for (const [table, keyColumn] of Object.entries(GLOBAL_TABLE_KEYS) as Array<
    [GlobalTableName, string]
  >) {
    if (!tableExists(database, table)) continue;
    const columns = tableColumns(database, table).filter(
      (column) => column !== 'id'
    );
    snapshot[table] = {
      columns,
      rows: readRowsByKey(database, table, keyColumn, columns),
    };
  }
  return snapshot;
}

/**
 * Canonical content fingerprint for one wallet, excluding auto-generated child
 * row IDs. Windows use this as an optimistic-concurrency token: a stale window
 * may never replace wallet rows changed by another window.
 */
export function walletScopeFingerprint(
  database: Database,
  walletId: number
): string | null {
  if (!tableExists(database, 'wallets')) return null;
  const walletColumns = tableColumns(database, 'wallets').sort();
  const walletRows = readRows(
    database,
    'wallets',
    walletColumns,
    'id',
    walletId
  );
  if (walletRows.length !== 1) return null;

  const tables: Array<[string, string[], string[][]]> = [
    [
      'wallets',
      walletColumns,
      walletRows.map((row) => row.map(valueFingerprint)),
    ],
  ];
  for (const table of WALLET_CHILD_TABLES) {
    if (!tableExists(database, table)) continue;
    const columns = tableColumns(database, table)
      .filter((column) => column !== 'id')
      .sort();
    if (!columns.includes('wallet_id')) continue;
    const rows = readRows(database, table, columns, 'wallet_id', walletId)
      .map((row) => row.map(valueFingerprint))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      );
    tables.push([table, columns, rows]);
  }
  return JSON.stringify(tables);
}

function upsertGlobalRow(
  database: Database,
  table: GlobalTableName,
  keyColumn: string,
  columns: string[],
  row: SqlRow
): void {
  const updateColumns = columns.filter((column) => column !== keyColumn);
  const conflictAction =
    updateColumns.length > 0
      ? `DO UPDATE SET ${updateColumns
          .map((column) => `${quoted(column)} = excluded.${quoted(column)}`)
          .join(', ')}`
      : 'DO NOTHING';
  const statement = database.prepare(
    `INSERT INTO ${quoted(table)} (${columns.map(quoted).join(', ')})
     VALUES (${columns.map(() => '?').join(', ')})
     ON CONFLICT(${quoted(keyColumn)}) ${conflictAction}`
  );
  statement.run(columns.map((column) => row[column]));
  statement.free();
}

function remapGlobalReferences(
  latest: Database,
  local: Database,
  table: GlobalTableName,
  row: SqlRow
): SqlRow {
  if (table !== 'cashscript_addresses' || row.artifact_id == null) return row;
  const localArtifact = local.prepare(
    'SELECT contract_name FROM cashscript_artifacts WHERE id = ? LIMIT 1'
  );
  localArtifact.bind([row.artifact_id]);
  const contractName = localArtifact.step()
    ? localArtifact.getAsObject().contract_name
    : null;
  localArtifact.free();
  if (typeof contractName !== 'string') {
    return { ...row, artifact_id: null };
  }

  const latestArtifact = latest.prepare(
    'SELECT id FROM cashscript_artifacts WHERE contract_name = ? LIMIT 1'
  );
  latestArtifact.bind([contractName]);
  const artifactId = latestArtifact.step()
    ? latestArtifact.getAsObject().id
    : null;
  latestArtifact.free();
  return {
    ...row,
    artifact_id:
      typeof artifactId === 'number' && Number.isSafeInteger(artifactId)
        ? artifactId
        : null,
  };
}

/**
 * Apply only global-table rows changed by this window since its baseline.
 * Concurrent changes win conflicts; unchanged stale rows never replace latest.
 */
export function mergeGlobalChanges(
  latest: Database,
  local: Database,
  baseline: GlobalTableSnapshot
): void {
  for (const [table, keyColumn] of Object.entries(GLOBAL_TABLE_KEYS) as Array<
    [GlobalTableName, string]
  >) {
    const base = baseline[table];
    if (!base || !tableExists(latest, table) || !tableExists(local, table)) {
      continue;
    }
    const latestColumns = new Set(tableColumns(latest, table));
    const columns = tableColumns(local, table).filter(
      (column) => column !== 'id' && latestColumns.has(column)
    );
    if (!columns.includes(keyColumn)) continue;

    const localRows = readRowsByKey(local, table, keyColumn, columns);
    const latestRows = readRowsByKey(latest, table, keyColumn, columns);
    const baseRows = base.rows;
    const keys = new Set([...baseRows.keys(), ...localRows.keys()]);

    for (const key of keys) {
      const baseRow = baseRows.get(key);
      const localRow = localRows.get(key);
      if (rowEquals(localRow, baseRow, columns)) continue;

      const latestRow = latestRows.get(key);
      if (!rowEquals(latestRow, baseRow, columns)) {
        // Another window changed this row after our baseline. Preserve it.
        continue;
      }
      if (!localRow) {
        latest.run(
          `DELETE FROM ${quoted(table)} WHERE ${quoted(keyColumn)} = ?`,
          [key]
        );
        continue;
      }
      upsertGlobalRow(
        latest,
        table,
        keyColumn,
        columns,
        remapGlobalReferences(latest, local, table, localRow)
      );
    }
  }
}

export function deleteWalletScope(database: Database, walletId: number): void {
  if (!Number.isSafeInteger(walletId) || walletId <= 0) {
    throw new Error('Invalid wallet id for database deletion.');
  }
  database.run('BEGIN IMMEDIATE');
  try {
    for (const table of WALLET_CHILD_TABLES_FOR_DELETION) {
      if (tableExists(database, table)) {
        database.run(
          `DELETE FROM ${quoted(table)} WHERE ${quoted('wallet_id')} = ?`,
          [walletId]
        );
      }
    }
    database.run(`DELETE FROM ${quoted('wallets')} WHERE id = ?`, [walletId]);
    database.run('COMMIT');
  } catch (error) {
    try {
      database.run('ROLLBACK');
    } catch {
      // Preserve the original deletion error.
    }
    throw error;
  }
}

/**
 * Remap a newly-created wallet and all of its child rows after a concurrent
 * window has already claimed the same SQLite id.
 */
export function remapWalletScopeId(
  database: Database,
  fromWalletId: number,
  toWalletId: number
): void {
  if (
    !Number.isSafeInteger(fromWalletId) ||
    fromWalletId <= 0 ||
    !Number.isSafeInteger(toWalletId) ||
    toWalletId <= 0
  ) {
    throw new Error('Invalid wallet id remap.');
  }
  database.run('BEGIN IMMEDIATE');
  try {
    for (const table of WALLET_CHILD_TABLES) {
      if (!tableExists(database, table)) continue;
      database.run(
        `UPDATE ${quoted(table)} SET ${quoted('wallet_id')} = ?
         WHERE ${quoted('wallet_id')} = ?`,
        [toWalletId, fromWalletId]
      );
    }
    database.run('UPDATE wallets SET id = ? WHERE id = ?', [
      toWalletId,
      fromWalletId,
    ]);
    database.run('COMMIT');
  } catch (error) {
    try {
      database.run('ROLLBACK');
    } catch {
      // Preserve the original remap error.
    }
    throw error;
  }
}

/**
 * Replace one wallet's rows in `latest` with that wallet's rows from `local`.
 * Integer child-row IDs are deliberately regenerated: separate sql.js windows
 * can allocate the same IDs, while wallet IDs and address/outpoint identities
 * remain stable.
 */
export function mergeWalletScope(
  latest: Database,
  local: Database,
  walletId: number
): void {
  if (!Number.isSafeInteger(walletId) || walletId <= 0) {
    throw new Error('Invalid wallet id for database merge.');
  }
  if (!tableExists(latest, 'wallets') || !tableExists(local, 'wallets')) {
    throw new Error('Wallet database is missing its wallets table.');
  }

  const walletColumns = tableColumns(local, 'wallets').filter((column) =>
    tableColumns(latest, 'wallets').includes(column)
  );
  const walletRows = readRows(local, 'wallets', walletColumns, 'id', walletId);
  if (walletRows.length !== 1) {
    throw new Error(`Wallet ${walletId} is missing from the local database.`);
  }

  const childCopies: WalletChildCopy[] = [];
  for (const table of WALLET_CHILD_TABLES) {
    if (!tableExists(latest, table) || !tableExists(local, table)) continue;
    const latestColumns = new Set(tableColumns(latest, table));
    const columns = tableColumns(local, table).filter(
      (column) => column !== 'id' && latestColumns.has(column)
    );
    if (!columns.includes('wallet_id')) continue;
    if (table === 'multisig_addresses') {
      const rowsWithIds = readRows(
        local,
        table,
        ['id', ...columns],
        'wallet_id',
        walletId
      );
      const sourceIds = rowsWithIds.map(([id]) => {
        if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
          throw new Error('Multisig address has an invalid source row id.');
        }
        return id;
      });
      childCopies.push({
        table,
        columns,
        rows: rowsWithIds.map((row) => row.slice(1)),
        sourceIds,
      });
      continue;
    }
    childCopies.push({
      table,
      columns,
      rows: readRows(local, table, columns, 'wallet_id', walletId),
    });
  }

  latest.run('BEGIN IMMEDIATE');
  try {
    const copiesForDeletion = [...childCopies].sort(
      (left, right) =>
        WALLET_CHILD_TABLES_FOR_DELETION.indexOf(left.table) -
        WALLET_CHILD_TABLES_FOR_DELETION.indexOf(right.table)
    );
    for (const copy of copiesForDeletion) {
      latest.run(
        `DELETE FROM ${quoted(copy.table)} WHERE ${quoted('wallet_id')} = ?`,
        [walletId]
      );
    }

    const updateColumns = walletColumns.filter((column) => column !== 'id');
    const walletInsert = latest.prepare(
      `INSERT INTO ${quoted('wallets')} (${walletColumns
        .map(quoted)
        .join(', ')})
       VALUES (${walletColumns.map(() => '?').join(', ')})
       ON CONFLICT(${quoted('id')}) DO UPDATE SET
       ${updateColumns
         .map((column) => `${quoted(column)} = excluded.${quoted(column)}`)
         .join(', ')}`
    );
    walletInsert.run(walletRows[0]);
    walletInsert.free();

    const addressIds = new Map<number, number>();
    for (const copy of childCopies) {
      if (copy.table === 'multisig_addresses') {
        insertMultisigAddresses(latest, copy, addressIds);
      } else if (copy.table === 'multisig_address_keys') {
        insertRows(
          latest,
          copy.table,
          copy.columns,
          remapMultisigAddressKeys(copy, addressIds)
        );
      } else {
        insertRows(latest, copy.table, copy.columns, copy.rows);
      }
    }
    latest.run('COMMIT');
  } catch (error) {
    try {
      latest.run('ROLLBACK');
    } catch {
      // Preserve the original merge error.
    }
    throw error;
  }
}
