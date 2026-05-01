/**
 * liveEval.js — A utility to evaluate AI outputs on-demand using Few-Shot Golden Samples.
 * 
 * Usage:
 * node evals/liveEval.js --task profile --input "A new fintech startup in Mumbai" --output "{...JSON...}"
 */

const { judgeWithGoldenSamples } = require('./fewShotJudge');

async function run() {
  const args = process.argv.slice(2);
  const taskArg = args.find(a => a.startsWith('--task='))?.split('=')[1] || args[args.indexOf('--task') + 1];
  const inputArg = args.find(a => a.startsWith('--input='))?.split('=')[1] || args[args.indexOf('--input') + 1];
  const outputArg = args.find(a => a.startsWith('--output='))?.split('=')[1] || args[args.indexOf('--output') + 1];

  if (!taskArg || !inputArg || !outputArg) {
    console.log(`
🚀 FundMe Live Evaluator (Few-Shot)
-----------------------------------
Usage: node evals/liveEval.js --task <task> --input "<text/json>" --output "<text/json>"

Tasks: profile, summary, eligibility, match, clean
    `);
    process.exit(0);
  }

  console.log(`\n🔍 Evaluating ${taskArg.toUpperCase()}...`);
  console.log(`📥 Input: ${inputArg.substring(0, 50)}...`);

  try {
    // Attempt to parse JSON if input/output look like objects
    let input = inputArg;
    let output = outputArg;
    
    const tryParse = (str) => {
      const trimmed = str.trim().replace(/^['"]|['"]$/g, '');
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try { return JSON.parse(trimmed); } catch(e) { return trimmed; }
      }
      return trimmed;
    };

    input = tryParse(inputArg);
    output = tryParse(outputArg);

    const result = await judgeWithGoldenSamples(taskArg, input, output);
    
    console.log("\n--- JUDGE REPORT ---");
    console.log(`⭐ Score: ${result.score}/10`);
    console.log(`📝 Reason: ${result.reason}`);
    console.log("--------------------\n");

  } catch (err) {
    console.error("\n❌ Error during evaluation:", err.message);
  }
}

run();
