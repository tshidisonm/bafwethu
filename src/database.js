import { sqlite3Worker1Promiser } from "@sqlite.org/sqlite-wasm";
import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { createId, describeError, logEvent, startLogChain } from "./logger.js";

let databaseChain;
let database;
let sqlPromise;
let initializationPromise;
const LOCAL_DATABASE_NAME = "bafwethu-local-database";
const LOCAL_DATABASE_STORE = "data";
const LOCAL_DATABASE_KEY = "database";

function openLocalDatabaseStore() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LOCAL_DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(LOCAL_DATABASE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open local database storage."));
  });
}

async function readLocalDatabase() {
  const storage = await openLocalDatabaseStore();
  try {
    const value = await new Promise((resolve, reject) => {
      const request = storage.transaction(LOCAL_DATABASE_STORE).objectStore(LOCAL_DATABASE_STORE).get(LOCAL_DATABASE_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Could not read local database storage."));
    });
    return value ? new Uint8Array(value) : null;
  } finally {
    storage.close();
  }
}

async function writeLocalDatabase(bytes) {
  const storage = await openLocalDatabaseStore();
  try {
    await new Promise((resolve, reject) => {
      const transaction = storage.transaction(LOCAL_DATABASE_STORE, "readwrite");
      transaction.objectStore(LOCAL_DATABASE_STORE).put(new Uint8Array(bytes), LOCAL_DATABASE_KEY);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Could not save local database storage."));
      transaction.onabort = () => reject(transaction.error || new Error("Saving local database storage was aborted."));
    });
  } finally {
    storage.close();
  }
}

const schema = [
  `CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY,
    member_no TEXT NOT NULL UNIQUE,
    first_name TEXT NOT NULL,
    surname TEXT NOT NULL,
    phone TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('Active', 'Inactive')),
    email TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY,
    member_id INTEGER NOT NULL REFERENCES members(id),
    contribution_month TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
    paid_at TEXT NOT NULL,
    method TEXT NOT NULL,
    reference TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    receipt_no TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS payment_reversals (
    id INTEGER PRIMARY KEY,
    payment_id INTEGER NOT NULL UNIQUE REFERENCES payments(id),
    reason TEXT NOT NULL,
    user_name TEXT NOT NULL,
    reversed_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS society_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY,
    action TEXT NOT NULL,
    record_type TEXT NOT NULL,
    record_id TEXT NOT NULL,
    details TEXT NOT NULL,
    user_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS app_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_payments_month_member ON payments(contribution_month, member_id)",
  "CREATE INDEX IF NOT EXISTS idx_payments_paid_at ON payments(paid_at)"
];

const defaults = {
  society_name: "BAFWETHU SOCIETY",
  tagline: "Together We Grow, Stronger We Are",
  monthly_contribution_cents: "50000",
  contact_person: "",
  phone: "",
  email: "",
  primary_color: "#14263d",
  secondary_color: "#d9ae54",
  last_backup_at: ""
};

async function rows(db, sql, bind = []) {
  try {
    const statement = db.prepare(sql);
    statement.bind(bind);
    const result = [];
    while (statement.step()) result.push(statement.getAsObject());
    statement.free();
    return result;
  } catch (error) {
    logEvent("error", "database.query.failed", { operation: sql.trim().split(/\s+/, 1)[0], ...describeError(error) }, databaseChain?.id);
    throw error;
  }
}

async function run(db, sql, bind = []) {
  try {
    db.run(sql, bind);
  } catch (error) {
    logEvent("error", "database.command.failed", { operation: sql.trim().split(/\s+/, 1)[0], ...describeError(error) }, databaseChain?.id);
    throw error;
  }
}

async function audit(db, action, type, id, details) {
  await run(
    db,
    "INSERT INTO audit_logs(action, record_type, record_id, details, user_name, created_at) VALUES(?, ?, ?, ?, ?, ?)",
    [action, type, String(id), details, "Administrator", new Date().toISOString()]
  );
}

function validDate(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function getDatabase() {
  if (!database) throw new Error("The local society database is not available.");
  return database;
}

async function getSql() {
  if (!sqlPromise) sqlPromise = initSqlJs({ locateFile: () => wasmUrl });
  return sqlPromise;
}

async function makeDatabase(bytes) {
  const SQL = await getSql();
  const db = new SQL.Database(bytes ? new Uint8Array(bytes) : undefined);
  try {
    for (const statement of schema) db.run(statement);
    for (const [key, value] of Object.entries(defaults)) {
      db.run("INSERT OR IGNORE INTO society_settings(key, value) VALUES(?, ?)", [key, value]);
    }
    db.run("INSERT OR IGNORE INTO app_metadata(key, value) VALUES('schema_version', '1')");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

async function readLegacySnapshot() {
  const root = await navigator.storage?.getDirectory?.();
  if (!root) return null;
  try {
    await root.getFileHandle("bafwethu-society.sqlite3");
  } catch (error) {
    if (error?.name === "NotFoundError") return null;
    throw new Error(`Could not check for the previous local database: ${describeError(error).message}`);
  }

  const client = await sqlite3Worker1Promiser.v2();
  let opened = false;
  try {
    await client("open", { filename: "file:bafwethu-society.sqlite3?vfs=opfs" });
    opened = true;
    const readRows = async (sql) => {
      const response = await client("exec", { sql, rowMode: "object", returnValue: "resultRows" });
      return response.result.resultRows;
    };
    const tables = new Set((await readRows("SELECT name FROM sqlite_master WHERE type='table'")).map(({ name }) => name));
    const requiredTables = ["members", "payments", "payment_reversals", "society_settings", "audit_logs", "app_metadata"];
    if (!requiredTables.every((table) => tables.has(table))) {
      throw new Error("The previous local database is incomplete. Export its JSON backup from the previous app before continuing.");
    }
    const settingRows = await readRows("SELECT key, value FROM society_settings");
    return validateBackup({
      application: "Bafwethu Society",
      format_version: 1,
      schema_version: 1,
      backup_created_at: new Date().toISOString(),
      currency: "ZAR",
      members: await readRows("SELECT * FROM members ORDER BY member_no"),
      payments: await readRows("SELECT * FROM payments ORDER BY id"),
      payment_reversals: await readRows("SELECT * FROM payment_reversals ORDER BY id"),
      society_settings: Object.fromEntries(settingRows.map(({ key, value }) => [key, value])),
      audit_logs: await readRows("SELECT * FROM audit_logs ORDER BY id"),
      app_metadata: await readRows("SELECT * FROM app_metadata")
    });
  } catch (error) {
    throw new Error(`Could not migrate the previous local database. It has not been deleted or changed. ${describeError(error).message}`);
  } finally {
    if (opened) await client("close", {});
  }
}

function importSnapshot(db, data) {
  if (!data) return;
  const tables = ["payment_reversals", "payments", "members", "society_settings", "audit_logs", "app_metadata"];
  for (const table of tables) db.run(`DELETE FROM ${table}`);
  const insert = (table, columns, values) => {
    const marks = columns.map(() => "?").join(", ");
    const statement = db.prepare(`INSERT INTO ${table}(${columns.join(", ")}) VALUES(${marks})`);
    try {
      for (const row of values) statement.run(row);
    } finally {
      statement.free();
    }
  };
  insert("members", ["id", "member_no", "first_name", "surname", "phone", "joined_at", "status", "email", "notes", "created_at", "updated_at"],
    data.members.map((item) => [item.id, item.member_no, item.first_name, item.surname, item.phone, item.joined_at, item.status, item.email || "", item.notes || "", item.created_at, item.updated_at]));
  insert("payments", ["id", "member_id", "contribution_month", "amount_cents", "paid_at", "method", "reference", "notes", "receipt_no", "created_at"],
    data.payments.map((item) => [item.id, item.member_id, item.contribution_month, item.amount_cents, item.paid_at, item.method, item.reference || "", item.notes || "", item.receipt_no, item.created_at]));
  insert("payment_reversals", ["id", "payment_id", "reason", "user_name", "reversed_at"],
    data.payment_reversals.map((item) => [item.id, item.payment_id, item.reason, item.user_name, item.reversed_at]));
  insert("society_settings", ["key", "value"], Object.entries(data.society_settings).map(([key, value]) => [key, String(value)]));
  insert("audit_logs", ["id", "action", "record_type", "record_id", "details", "user_name", "created_at"],
    data.audit_logs.map((item) => [item.id, item.action, item.record_type, item.record_id, item.details, item.user_name, item.created_at]));
  insert("app_metadata", ["key", "value"], data.app_metadata.map((item) => [item.key, item.value]));
}

export function initializeLocalDatabase() {
  if (database) return Promise.resolve({});
  if (!initializationPromise) {
    initializationPromise = initializeLocalDatabaseOnce().catch((error) => {
      initializationPromise = undefined;
      throw error;
    });
  }
  return initializationPromise;
}

async function initializeLocalDatabaseOnce() {
  if (database) return {};
  databaseChain = startLogChain("database.initialize");
  let db;
  try {
    const localBytes = await readLocalDatabase();
    if (localBytes) {
      db = await makeDatabase(localBytes);
      database = db;
      databaseChain.info("database.local.loaded", { tableCount: 6 });
      return {};
    }

    const legacySnapshot = await readLegacySnapshot();
    db = await makeDatabase();
    importSnapshot(db, legacySnapshot);
    await writeLocalDatabase(db.export());
    database = db;
    databaseChain.info("database.local.initialized", { tableCount: 6, migratedLegacyRecords: Boolean(legacySnapshot) });
    return legacySnapshot ? {
      migratedCounts: { members: legacySnapshot.members.length, payments: legacySnapshot.payments.length }
    } : {};
  } catch (error) {
    if (db && database !== db) db.close();
    databaseChain.error("database.initialize.failed", error);
    throw error;
  }
}

async function persist(db) {
  try {
    await writeLocalDatabase(db.export());
  } catch (error) {
    logEvent("error", "database.local.persist_failed", describeError(error), databaseChain?.id);
    throw error;
  }
}

export async function getSnapshot() {
  const db = await getDatabase();
  const settingRows = await rows(db, "SELECT key, value FROM society_settings");
  const settings = Object.fromEntries(settingRows.map(({ key, value }) => [key, value]));
  return {
    application: "Bafwethu Society",
    format_version: 1,
    schema_version: 1,
    backup_created_at: new Date().toISOString(),
    currency: "ZAR",
    members: await rows(db, "SELECT * FROM members ORDER BY member_no"),
    payments: await rows(db, "SELECT * FROM payments ORDER BY id"),
    payment_reversals: await rows(db, "SELECT * FROM payment_reversals ORDER BY id"),
    society_settings: settings,
    audit_logs: await rows(db, "SELECT * FROM audit_logs ORDER BY id"),
    app_metadata: await rows(db, "SELECT * FROM app_metadata")
  };
}

export async function saveMember(input, id) {
  const db = await getDatabase();
  if (!input.first_name.trim() || !input.surname.trim() || !input.phone.trim() || !validDate(input.joined_at)
    || !["Active", "Inactive"].includes(input.status)) {
    throw new Error("Enter the member's name, phone number, valid join date, and membership status.");
  }
  const now = new Date().toISOString();
  if (id) {
    await run(db, `UPDATE members SET first_name=?, surname=?, phone=?, joined_at=?, status=?, email=?, notes=?, updated_at=? WHERE id=?`,
      [input.first_name.trim(), input.surname.trim(), input.phone.trim(), input.joined_at, input.status, input.email.trim(), input.notes.trim(), now, id]);
    await audit(db, "member_updated", "member", id, "Member details updated");
    await persist(db);
    return id;
  }
  const existing = (await rows(db, "SELECT member_no FROM members ORDER BY CAST(member_no AS INTEGER) DESC LIMIT 1"))[0];
  const memberNo = String((Number(existing?.member_no) || 0) + 1).padStart(3, "0");
  await run(db, `INSERT INTO members(member_no, first_name, surname, phone, joined_at, status, email, notes, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [memberNo, input.first_name.trim(), input.surname.trim(), input.phone.trim(), input.joined_at, input.status, input.email.trim(), input.notes.trim(), now, now]);
  const idNew = (await rows(db, "SELECT last_insert_rowid() AS id"))[0].id;
  await audit(db, "member_created", "member", idNew, `Member ${memberNo} added`);
  await persist(db);
  return idNew;
}

export async function savePayment(input, allowAdditional) {
  const db = await getDatabase();
  if (!Number.isInteger(input.amount_cents) || input.amount_cents <= 0) throw new Error("Enter a payment amount greater than zero.");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.contribution_month)) throw new Error("Choose a valid contribution month.");
  if (!["EFT", "Cash", "Bank Deposit", "Other"].includes(input.method)) throw new Error("Choose a valid payment method.");
  if (["EFT", "Bank Deposit"].includes(input.method) && !input.reference.trim()) throw new Error("Enter the transaction reference for this payment method.");
  await run(db, "BEGIN IMMEDIATE");
  try {
    const member = (await rows(db, "SELECT * FROM members WHERE id=? AND status='Active'", [input.member_id]))[0];
    if (!member) throw new Error("Choose an active member before recording a payment.");
    const previous = (await rows(db, `SELECT COALESCE(SUM(p.amount_cents), 0) AS total
      FROM payments p LEFT JOIN payment_reversals r ON r.payment_id=p.id
      WHERE p.member_id=? AND p.contribution_month=? AND r.id IS NULL`,
      [input.member_id, input.contribution_month]))[0].total;
    if (previous > 0 && !allowAdditional) {
      throw new Error("A payment already exists for this member and month. Confirm an additional or partial payment to continue.");
    }
    const now = new Date().toISOString();
    const receiptNo = `BFS-${new Date().getFullYear()}-${createId().slice(0, 8).toUpperCase()}`;
    await run(db, `INSERT INTO payments(member_id, contribution_month, amount_cents, paid_at, method, reference, notes, receipt_no, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.member_id, input.contribution_month, input.amount_cents, input.paid_at, input.method, input.reference.trim(), input.notes.trim(), receiptNo, now]);
    const id = (await rows(db, "SELECT last_insert_rowid() AS id"))[0].id;
    await audit(db, "payment_recorded", "payment", id, `Receipt ${receiptNo}; amount ${input.amount_cents} cents`);
    await run(db, "COMMIT");
    await persist(db);
    return id;
  } catch (error) {
    await run(db, "ROLLBACK");
    throw error;
  }
}

export async function reversePayment(id, reason) {
  const db = await getDatabase();
  await run(db, "BEGIN IMMEDIATE");
  try {
    await run(db, "INSERT INTO payment_reversals(payment_id, reason, user_name, reversed_at) VALUES(?, ?, ?, ?)",
      [id, reason.trim(), "Administrator", new Date().toISOString()]);
    await audit(db, "payment_reversed", "payment", id, reason.trim());
    await run(db, "COMMIT");
    await persist(db);
  } catch (error) {
    await run(db, "ROLLBACK");
    throw error;
  }
}

export async function saveSettings(settings) {
  if ("monthly_contribution_cents" in settings
    && (!Number.isInteger(Number(settings.monthly_contribution_cents)) || Number(settings.monthly_contribution_cents) <= 0)) {
    throw new Error("The standard monthly contribution must be greater than zero.");
  }
  const db = await getDatabase();
  for (const [key, value] of Object.entries(settings)) {
    await run(db, "INSERT INTO society_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, String(value)]);
  }
  await audit(db, "settings_updated", "settings", "society", "Society settings updated");
  await persist(db);
}

export function validateBackup(data) {
  const required = ["members", "payments", "payment_reversals", "society_settings", "audit_logs", "app_metadata"];
  if (!data || data.application !== "Bafwethu Society" || data.format_version !== 1
    || !required.every((key) => Array.isArray(data[key]) || (key === "society_settings" && typeof data[key] === "object" && data[key] !== null && !Array.isArray(data[key])))) {
    throw new Error("This file is not a supported Bafwethu Society backup.");
  }
  const memberIds = new Set(data.members.map((member) => member.id));
  const memberNumbers = new Set();
  for (const member of data.members) {
    if (!Number.isInteger(member.id) || member.id <= 0 || !member.member_no || memberNumbers.has(member.member_no)
      || !member.first_name?.trim() || !member.surname?.trim() || !member.phone?.trim()
      || !["Active", "Inactive"].includes(member.status) || !validDate(member.joined_at)) {
      throw new Error("The backup contains an invalid or duplicate member record.");
    }
    memberNumbers.add(member.member_no);
  }
  if (memberIds.size !== data.members.length
    || !Number.isInteger(Number(data.society_settings.monthly_contribution_cents))
    || Number(data.society_settings.monthly_contribution_cents) <= 0
    || !data.society_settings.society_name) {
    throw new Error("The backup is missing required society settings or contains duplicate member IDs.");
  }
  const receiptNumbers = new Set();
  const paymentIds = new Set();
  for (const payment of data.payments) {
    if (!Number.isInteger(payment.id) || payment.id <= 0 || !memberIds.has(payment.member_id)
      || paymentIds.has(payment.id)
      || !Number.isInteger(payment.amount_cents) || payment.amount_cents <= 0
      || !/^\d{4}-(0[1-9]|1[0-2])$/.test(payment.contribution_month)
      || !validDate(payment.paid_at)
      || !["EFT", "Cash", "Bank Deposit", "Other"].includes(payment.method)
      || !payment.receipt_no || receiptNumbers.has(payment.receipt_no)) {
      throw new Error("The backup contains an invalid payment or member reference.");
    }
    paymentIds.add(payment.id);
    receiptNumbers.add(payment.receipt_no);
  }
  if (!Array.isArray(data.app_metadata) || !data.app_metadata.some((item) => item.key === "schema_version" && item.value === "1")) {
    throw new Error("The backup is missing supported database schema metadata.");
  }
  const reversedPayments = new Set();
  if (data.payment_reversals.some((reversal) => {
    if (!paymentIds.has(reversal.payment_id) || !reversal.reason?.trim() || reversedPayments.has(reversal.payment_id)) return true;
    reversedPayments.add(reversal.payment_id);
    return false;
  })) {
    throw new Error("The backup contains a reversal without a matching payment.");
  }
  return data;
}

export async function restoreSnapshot(data) {
  validateBackup(data);
  const db = await getDatabase();
  await run(db, "BEGIN IMMEDIATE");
  try {
    for (const table of ["payment_reversals", "payments", "members", "society_settings", "audit_logs", "app_metadata"]) await run(db, `DELETE FROM ${table}`);
    for (const member of data.members) {
      await run(db, `INSERT INTO members(id, member_no, first_name, surname, phone, joined_at, status, email, notes, created_at, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [member.id, member.member_no, member.first_name, member.surname, member.phone, member.joined_at, member.status, member.email || "", member.notes || "", member.created_at, member.updated_at]);
    }
    for (const payment of data.payments) {
      await run(db, `INSERT INTO payments(id, member_id, contribution_month, amount_cents, paid_at, method, reference, notes, receipt_no, created_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [payment.id, payment.member_id, payment.contribution_month, payment.amount_cents, payment.paid_at, payment.method, payment.reference || "", payment.notes || "", payment.receipt_no, payment.created_at]);
    }
    for (const reversal of data.payment_reversals) {
      await run(db, "INSERT INTO payment_reversals(id, payment_id, reason, user_name, reversed_at) VALUES(?, ?, ?, ?, ?)",
        [reversal.id, reversal.payment_id, reversal.reason, reversal.user_name, reversal.reversed_at]);
    }
    for (const [key, value] of Object.entries(data.society_settings)) {
      await run(db, "INSERT INTO society_settings(key, value) VALUES(?, ?)", [key, String(value)]);
    }
    for (const log of data.audit_logs) {
      await run(db, "INSERT INTO audit_logs(id, action, record_type, record_id, details, user_name, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
        [log.id, log.action, log.record_type, log.record_id, log.details, log.user_name, log.created_at]);
    }
    for (const item of data.app_metadata) await run(db, "INSERT INTO app_metadata(key, value) VALUES(?, ?)", [item.key, item.value]);
    await run(db, "COMMIT");
    await persist(db);
  } catch (error) {
    await run(db, "ROLLBACK");
    throw error;
  }
}
