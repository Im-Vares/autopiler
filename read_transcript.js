const fs = require('fs');
const readline = require('readline');

async function main() {
  const file = '/Users/OlgaVerbickaa1/.gemini/antigravity-ide/brain/7595ba42-f71e-4648-acf3-13e5d5c08236/.system_generated/logs/transcript_full.jsonl';
  
  const rl = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity
  });

  let lineCount = 0;
  for await (const line of rl) {
    lineCount++;
    if (line.includes('Inspect response of /api/api/appraise')) {
      console.log(`=== FOUND Line ${lineCount} ===`);
      // Print the surrounding content or search for the JSON string
      const idx = line.indexOf('Inspect response of /api/api/appraise');
      console.log(line.substring(idx - 500, idx + 2000));
    }
  }
}

main().catch(console.error);
