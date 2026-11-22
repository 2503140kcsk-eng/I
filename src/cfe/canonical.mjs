/**
 * Deterministic JSON encoding and SHA-256 helpers.
 * Accepts only plain JSON data, dense arrays and finite numbers.
 */
const encoder = new TextEncoder();

export class CanonicalizationError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "CanonicalizationError";
    this.code = "NON_CANONICAL_JSON";
  }
}

function normalizeJson(value, path, ancestors) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CanonicalizationError("Non-finite number at " + path);
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new CanonicalizationError("Unsupported value at " + path + ": " + typeof value);
  }
  if (ancestors.has(value)) throw new CanonicalizationError("Cycle detected at " + path);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const out = [];
      for (let i = 0; i < value.length; i += 1) {
        if (!Object.hasOwn(value, i)) throw new CanonicalizationError("Sparse array at " + path + "[" + i + "]");
        out.push(normalizeJson(value[i], path + "[" + i + "]", ancestors));
      }
      return out;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalizationError("Non-plain object at " + path);
    }
    const out = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      out[key] = normalizeJson(value[key], path + "." + key, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value) {
  return JSON.stringify(normalizeJson(value, "$", new Set()));
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
  return Array.from(new Uint8Array(digest), function (byte) {
    return byte.toString(16).padStart(2, "0");
  }).join("");
}

export async function hashCanonical(value, cryptoProvider = globalThis.crypto) {
  return sha256Hex(canonicalJson(value), cryptoProvider);
}
