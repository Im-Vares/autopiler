const fs = require('fs');
const readline = require('readline');
const path = require('path');

async function main() {
  const file = '/Users/OlgaVerbickaa1/.gemini/antigravity-ide/brain/727afc15-980f-47db-afd1-048685661bdf/.system_generated/logs/transcript.jsonl';
  
  if (!fs.existsSync(file)) {
    console.log("Log file not found at:", file);
    return;
  }

  const lines = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    lines.push(line);
  }

  console.log(`Total log lines: ${lines.length}`);
  console.log("\nLast 50 lines of log:");
  const start = Math.max(0, lines.length - 50);
  for (let i = start; i < lines.length; i++) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.content) {
        console.log(`[Step ${obj.step_index}] ${obj.content.substring(0, 1000)}`);
      } else {
        console.log(`[Step ${obj.step_index}] Type: ${obj.type}`);
      }
    } catch (e) {
      console.log(lines[i].substring(0, 500));
    }
  }
}

main().catch(console.error);
