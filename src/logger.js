const STORAGE_KEY = "bafwethu.diagnostics.v1";
const MAX_ENTRIES = 250;
let sequence = 0;

export function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function describeError(error) {
  if (error instanceof Error) return { name: error.name, message: error.message };
  if (error && typeof error === "object") {
    let result;
    try {
      result = JSON.stringify(error.result ?? error);
    } catch {
      result = String(error);
    }
    return {
      name: error.name || error.result?.name || "Error",
      message: error.message || error.result?.message || error.result?.error || "Unknown operation error",
      result: result?.slice(0, 2000)
    };
  }
  return { name: "Error", message: String(error) };
}

function reportStorageFailure(operation, error) {
  console.error(`[bafwethu] Could not ${operation} diagnostic log`, error);
}

export function readDiagnosticLogs() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (!value) return [];
    const entries = JSON.parse(value);
    if (!Array.isArray(entries)) throw new Error("Stored diagnostic log is not an array.");
    return entries.filter((entry) => entry && typeof entry.timestamp === "string" && typeof entry.event === "string");
  } catch (error) {
    reportStorageFailure("read", error);
    return [];
  }
}

export function logEvent(level, event, details = {}, chainId = null) {
  const existingEntries = readDiagnosticLogs();
  sequence = Math.max(sequence, ...existingEntries.map((entry) => Number(entry.sequence) || 0));
  const entry = {
    sequence: ++sequence,
    timestamp: new Date().toISOString(),
    level,
    event,
    chainId,
    details
  };
  const entries = [...existingEntries, entry].slice(-MAX_ENTRIES);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch (error) {
    reportStorageFailure("write", error);
  }
  const consoleMethod = level === "error" ? "error" : level === "warn" ? "warn" : "info";
  console[consoleMethod]("[bafwethu]", entry);
  window.dispatchEvent(new CustomEvent("bafwethu:diagnostic-log", { detail: entry }));
  return entry;
}

export function startLogChain(name) {
  const chainId = createId();
  logEvent("info", `${name}.started`, {}, chainId);
  return {
    id: chainId,
    info: (event, details = {}) => logEvent("info", event, details, chainId),
    warn: (event, details = {}) => logEvent("warn", event, details, chainId),
    error: (event, error) => logEvent("error", event, describeError(error), chainId)
  };
}

export async function runLogChain(name, operation) {
  const chain = startLogChain(name);
  try {
    const result = await operation(chain);
    chain.info(`${name}.completed`);
    return result;
  } catch (error) {
    chain.error(`${name}.failed`, error);
    throw error;
  }
}
