import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomBytes, timingSafeEqual } from "crypto";
import { atomicWriteText } from "../atomic-write.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, "..", "dashboard-token.txt");

let _token = null;

export function generateToken() {
  _token = randomBytes(32).toString("hex");
  atomicWriteText(TOKEN_FILE, _token);
  return _token;
}

export function getToken() {
  if (_token) return _token;
  try { _token = fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch { _token = generateToken(); }
  return _token;
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function validateToken(req) {
  const auth = req.headers["authorization"] || "";
  const cookie = req.cookies?.dashtoken || "";
  const token = getToken();
  return safeEqual(auth, `Bearer ${token}`) || safeEqual(cookie, token);
}

export function authMiddleware(req, res, next) {
  if (validateToken(req)) return next();
  res.status(401).json({ error: "Unauthorized" });
}
