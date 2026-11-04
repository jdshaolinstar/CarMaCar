// The Lab: Muse does traffic R&D. It writes routing ideas, SimTest scores them on a smaller Los Angeles,
// and Muse sees the scores and tries again. The best idea then has to repeat on commuters it never saw,
// because the best of many tries always looks better than it is.
// Run from the repo root: node --env-file=.env --import tsx apps/metro/scripts/algo-lab.ts <algorithm|params> [rounds]
//
// Two modes:
//   algorithm  Muse writes the road cost function itself.
//   params     Muse starts from rough settings and tunes them. It is never shown the hand-tuned values,
//              which is what makes "did it find them?" a fair question.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import OpenAI from 'openai';
import { checkSource, compileAlgorithm, dryRun, RejectedAlgorithm, ROAD_FIELDS } from '../src/lab-sandbox';
import { HAND_TUNED, type RoutingParams } from '../src/simulator';

type Mode = 'algorithm' | 'params';
const MODEL = process.env.AGENT_MODEL ?? 'muse-spark-1.3-contributor';
const mode = (process.argv[2] ?? 'algorithm') as Mode;
const ROUNDS = Number(process.argv[3] ?? 3);

/** SimTest settings. Small enough to take minutes, and held the same for everything compared. */
const SIMTEST = { cars: 20000, capacity: Number(process.env.LAB_CAPACITY ?? 2), tesShare: 0.6, rerouteSeconds: 600 };
const TRAIN_SEED = 11;
const HELD_OUT_SEED = 12;
const WORKERS = Number(process.env.LAB_WORKERS ?? 4);
const JOB_TIMEOUT_MS = 30 * 60 * 1000;
/** Spending stops here, whatever the round. At contributor prices this is about two cents. */
const TOKEN_BUDGET = 100_000;
/** On the held-out test, a gain below this is treated as no gain. */
const ADOPT_PERCENT = 0.5;
const ROUGH: RoutingParams = { alpha: 0.05, power: 1, coordination: 0, slices: 1 };
const PRICE_PER_MILLION = { input: 0.1, output: 0.2 };

/** Each async Muse call gets its own angle, so parallel answers differ. */
const BRIEFS = [
  'Focus on spreading traffic before roads fill, using planned load.',
  'Focus on the difference between freeways, ramps and surface streets.',
  'Focus on timing: how plans should change through the morning as the peak builds and clears.',
];

interface Scores {
  meanMinutes: number;
  rushMeanMinutes: number;
  vehicleHours: number;
  delayHours: number;
  vehicleKm: number;
  finishedShare: number;
  seconds: number;
}
interface Candidate {
  name: string;
  idea: string;
  code?: string;
  params?: RoutingParams;
  verdict: 'tested' | 'rejected' | 'failed';
  reason?: string;
  scores?: Scores;
  /** Percent fewer vehicle-hours than hand-tuned TES. Negative means worse. */
  gainPercent?: number;
}

const root = new URL('../../../', import.meta.url);
const labDir = new URL('apps/metro/data/runs/lab/', root);
const outFile = new URL(`apps/sim/public/metro/la-lab-${mode}.json`, root);
mkdirSync(labDir, { recursive: true });

const session = {
  mode,
  model: MODEL,
  status: 'Starting',
  simTest: { ...SIMTEST, trainSeed: TRAIN_SEED, heldOutSeed: HELD_OUT_SEED },
  tokens: 0,
  tokenBudget: TOKEN_BUDGET,
  estimatedCostUsd: 0,
  references: {} as Record<string, Scores>,
  rounds: [] as { round: number; candidates: Candidate[] }[],
  winner: null as Candidate | null,
  heldOut: null as null | { winner: Scores; handTuned: Scores; apps: Scores; gainPercent: number },
  verdict: '',
  lesson: '',
};
const save = (status?: string) => {
  if (status) {
    session.status = status;
    console.log(`[${new Date().toLocaleTimeString()}] ${status}`);
  }
  writeFileSync(outFile, JSON.stringify(session, null, 1));
};

