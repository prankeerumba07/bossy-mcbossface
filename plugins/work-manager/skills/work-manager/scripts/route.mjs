// Picks the right model for each request. Runs before Claude sees a prompt
// (a quick word check, no extra AI call) and, when the conversation's model
// does not fit the request, adds one line telling Claude which helper to use.
//
//   node route.mjs "some request"     show the grade (for testing)
import { modelFamily, modelLabel, isMain } from './lib.mjs';

const HARD = [
  /\barchitect/i, /\bre-?design\b/i, /\bdesign (a|the|an)\b/i, /\brefactor/i, /\bmigrat/i, /\bre-?write\b/i,
  /\bsecurity\b/i, /\bvulnerab/i, /\bexploit/i, /\bencrypt/i, /\bauth(entication|orization)\b/i, /\bpermission model\b/i,
  /\brace condition/i, /\bdeadlock/i, /\bconcurren/i, /\bmemory leak/i, /\bperformance\b/i, /\boptimi[sz]/i, /\bscal(e|ing|ability)\b/i,
  /\broot cause/i, /\bwhy (does|is|do|did|are)\b/i, /\bintermittent/i, /\bflaky\b/i, /\bheisenbug/i, /\bcorrupt/i,
  /\bproduction\b/i, /\boutage\b/i, /\bincident\b/i, /\bpayment/i, /\bbilling\b/i, /\bmoney\b/i, /\bfinancial\b/i,
  /\balgorithm/i, /\btrade-?offs?\b/i, /\bstrategy\b/i, /\bplan (the|a|an|out)\b/i, /\baudit\b/i, /\bwhole (code|repo|project|app)/i,
  /\bentire (code|repo|project|app)/i, /\bend[- ]to[- ]end\b/i, /\bfrom scratch\b/i, /\bcomplete system\b/i, /\bmulti-?agent/i,
];
const EASY = [
  /\btypo/i, /\brename\b/i, /\blist (all|the|my)?\b/i, /\bcount\b/i, /\bwhere is\b/i, /\bwhich file/i, /\bfind (the|a|all|where)\b/i,
  /\bformat\b/i, /\blint\b/i, /\bbump (the )?version/i, /\badd (a )?comment/i,
  /\bsmall\b/i, /\bquick(ly)?\b/i, /\bsimple\b/i, /\bone[- ]line/i, /\bspelling\b/i, /\bupdate (the )?readme\b/i,
  /\bcheck (the )?status\b/i, /\bgit status\b/i, /\bopen (the )?(dashboard|file)\b/i, /\bremind me\b/i, /\bsummari[sz]e\b/i,
];
// A problem report is never an easy job.
const PROBLEM = /\b(wrong|error|errors|bug|bugs|fail(s|ed|ing)?|broken|crash(es|ed)?|not working|doesn'?t work|isn'?t working|issue|fix|still)\b/i;
const QUESTION = /^(what|where|which|who|whose|when|how many|how much|is|are|does|do|did|can you (tell|show|explain))\b/i;
const SKIP = /^\s*(\/|<|ok\b|okay\b|yes\b|no\b|thanks|thank you|continue\b|go on\b|sure\b|done\b|great\b|y\b|n\b)/i;

// easy = 1, medium = 2, hard = 3. Returns null for prompts not worth grading.
export function grade(prompt) {
  const text = String(prompt || '').trim();
  if (text.length < 12 || (SKIP.test(text) && text.length < 60)) return null;
  const hard = HARD.filter((r) => r.test(text)).length;
  const easy = EASY.filter((r) => r.test(text)).length;
  const words = text.split(/\s+/).length;
  const problem = PROBLEM.test(text) && !/\b(typo|spelling|rename|reformat|format|lint|comment)\b/i.test(text);
  let level = 2;
  if (hard >= 2 || (hard >= 1 && words > 40) || words > 400) level = 3;
  else if (!problem && hard === 0 && easy >= 1 && words <= 40) level = 1;
  else if (!problem && hard === 0 && words <= 15 && QUESTION.test(text)) level = 1;
  return { level, hard, easy, words, problem };
}

const NAMES = { 1: 'easy', 2: 'medium', 3: 'hard' };
const TIER = { haiku: 1, sonnet: 2, opus: 3, fable: 3 };
const HELPER = { 1: ['wm-quick', 'Haiku 5.5'], 2: ['wm-worker', 'Sonnet 5.5'], 3: ['wm-expert', 'Opus 5.5'] };

// One line of advice, or '' when the conversation's model already fits.
export function routeNote(prompt, mainModel, { plugin = true } = {}) {
  const g = grade(prompt);
  if (!g) return { grade: null, note: '' };
  const tier = TIER[modelFamily(mainModel)] || 0;
  const [helper, model] = HELPER[g.level];
  const name = plugin ? `work-manager:${helper}` : helper;
  const main = modelLabel(mainModel) || 'the current model';
  let note = '';
  // Speak up only on a clear mismatch: easy chores on the top model, or a
  // request harder than the conversation's model. Otherwise stay quiet.
  if (tier === 3 && g.level === 1) {
    note = `[Work Manager] This request looks ${NAMES[g.level]} (a ${model} job). If it needs more than a few steps, hand the work to ${name} (${model}) instead of doing it all on ${main}; do tiny ones yourself. Project CLAUDE.md rules come first.`;
  } else if (tier && g.level > tier) {
    note = `[Work Manager] This request looks ${NAMES[g.level]} and needs ${model}; you are on ${main}. Hand the core work to ${name} (${model}) and check what it sends back. Project CLAUDE.md rules come first.`;
  }
  return { grade: g, level: NAMES[g.level], model, helper: name, note };
}

if (isMain(import.meta)) {
  const prompt = process.argv.slice(2).join(' ');
  for (const m of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']) {
    const r = routeNote(prompt, m);
    console.log(`${modelLabel(m).padEnd(11)} → ${r.level || 'not graded'}${r.note ? `\n    ${r.note}` : ''}`);
  }
}
