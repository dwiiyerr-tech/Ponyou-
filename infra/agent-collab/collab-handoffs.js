import { getOpenHandoffs } from "./agent-orchestrator.js";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const handoffs = getOpenHandoffs({
    owner: args.owner || "claude",
    limit: Number(args.limit || 10),
  });
  console.log(JSON.stringify({
    owner: args.owner || "claude",
    count: handoffs.length,
    handoffs,
  }, null, 2));
}

main();
