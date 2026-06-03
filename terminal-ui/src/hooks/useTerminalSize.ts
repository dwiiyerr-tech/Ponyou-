import { useStdout } from "ink";
import { useEffect, useState } from "react";
import { COMPACT_WIDTH } from "../theme.js";

export interface TermSize {
  width: number;
  height: number;
  compact: boolean;
}

/** Track terminal dimensions and a `compact` flag for narrow (Termux/tablet) widths. */
export function useTerminalSize(): TermSize {
  const { stdout } = useStdout();
  const read = (): TermSize => {
    const width = stdout?.columns || 80;
    const height = stdout?.rows || 24;
    return { width, height, compact: width < COMPACT_WIDTH };
  };
  const [size, setSize] = useState<TermSize>(read);

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize(read());
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdout]);

  return size;
}
