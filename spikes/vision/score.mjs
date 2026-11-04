// The only script allowed to read truth.json. It compares and never feeds back.
//   node score.mjs [prefix]
import { readFile } from 'node:fs/promises';

const prefix = process.argv[2] || 'all';
const { twin, perFrame } = JSON.parse(await readFile(`result-${prefix}.json`, 'utf8'));
const truth = JSON.parse(await readFile(process.argv[3] || 'truth.json', 'utf8'));

let right = 0, wrong = 0, unknown = 0;
for (const [id, occupied] of Object.entries(truth)) {
  const want = occupied ? 'occupied' : 'free';
  const got = twin[id].state;
  if (got === 'unknown') unknown++;
  else if (got === want) right++;
  else wrong++;
  console.log(id.padEnd(4), want.padEnd(9), got.padEnd(9), got === want ? 'ok' : 'MISS', `(occ ${twin[id].occupied.toFixed(2)} / free ${twin[id].free.toFixed(2)})`);
}
console.log(`\nStall accuracy: ${right}/${right + wrong + unknown}  wrong=${wrong} unknown=${unknown}`);

let f = { right: 0, wrong: 0, unknown: 0 };
for (const frame of Object.values(perFrame)) {
  for (const [id, v] of Object.entries(frame.stalls)) {
    if (v.state === 'unknown') f.unknown++;
    else if ((v.state === 'occupied') === truth[id]) f.right++;
    else f.wrong++;
  }
}
const decided = f.right + f.wrong;
console.log(`Per-frame decisions: ${f.right}/${decided} correct (${((100 * f.right) / decided).toFixed(1)}%), ${f.unknown} unknown`);
const ms = Object.values(perFrame).map((x) => x.ms).sort((a, b) => a - b);
console.log(`Latency: median ${ms[ms.length >> 1]}ms, max ${ms.at(-1)}ms, frames ${ms.length}`);
