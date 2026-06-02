// Sensitive field redactor — shared by WebSocket broadcast and wizard route.
//
// Combines an explicit allowlist of well-known secret field names with a
// pattern check for any key matching *apikey*, *secret*, *token*, *privatekey*,
// *bot_token*, *seed*, *mnemonic*, *passphrase*, *password*. Pattern check
// is case-insensitive and operates on the field name alone — not values —
// so legitimate fields like `tokenAddress` or `apiKeyHint` may need to be
// added to SAFE_PATTERN_EXCEPTIONS below.

const EXPLICIT_SENSITIVE = new Set([
  "walletKey", "privateKey", "keypair", "secretKey", "seedPhrase",
  "mnemonic", "vaultPrivateKey", "vault_key", "apiKey", "api_key",
  "rpcToken", "heliusApiKey", "helius_api_key", "authToken", "auth_token",
  "password", "passphrase", "signer", "_keypair", "_privateKey",
]);

// Pattern: any field name containing one of these substrings is redacted
// unless explicitly excepted. Lowercased before match.
const SENSITIVE_SUBSTRINGS = [
  "apikey", "api_key", "secretkey", "secret_key", "privatekey", "private_key",
  "bottoken", "bot_token", "seedphrase", "seed_phrase", "mnemonic", "passphrase", "password",
];

// Keys that look sensitive by pattern but are not. Add sparingly.
const SAFE_PATTERN_EXCEPTIONS = new Set([
  "publicApiKey", // exposed by design — public read-only key
]);

function isSensitiveKey(key) {
  if (EXPLICIT_SENSITIVE.has(key)) return true;
  if (SAFE_PATTERN_EXCEPTIONS.has(key)) return false;
  const lower = String(key).toLowerCase();
  return SENSITIVE_SUBSTRINGS.some(s => lower.includes(s));
}

export function stripSensitive(obj, seen = new WeakSet()) {
  if (obj == null || typeof obj !== "object") return obj;
  if (seen.has(obj)) return "[Circular]";
  seen.add(obj);
  if (Array.isArray(obj)) return obj.map(v => stripSensitive(v, seen));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isSensitiveKey(k)) {
      if (v === "" || v == null) { out[k] = v; continue; } // empty stays empty (UX: shows "not configured")
      out[k] = "[REDACTED]";
      continue;
    }
    out[k] = stripSensitive(v, seen);
  }
  return out;
}

export { EXPLICIT_SENSITIVE, isSensitiveKey };
