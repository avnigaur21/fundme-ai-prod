const fs = require('fs');
const path = require('path');
const { judgeOutput } = require('./judge');
const {
  generateProfile,
  summarizeOpportunity,
  checkEligibility,
  matchOpportunities,
  formatDetails,
  cleanScraped
} = require('./aiAdapters');

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const PASS_THRESHOLD = 7;   // Average score >= 7 = PASS
const DELAY_BETWEEN_TESTS = 3000; // ms between API calls (rate limit safety)

// ─── COLORS FOR CONSOLE ────────────────────────────────────────────────────────
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  bgGreen: '\x1b[42m',
  bgRed: '\x1b[41m',
  white: '\x1b[37m',
};

function colorScore(score) {
  if (score >= 8) return `${colors.green}${score}${colors.reset}`;
  if (score >= 5) return `${colors.yellow}${score}${colors.reset}`;
  return `${colors.red}${score}${colors.reset}`;
}

// ─── CORE EVAL RUNNER ──────────────────────────────────────────────────────────
async function runEval(name, datasetPath, fn) {
  const fullPath = path.resolve(datasetPath);

  if (!fs.existsSync(fullPath)) {
    console.error(`${colors.red}❌ Dataset not found: ${fullPath}${colors.reset}`);
    return { name, avg: 0, passed: false, results: [], error: 'Dataset not found' };
  }

  const tests = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));

  let totalScore = 0;
  let results = [];

  console.log(`\n${colors.cyan}${colors.bright}═══════════════════════════════════════${colors.reset}`);
  console.log(`${colors.cyan}${colors.bright}  📋 EVAL: ${name}${colors.reset}`);
  console.log(`${colors.cyan}${colors.bright}  📂 ${tests.length} test case(s)${colors.reset}`);
  console.log(`${colors.cyan}${colors.bright}═══════════════════════════════════════${colors.reset}\n`);

  for (let i = 0; i < tests.length; i++) {
    const test = tests[i];
    const testLabel = `[${i + 1}/${tests.length}]`;

    try {
      // Step 1: Call the real API
      console.log(`${colors.dim}${testLabel} Calling API...${colors.reset}`);
      const output = await fn(test.input);

      // Rate limit delay
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_TESTS));

      // Step 2: Judge the output
      console.log(`${colors.dim}${testLabel} Judging output...${colors.reset}`);
      const verdict = await judgeOutput(test.input, output, test.expected_output);

      // Rate limit delay
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_TESTS));

      totalScore += verdict.score;

      results.push({
        test_case: i + 1,
        input: test.input,
        expected: test.expected_output,
        actual_output: output,
        score: verdict.score,
        reason: verdict.reason
      });

      console.log(`  ${testLabel} Score: ${colorScore(verdict.score)}/10 — ${verdict.reason}`);

    } catch (err) {
      console.error(`  ${testLabel} ${colors.red}ERROR: ${err.message}${colors.reset}`);
      results.push({
        test_case: i + 1,
        input: test.input,
        expected: test.expected_output,
        actual_output: null,
        score: 0,
        reason: `Error: ${err.message}`
      });
    }
  }

  const avg = tests.length > 0 ? totalScore / tests.length : 0;
  const passed = avg >= PASS_THRESHOLD;

  const badge = passed
    ? `${colors.bgGreen}${colors.white} PASS ${colors.reset}`
    : `${colors.bgRed}${colors.white} FAIL ${colors.reset}`;

  console.log(`\n  ${badge}  Average: ${colorScore(avg.toFixed(1))}/10\n`);

  return { name, avg: parseFloat(avg.toFixed(2)), passed, results };
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${colors.bright}🚀 FundMe AI Evaluation Suite${colors.reset}`);
  console.log(`${colors.dim}Started at ${new Date().toLocaleString()}${colors.reset}`);
  console.log(`${colors.dim}Pass threshold: ${PASS_THRESHOLD}/10${colors.reset}`);

  const report = [];

  // Run all 6 evaluations sequentially
  report.push(await runEval(
    "Profile Generation",
    "./evals/datasets/profile.json",
    generateProfile
  ));

  report.push(await runEval(
    "Opportunity Summary",
    "./evals/datasets/summary.json",
    summarizeOpportunity
  ));

  report.push(await runEval(
    "Eligibility Check",
    "./evals/datasets/eligibility.json",
    checkEligibility
  ));

  report.push(await runEval(
    "Match Opportunities",
    "./evals/datasets/match.json",
    matchOpportunities
  ));

  report.push(await runEval(
    "Format Details",
    "./evals/datasets/format.json",
    formatDetails
  ));

  report.push(await runEval(
    "Scraper Clean (cleanWithAI)",
    "./evals/datasets/clean.json",
    cleanScraped
  ));

  // ─── FINAL SUMMARY ────────────────────────────────────────────────────────────
  console.log(`\n${colors.bright}╔═══════════════════════════════════════╗${colors.reset}`);
  console.log(`${colors.bright}║       📊 FINAL EVAL REPORT            ║${colors.reset}`);
  console.log(`${colors.bright}╠═══════════════════════════════════════╣${colors.reset}`);

  let allPassed = true;
  for (const r of report) {
    const status = r.passed
      ? `${colors.green}✅ PASS${colors.reset}`
      : `${colors.red}❌ FAIL${colors.reset}`;
    const avg = colorScore(r.avg.toFixed(1));
    console.log(`${colors.bright}║${colors.reset}  ${status}  ${avg}/10  ${r.name}`);
    if (!r.passed) allPassed = false;
  }

  const overallAvg = report.reduce((sum, r) => sum + r.avg, 0) / report.length;

  console.log(`${colors.bright}╠═══════════════════════════════════════╣${colors.reset}`);
  console.log(`${colors.bright}║${colors.reset}  Overall Average: ${colorScore(overallAvg.toFixed(1))}/10`);
  console.log(`${colors.bright}║${colors.reset}  Verdict: ${allPassed ? `${colors.green}ALL PASS ✅` : `${colors.red}SOME FAILED ❌`}${colors.reset}`);
  console.log(`${colors.bright}╚═══════════════════════════════════════╝${colors.reset}\n`);

  // ─── SAVE REPORT ───────────────────────────────────────────────────────────────
  const reportPath = path.join(__dirname, 'report.json');
  const reportData = {
    timestamp: new Date().toISOString(),
    pass_threshold: PASS_THRESHOLD,
    overall_avg: parseFloat(overallAvg.toFixed(2)),
    all_passed: allPassed,
    evaluations: report
  };

  fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2));
  console.log(`${colors.dim}📁 Report saved to: ${reportPath}${colors.reset}\n`);
}

main().catch(err => {
  console.error(`\n${colors.red}💥 Fatal error:${colors.reset}`, err);
  process.exit(1);
});
