import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomBytes, timingSafeEqual } from "crypto";
import { atomicWriteText } from "../atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, "..", "dashboard-token.txt");

let _token = null;
let _tokenCreatedAt = 0;
const TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h rotation

// Track token → IP binding (max 5 recent tokens retained)
const _tokenBindings = new Map(); // token → { ip, createdAt }

function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0]?.trim()
    || req.socket?.remoteAddress
    || "unknown";
}

export function generateToken() {
  _token = randomBytes(32).toString("hex");
  _tokenCreatedAt = Date.now();
  atomicWriteText(TOKEN_FILE, _token);
  return _token;
}

export function getToken() {
  if (_token) {
    // Auto-rotate after 24h
    if (Date.now() - _tokenCreatedAt > TOKEN_MAX_AGE_MS) return generateToken();
    return _token;
  }
  try { _token = fs.readFileSync(TOKEN_FILE, "utf8").trim(); _tokenCreatedAt = Date.now(); } catch { _token = generateToken(); }
  return _token;
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Timing-safe check of a raw presented token (login form / ?token= query)
 * against the current dashboard token.
 */
export function checkToken(raw) {
  return safeEqual(String(raw || "").trim(), getToken());
}

export function validateToken(req) {
  const auth = req.headers["authorization"] || "";
  const cookie = req.cookies?.dashtoken || "";
  const token = getToken();

  const headerMatch = safeEqual(auth, `Bearer ${token}`);
  const cookieMatch = safeEqual(cookie, token);
  if (!headerMatch && !cookieMatch) return false;

  // IP binding: first successful auth from a new IP binds that IP to the token.
  // Subsequent requests from different IPs with the same token are rejected
  // unless the binding is older than 30 min (allows roaming but limits replay).
  const ip = clientIp(req);
  const binding = _tokenBindings.get(token);
  if (!binding) {
    _tokenBindings.set(token, { ip, createdAt: Date.now() });
    // Prune old bindings (keep last 5)
    if (_tokenBindings.size > 5) {
      const oldest = [..._tokenBindings.entries()]
        .sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (oldest) _tokenBindings.delete(oldest[0]);
    }
    return true;
  }

  if (binding.ip !== ip) {
    // Allow IP change after 30 min (roaming/network change)
    if (Date.now() - binding.createdAt < 30 * 60 * 1000) return false;
    binding.ip = ip;
  }

  return true;
}

export function validateTokenWs(req) {
  // WebSocket upgrade: extract token from query string or cookie header
  const url = new URL(req.url || "/", "http://localhost");
  const qsToken = url.searchParams.get("token") || "";
  const cookieHeader = req.headers?.cookie || "";
  const cookieMatch = cookieHeader.match(/(?:^|;\s*)dashtoken=([^;]+)/);
  const cookieToken = cookieMatch ? cookieMatch[1] : "";
  const token = getToken();

  // No IP-binding fallback here: a bound IP alone must not open the socket
  // (NAT/shared hosts would let any local process stream state untokened).
  return safeEqual(qsToken, token) || safeEqual(cookieToken, token);
}

export function authMiddleware(req, res, next) {
  if (validateToken(req)) return next();
  res.status(401).json({ error: "Unauthorized" });
}
