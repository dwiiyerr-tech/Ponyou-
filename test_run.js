import "dotenv/config";
import { discoverTokens } from "./tools/gmgn.js";
import { runScreeningCycle } from "./index.js";

async function test() {
  console.log("Testing discoverTokens...");
  const discovery = await discoverTokens({ timeframe: "1m" });
  console.log("Discovery result:", JSON.stringify(discovery, null, 2));

  if (discovery.error) {
    console.error("Discovery failed!");
  } else {
    console.log("Discovery successful. Testing screening cycle...");
    const report = await runScreeningCycle({ silent: true });
    console.log("Screening report:", report);
  }
}

test();
