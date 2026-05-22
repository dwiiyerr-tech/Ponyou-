import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, "..", "dashboard-token.txt");

let _token = null;

export function generateToken() {
  _token = randomBytes(32).toString("hex");
  fs.writeFileSync(TOKEN_FILE, _token, "utf8");
  return _token;
}

export function getToken() {
  if (_token) return _token;
  try { _token = fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch { _token = generateToken(); }
  return _token;
}

export function validateToken(req) {
  const auth = req.headers["authorization"] || "";
  const cookie = req.cookies?.dashtoken || "";
  const token = getToken();
  return auth === `Bearer ${token}` || cookie === token;
}

export function authMiddleware(req, res, next) {
  if (validateToken(req)) return next();
  res.status(401).json({ error: "Unauthorized" });
}