// ---- SimTest processes ----

let running = 0;
const queue: (() => void)[] = [];
async function slot() {
  if (running < WORKERS) {
    running++;
    return;
  }
  await new Promise<void>((resolve) => queue.push(resolve));
}
const release = () => {
  const next = queue.shift();
  if (next) next();
  else running--;
};

let jobNumber = 0;
async function simTest(seed: number, extra: { code?: string; params?: RoutingParams; tesShare?: number }): Promise<Scores> {
  await slot();
  const id = `${process.pid}-${jobNumber++}`;
  const jobPath = new URL(`job-${id}.json`, labDir);
  const resultPath = new URL(`result-${id}.json`, labDir);
  writeFileSync(jobPath, JSON.stringify({ ...SIMTEST, seed, ...extra }));
  try {
    await new Promise<void>((resolve, reject) => {
      // Only what node needs to start. MODEL_API_KEY is not in this list, so the child never has it.
      const { PATH, SystemRoot, TEMP, TMP, USERPROFILE } = process.env;
      const child = spawn(
        process.execPath,
        ['--max-old-space-size=1000', '--import', 'tsx', 'apps/metro/scripts/lab-worker.ts', decodePath(jobPath), decodePath(resultPath)],
        { cwd: decodePath(root), env: { PATH, SystemRoot, TEMP, TMP, USERPROFILE }, stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let errors = '';
      child.stderr.on('data', (chunk) => (errors = (errors + chunk).slice(-400)));
      const timer = setTimeout(() => child.kill(), JOB_TIMEOUT_MS);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`SimTest ended with code ${code}. ${errors}`));
      });
    });
    return JSON.parse(readFileSync(resultPath, 'utf8')) as Scores;
  } finally {
    release();
  }
}

function decodePath(url: URL) {
  return decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1');
}

// ---- Muse ----

const client = new OpenAI({ apiKey: process.env.MODEL_API_KEY, baseURL: 'https://api.meta.ai/v1' });

const ALGORITHM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'idea', 'code'],
  properties: {
    name: { type: 'string', description: 'Two to four words.' },
    idea: { type: 'string', description: 'One sentence on why this should reduce total hours.' },
    code: { type: 'string', description: 'Body of the function, ending in return.' },
  },
};
const PARAMS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'idea', 'alpha', 'power', 'coordination', 'slices'],
  properties: {
    name: { type: 'string', description: 'Two to four words.' },
    idea: { type: 'string', description: 'One sentence on what you are testing.' },
    alpha: { type: 'number', description: 'From 0.01 to 2.' },
    power: { type: 'number', description: 'From 1 to 8.' },
    coordination: { type: 'number', description: 'From 0 to 1.' },
    slices: { type: 'integer', description: 'From 1 to 8. More is slower.' },
  },
};

const SYSTEM =
  "You are the R&D agent of a traffic system for Los Angeles. Connected drivers follow routes planned by shortest path over a cost per road. You improve that cost. A simulator scores each attempt on real Los Angeles roads and commuter flows, and it also counts the drivers who are not connected, so pushing traffic onto them does not help. The goal is fewer total vehicle-hours. Sending everyone to the same 'best' road makes it the worst road. Be concrete and vary your approach based on the scores.";

function algorithmPrompt() {
  return `Write the body of a JavaScript function that receives "road" and returns its cost in seconds, a positive number.
Fields of road: ${ROAD_FIELDS.join(', ')}. load is planned cars as a share of what the road can pass this interval. liveSeconds is the measured crossing time. hour is the clock hour, such as 7.5.
Allowed: const, let, if, else, return, numbers, arithmetic, comparisons, Math.abs, ceil, exp, floor, log, max, min, pow, round, sqrt. Nothing else exists: no loops, no strings, no other calls.
The current algorithm, which you are trying to beat:
return Math.max(road.liveSeconds, road.freeSeconds * (1 + 0.45 * Math.pow(road.load, 4)));`;
}

