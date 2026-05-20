"use strict";

import { execFile } from "child_process";
import { promisify } from "util";
import pkg from "neural-trader";

const { RiskManager, calculateRsi } = pkg;
const execFileAsync = promisify(execFile);

class NeuralRisk {
  constructor({ initialCapital = 100, maxDrawdown = 0.3, riskPerTrade = 0.02 } = {}) {
    this.initialCapital = initialCapital;
    this.maxDrawdown = maxDrawdown;
    this.riskPerTrade = riskPerTrade;
    this._rm = new RiskManager({
      initialCapital,
      maxDrawdown,
      riskPerTrade,
      confidenceLevel: 0.95,
      lookbackPeriods: 20,
      method: "historical",
    });
    this._rufloBin = "./node_modules/.bin/ruflo";
  }

  kelly(winRate, avgWin, avgLoss) {
    try {
      const result = this._rm.calculateKelly(winRate, avgWin, avgLoss);
      const clamp = (v) => Math.min(Math.max(Number.isFinite(v) ? v : 0, 0.01), 0.5);
      return {
        fraction: clamp(result?.kellyFraction),
        halfKelly: clamp(result?.halfKelly),
        quarterKelly: clamp(result?.quarterKelly),
      };
    } catch (error) {
      console.error("NeuralRisk.kelly failed:", error);
      return { fraction: this.riskPerTrade, halfKelly: this.riskPerTrade, quarterKelly: this.riskPerTrade };
    }
  }

  async rsi(prices, period = 14) {
    try {
      const values = await calculateRsi(prices, period);
      const finiteValues = Array.isArray(values) ? values.filter(Number.isFinite) : [];
      const value = finiteValues.length > 0 ? finiteValues[finiteValues.length - 1] : null;

      if (!Number.isFinite(value)) return { value: null, signal: "unknown" };

      let signal = "neutral";
      if (value < 30) signal = "oversold";
      else if (value > 70) signal = "overbought";

      return { value, signal };
    } catch (error) {
      console.error("NeuralRisk.rsi failed:", error);
      return { value: null, signal: "unknown" };
    }
  }

  var95(returns) {
    try {
      const safeReturns = Array.isArray(returns) ? returns : [];
      const varResult = this._rm.calculateVar(safeReturns, 0.95);
      const cvarResult = this._rm.calculateCvar(safeReturns, 0.95);
      const drawdownResult = this._rm.calculateDrawdown(safeReturns);
      return {
        var: varResult?.varAmount ?? null,
        cvar: cvarResult?.cvarAmount ?? null,
        drawdown: drawdownResult?.maxDrawdown ?? null,
      };
    } catch (error) {
      console.error("NeuralRisk.var95 failed:", error);
      return { var: null, cvar: null, drawdown: null };
    }
  }

  async storePattern(key, data) {
    try {
      await execFileAsync(this._rufloBin, [
        "memory",
        "store",
        "-k",
        String(key),
        "-v",
        JSON.stringify(data),
        "--upsert",
      ]);
      return true;
    } catch (error) {
      console.error("NeuralRisk.storePattern failed:", error.message);
      return false;
    }
  }

  async searchPatterns(query, limit = 5) {
    try {
      const { stdout } = await execFileAsync(this._rufloBin, ["memory", "search", "-q", String(query)]);
      const text = String(stdout || "").trim();
      if (!text) return [];

      const results = [];
      for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        if (!line.includes(":")) continue;
        const idx = line.indexOf(":");
        const key = line.slice(0, idx).trim();
        const rawValue = line.slice(idx + 1).trim();
        if (!key || !rawValue) continue;
        let value = rawValue;
        try { value = JSON.parse(rawValue); } catch { /* keep string */ }
        results.push({ key, value });
        if (results.length >= limit) break;
      }
      return results;
    } catch (error) {
      console.error("NeuralRisk.searchPatterns failed:", error.message);
      return [];
    }
  }

  async retrievePattern(key) {
    try {
      const { stdout } = await execFileAsync(this._rufloBin, ["memory", "retrieve", "-k", String(key)]);
      const text = String(stdout || "").trim();
      if (!text) return null;
      try { return JSON.parse(text); } catch { /* try line parse */ }
      const valueLine = text.split(/\r?\n/).find((l) => l.toLowerCase().startsWith("value:"));
      if (valueLine) {
        const raw = valueLine.slice(valueLine.indexOf(":") + 1).trim();
        try { return JSON.parse(raw); } catch { return raw || null; }
      }
      return text;
    } catch (error) {
      console.error("NeuralRisk.retrievePattern failed:", error.message);
      return null;
    }
  }
}

export default NeuralRisk;
export { NeuralRisk };
