export class LogBuffer {
  constructor(maxLines = 200) {
    this._max = maxLines;
    this._lines = [];
    this._subscribers = [];
  }

  push(line) {
    this._lines.push(line);
    if (this._lines.length > this._max) this._lines.shift();
    for (const fn of this._subscribers) {
      try { fn(line); } catch {}
    }
  }

  lines() { return [...this._lines]; }

  subscribe(fn) {
    this._subscribers.push(fn);
    return () => { this._subscribers = this._subscribers.filter(s => s !== fn); };
  }
}

export const globalLogBuffer = new LogBuffer(200);