function paramsPrompt() {
  return `The road cost is max(liveSeconds, freeSeconds * (1 + alpha * load^power * (1 + 4 * coordination))). load is planned cars as a share of what the road can pass this interval. slices is how many batches each planning round is split into, so later batches see earlier plans.
Starting settings, which are rough: ${JSON.stringify(ROUGH)}. Choose settings to test.`;
}

async function ask(brief: string, history: string, feedback: string): Promise<Omit<Candidate, 'verdict'>> {
  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `${mode === 'algorithm' ? algorithmPrompt() : paramsPrompt()}\n\nResults so far:\n${history || 'None yet.'}${feedback}\n\n${brief}` },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'candidate', strict: true, schema: mode === 'algorithm' ? ALGORITHM_SCHEMA : PARAMS_SCHEMA } },
  } as never);
  const usage = (response as any).usage;
  session.tokens += usage?.total_tokens ?? 0;
  session.estimatedCostUsd += ((usage?.prompt_tokens ?? 0) * PRICE_PER_MILLION.input + (usage?.completion_tokens ?? 0) * PRICE_PER_MILLION.output) / 1e6;
  const answer = JSON.parse((response as any).choices[0].message.content ?? '{}');
  if (mode === 'algorithm') return { name: answer.name, idea: answer.idea, code: answer.code };
  const clamp = (v: number, low: number, high: number) => Math.min(high, Math.max(low, v));
  return {
    name: answer.name,
    idea: answer.idea,
    params: { alpha: clamp(answer.alpha, 0.01, 2), power: clamp(answer.power, 1, 8), coordination: clamp(answer.coordination, 0, 1), slices: Math.round(clamp(answer.slices, 1, 8)) },
  };
}

/** Rejected code goes back to Muse with the reason, once, like a failed compile. */
async function draft(brief: string, history: string): Promise<Candidate> {
  let feedback = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const candidate = await ask(brief, history, feedback);
    if (!candidate.code) return { ...candidate, verdict: 'tested' };
    try {
      checkSource(candidate.code);
      dryRun(compileAlgorithm(candidate.code));
      return { ...candidate, verdict: 'tested' };
    } catch (err) {
      if (!(err instanceof RejectedAlgorithm) && !(err instanceof SyntaxError)) throw err;
      feedback = `\n\nYour last code was rejected: ${err.message}\nCode: ${candidate.code}`;
      if (attempt === 1) return { ...candidate, verdict: 'rejected', reason: err.message };
    }
  }
  throw new Error('unreachable');
}

const hours = (s: Scores) => Math.round(s.vehicleHours).toLocaleString('en-US');
const describe = (c: Candidate) => {
  const what = c.code ?? JSON.stringify(c.params);
  if (c.verdict !== 'tested') return `${c.name}: ${c.verdict}. ${c.reason ?? ''}\n${what}`;
  return `${c.name}: ${hours(c.scores!)} vehicle-hours, ${c.gainPercent!.toFixed(2)}% better than the current system, mean trip ${c.scores!.meanMinutes.toFixed(1)} min.\n${what}`;
};

// ---- The session ----

save('Measuring the starting points');
const startingPoints = await Promise.all([
  simTest(TRAIN_SEED, { tesShare: 0 }),
  simTest(TRAIN_SEED, { params: HAND_TUNED }),
  ...(mode === 'params' ? [simTest(TRAIN_SEED, { params: ROUGH })] : []),
]);
session.references.apps = startingPoints[0];
session.references.handTuned = startingPoints[1];
if (mode === 'params') session.references.rough = startingPoints[2];
save();
console.log(`apps ${hours(startingPoints[0])}, hand-tuned ${hours(startingPoints[1])}${mode === 'params' ? `, rough ${hours(startingPoints[2])}` : ''}`);

