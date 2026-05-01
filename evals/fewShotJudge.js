const fs = require('fs');
const path = require('path');
const { parseKeyFile } = require('../utils/ai');

/**
 * Few-Shot Judge AI — uses "Golden Samples" to evaluate un-grounded data.
 */

const DATASET_MAP = {
  profile: 'profile.json',
  summary: 'summary.json',
  eligibility: 'eligibility.json',
  match: 'match.json',
  format: 'format.json',
  clean: 'clean.json'
};

function getOpenRouterKey() {
  return parseKeyFile('OPENROUTER_API_KEY');
}

/**
 * Loads the first N samples from a dataset to use as Few-Shot examples.
 */
function getGoldenSamples(task, count = 3) {
  const fileName = DATASET_MAP[task];
  if (!fileName) return [];

  try {
    const filePath = path.join(__dirname, 'datasets', fileName);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return data.slice(0, count);
  } catch (err) {
    console.warn(`⚠️  Could not load samples for task ${task}:`, err.message);
    return [];
  }
}

/**
 * Judges an Actual Output using Golden Samples as a reference.
 * 
 * @param {string} task - the task name (profile, eligibility, etc.)
 * @param {any} input - The new input provided to the AI
 * @param {any} actualOutput - The result from the production AI
 * @returns {Promise<{score: number, reason: string}>}
 */
async function judgeWithGoldenSamples(task, input, actualOutput) {
  const apiKey = getOpenRouterKey();
  if (!apiKey) throw new Error("Missing OpenRouter API Key");

  const samples = getGoldenSamples(task);
  
  const prompt = `
You are a Quality Assurance expert for an AI-powered startup funding platform.
Your job is to evaluate a NEW AI generated output for the task: "${task.toUpperCase()}".

### REFERENCE: GOLDEN SAMPLES
Below are ${samples.length} examples of PERFECT outputs for this task. 
Use these to understand the required tone, JSON schema, level of detail, and formatting we expect.

${samples.map((s, i) => `
--- SAMPLE ${i + 1} ---
INPUT: ${JSON.stringify(s.input, null, 2)}
PERFECT OUTPUT: ${JSON.stringify(s.expected_output || s.output, null, 2)}
`).join('\n')}

---

### EVALUATION TARGET
Input:
${JSON.stringify(input, null, 2)}

Actual Output:
${JSON.stringify(actualOutput, null, 2)}

---

### INSTRUCTIONS
1. Compare the Actual Output against the patterns and quality of the Golden Samples.
2. Check for professional tone, correctness, and adherence to the schema seen in the samples.
3. Score the Actual Output from 1 to 10.
4. Be fair: if it's high quality but differs slightly in content (since it's a new input), give it a high score.

CRITICAL: Return ONLY a valid JSON object.
{
  "score": <number 1-10>,
  "reason": "<1-sentence explanation of the score relative to the Golden Samples>"
}
  `.trim();

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "openrouter/auto",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Few-Shot Judge Error (HTTP ${response.status}): ${errText}`);
  }

  const data = await response.json();
  const raw = data.choices[0].message.content;

  try {
    // Look for the last JSON object in case of reasoning/text before it
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found");
    
    // Clean potential trailing commas or markdown artifacts
    let cleaned = jsonMatch[0].replace(/,\s*([\]}])/g, '$1');
    return JSON.parse(cleaned);
  } catch (e) {
    console.warn("⚠️  Few-Shot Judge returned non-JSON:", raw);
    return { score: 1, reason: "Judge returned an invalid response format." };
  }
}

module.exports = { judgeWithGoldenSamples };
