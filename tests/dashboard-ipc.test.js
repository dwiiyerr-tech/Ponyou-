import { describe, it, expect } from "vitest";
import { LogBuffer } from "../dashboard/log-buffer.js";

describe("LogBuffer", () => {
  it("stores log lines up to max", () => {
    const buf = new LogBuffer(3);
    buf.push({ ts: "t1", level: "info", message: "a" });
    buf.push({ ts: "t2", level: "info", message: "b" });
    buf.push({ ts: "t3", level: "info", message: "c" });
    buf.push({ ts: "t4", level: "info", message: "d" });
    expect(buf.lines()).toHaveLength(3);
    expect(buf.lines()[0].message).toBe("b");
  });

  it("notifies subscriber on push", () => {
    const buf = new LogBuffer(10);
    const received = [];
    buf.subscribe(line => received.push(line));
    buf.push({ ts: "t1", level: "warn", message: "hello" });
    expect(received).toHaveLength(1);
    expect(received[0].message).toBe("hello");
  });
});
