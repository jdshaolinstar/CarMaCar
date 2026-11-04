// Checks and compiles a routing algorithm written by a model.
// The code is run once per road, many millions of times, so it has to be small, fast and unable to
// reach anything. Rather than block known-bad words, this allows only a tiny language: road data,
// Math, numbers, local variables, if and return. Loops, strings, calls to anything but Math, and
// access to any global cannot be written. Production would add real process isolation on top.
import { compileFunction, createContext } from 'node:vm';
import type { RoadState } from './simulator';

export const ROAD_FIELDS = ['freeSeconds', 'liveSeconds', 'load', 'lengthKm', 'capacityPerHour', 'isFreeway', 'isRamp', 'isArterial', 'hasSignal', 'hour'] as const;
const MATH = ['abs', 'ceil', 'exp', 'floor', 'log', 'max', 'min', 'pow', 'round', 'sqrt'];
const KEYWORDS = new Set(['const', 'let', 'if', 'else', 'return', 'true', 'false']);
const MAX_LENGTH = 1200;
/** Only arithmetic, comparison, grouping and statement punctuation. */
const ALLOWED_SYMBOLS = /^[\s+\-*/%()<>=!&|?:;,{}.]*$/;

export class RejectedAlgorithm extends Error {}

function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Throws RejectedAlgorithm, with a reason a model can act on, unless the source is allowed. */
export function checkSource(source: string) {
  if (source.length > MAX_LENGTH) throw new RejectedAlgorithm(`Too long: ${source.length} characters, limit ${MAX_LENGTH}.`);
  const code = stripComments(source);
  if (/=>/.test(code)) throw new RejectedAlgorithm('Functions cannot be defined.');
  const locals = new Set([...code.matchAll(/\b(?:const|let)\s+([A-Za-z_]\w*)/g)].map((m) => m[1]));
  // Road fields and Math functions are checked as whole names, including the dot.
  for (const match of code.matchAll(/\.\s*([A-Za-z_$][\w$]*)/g)) {
    const before = code.slice(0, match.index).trimEnd();
    const owner = /([A-Za-z_$][\w$]*)$/.exec(before)?.[1];
    const allowed = owner === 'road' ? (ROAD_FIELDS as readonly string[]).includes(match[1]) : owner === 'Math' && MATH.includes(match[1]);
    if (!allowed) throw new RejectedAlgorithm(`Not allowed: ${owner ?? ''}.${match[1]}`);
  }
  const withoutMembers = code.replace(/\b(road|Math)\s*\.\s*[A-Za-z_$][\w$]*/g, ' 0 ');
  for (const [name] of withoutMembers.matchAll(/[A-Za-z_$][\w$]*/g)) {
    if (!KEYWORDS.has(name) && !locals.has(name) && !/^[eE]\d*$/.test(name)) throw new RejectedAlgorithm(`Not allowed: ${name}`);
  }
  const symbols = withoutMembers.replace(/[A-Za-z_$][\w$]*/g, ' ').replace(/\d+(\.\d+)?/g, ' ');
  if (!ALLOWED_SYMBOLS.test(symbols)) throw new RejectedAlgorithm('Only arithmetic, comparisons, if and return are allowed.');
  // Calls may only be made on Math. A name directly before "(" is a call unless it is a keyword.
  for (const match of code.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (match[1] === 'if' || match[1] === 'return') continue;
    const prefix = code.slice(0, match.index).trimEnd();
    if (!prefix.endsWith('Math.')) throw new RejectedAlgorithm(`Calls are limited to Math: ${match[1]}`);
  }
  if (!/\breturn\b/.test(code)) throw new RejectedAlgorithm('The algorithm must return a cost in seconds.');
}

export type RoadCost = (road: RoadState) => number;

/** Compiles checked source into a function with nothing but a small copy of Math in scope. */
export function compileAlgorithm(source: string): RoadCost {
  checkSource(source);
  const math = Object.freeze(Object.fromEntries(MATH.map((name) => [name, Math[name as keyof Math]])));
  const context = createContext(Object.freeze({ Math: math }));
  return compileFunction(`"use strict";\n${stripComments(source)}`, ['road'], { parsingContext: context }) as unknown as RoadCost;
}

/** Runs the algorithm over varied roads, and rejects it if any answer could not be used as a cost. */
export function dryRun(cost: RoadCost) {
  const hours = [5, 7.5, 9, 11];
  const loads = [0, 0.2, 0.8, 1, 3, 20];
  for (const hour of hours) {
    for (const load of loads) {
      for (const kind of [0, 1, 2, 3]) {
        const road: RoadState = { freeSeconds: 10 + kind * 15, liveSeconds: 12 + load * 20, load, lengthKm: 0.2 + kind, capacityPerHour: 900 + kind * 800, isFreeway: kind === 0, isRamp: kind === 1, isArterial: kind === 2, hasSignal: kind >= 2, hour };
        const value = cost(road);
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new RejectedAlgorithm(`Returned ${String(value)} for a road with load ${load} at hour ${hour}. Costs must be positive numbers.`);
      }
    }
  }
}
