/**
 * CFE-CJSON-1 canonical JSON and SHA-256.
 * Rejects values that cannot be represented consistently across runtimes.
 */
const encoder = new TextEncoder();
const MAX_DEPTH = 1024;
const MAX_VALUES = 2_000_000;
const MAX_ARRAY_LENGTH = 1_000_000;

export class CanonicalizationError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "CanonicalizationError";
    this.code = "NON_CANONICAL_JSON";
  }
}

function assertWellFormedUnicode(value, path) {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) {
        throw new CanonicalizationError("Unpaired high surrogate at " + path);
      }
      i += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      throw new CanonicalizationError("Unpaired low surrogate at " + path);
    }
  }
}

function normalizeJson(value, path, ancestors, depth, budget) {
  budget.values += 1;
  if (budget.values > MAX_VALUES) throw new CanonicalizationError("Canonical JSON value limit exceeded");
  if (depth > MAX_DEPTH) throw new CanonicalizationError("Canonical JSON depth limit exceeded at " + path);

  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    assertWellFormedUnicode(value, path);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CanonicalizationError("Non-finite number at " + path);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new CanonicalizationError("Unsafe integer at " + path);
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new CanonicalizationError("Unsupported value at " + path + ": " + typeof value);
  }
  if (ancestors.has(value)) throw new CanonicalizationError("Cycle detected at " + path);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_LENGTH) throw new CanonicalizationError("Array length limit exceeded at " + path);
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
          throw new CanonicalizationError("Custom array property at " + path);
        }
      }
      const out = [];
      for (let i = 0; i < value.length; i += 1) {
        if (!Object.hasOwn(value, i)) throw new CanonicalizationError("Sparse array at " + path + "[" + i + "]");
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !Object.hasOwn(descriptor, "value")) {
          throw new CanonicalizationError("Array accessor at " + path + "[" + i + "]");
        }
        out.push(normalizeJson(descriptor.value, path + "[" + i + "]", ancestors, depth + 1, budget));
      }
      return out;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new CanonicalizationError("Non-plain object at " + path);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      throw new CanonicalizationError("Symbol key at " + path);
    }
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable) {
        throw new CanonicalizationError("Non-enumerable object property at " + path + "." + String(key));
      }
    }
    const out = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      assertWellFormedUnicode(key, path + " key");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        throw new CanonicalizationError("Accessor property at " + path + "." + key);
      }
      out[key] = normalizeJson(descriptor.value, path + "." + key, ancestors, depth + 1, budget);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

function stringifyNormalized(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" ||
      typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stringifyNormalized).join(",") + "]";
  }
  // Do not rely on JSON.stringify(object): ECMAScript enumerates integer-index
  // keys numerically, while CFE-CJSON-1 requires lexicographic UTF-16 ordering.
  const keys = Object.keys(value).sort();
  return "{" + keys.map((key) =>
    JSON.stringify(key) + ":" + stringifyNormalized(value[key])
  ).join(",") + "}";
}

export function canonicalJson(value) {
  const normalized = normalizeJson(value, "$", new Set(), 0, { values: 0 });
  return stringifyNormalized(normalized);
}
export function cloneCanonical(value) {
  return JSON.parse(canonicalJson(value));
}
export async function sha256Hex(input, cryptoProvider = globalThis.crypto) {
  if (!cryptoProvider || !cryptoProvider.subtle || !cryptoProvider.subtle.digest) {
    throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
  }
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  const digest = await cryptoProvider.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function hashCanonical(value, cryptoProvider = globalThis.crypto) {
  return sha256Hex(canonicalJson(value), cryptoProvider);
}