const base = session.references.handTuned.vehicleHours;
const history: string[] = [];
if (mode === 'params') history.push(`Rough settings: ${hours(session.references.rough)} vehicle-hours.`);
else history.push(`Current algorithm: ${hours(session.references.handTuned)} vehicle-hours.`);

for (let round = 1; round <= ROUNDS; round++) {
  if (session.tokens >= TOKEN_BUDGET) {
    save(`Stopped at the token budget after round ${round - 1}`);
    break;
  }
  save(`Round ${round} of ${ROUNDS}: Muse is writing ${BRIEFS.length} candidates at once`);
  const so = history.join('\n\n');
  const candidates = await Promise.all(BRIEFS.map((brief) => draft(brief, so)));
  const entry = { round, candidates };
  session.rounds.push(entry);
  save(`Round ${round} of ${ROUNDS}: SimTest is scoring ${candidates.filter((c) => c.verdict === 'tested').length} candidates`);
  await Promise.all(
    candidates.map(async (c) => {
      if (c.verdict !== 'tested') return;
      try {
        c.scores = await simTest(TRAIN_SEED, { code: c.code, params: c.params });
        c.gainPercent = ((base - c.scores.vehicleHours) / base) * 100;
      } catch (err) {
        c.verdict = 'failed';
        c.reason = (err as Error).message.slice(0, 200);
      }
      save();
    }),
  );
  history.push(`Round ${round}:\n${candidates.map(describe).join('\n')}`);
  for (const c of candidates) console.log(describe(c).split('\n')[0]);
}

const tested = session.rounds.flatMap((r) => r.candidates).filter((c) => c.verdict === 'tested');
tested.sort((a, b) => a.scores!.vehicleHours - b.scores!.vehicleHours);
if (tested.length === 0) {
  session.verdict = 'No candidate could be tested. Nothing was adopted.';
  save('Finished');
} else {
  session.winner = tested[0];
  save(`Held-out test: ${tested[0].name} on commuters it never saw`);
  const [winner, handTuned, apps] = await Promise.all([
    simTest(HELD_OUT_SEED, { code: tested[0].code, params: tested[0].params }),
    simTest(HELD_OUT_SEED, { params: HAND_TUNED }),
    simTest(HELD_OUT_SEED, { tesShare: 0 }),
  ]);
  const gainPercent = ((handTuned.vehicleHours - winner.vehicleHours) / handTuned.vehicleHours) * 100;
  session.heldOut = { winner, handTuned, apps, gainPercent };
  session.verdict =
    gainPercent >= ADOPT_PERCENT
      ? `Adopted: ${tested[0].name} beat the hand-tuned system by ${gainPercent.toFixed(2)}% on commuters it never saw.`
      : gainPercent <= -ADOPT_PERCENT
        ? `Rejected: ${tested[0].name} was ${(-gainPercent).toFixed(2)}% worse than the hand-tuned system on commuters it never saw.`
        : `Matched: ${tested[0].name} came within ${ADOPT_PERCENT}% of the hand-tuned system on commuters it never saw (${gainPercent.toFixed(2)}%).`;
  save('Asking Muse what it learned');
  // Words only. Every number on screen comes from the code above.
  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: 'Summarize this traffic R&D session in two plain sentences for a city engineer: what worked, what did not, and what you would try next. Use no digits.' },
      { role: 'user', content: `${history.join('\n\n')}\n\nFinal result: ${session.verdict}` },
    ],
  } as never);
  const usage = (response as any).usage;
  session.tokens += usage?.total_tokens ?? 0;
  session.estimatedCostUsd += ((usage?.prompt_tokens ?? 0) * PRICE_PER_MILLION.input + (usage?.completion_tokens ?? 0) * PRICE_PER_MILLION.output) / 1e6;
  const lesson = (response as any).choices[0].message.content ?? '';
  session.lesson = /\d/.test(lesson) ? '' : lesson;
  save('Finished');
}
console.log(session.verdict);
console.log(`tokens ${session.tokens}, about $${session.estimatedCostUsd.toFixed(4)}`);
