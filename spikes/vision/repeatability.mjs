// How often does the same model give the same answer on the same frame?
//   node repeatability.mjs <resultA> <resultB>
import { readFile } from 'node:fs/promises';

const load = async (n) => JSON.parse(await readFile(`result-${n}.json`, 'utf8'));
const [a, b] = await Promise.all([load(process.argv[2]), load(process.argv[3])]);

let same = 0, diff = 0;
for (const [frame, f] of Object.entries(a.perFrame)) {
  for (const [id, v] of Object.entries(f.stalls)) {
    const other = b.perFrame[frame]?.stalls?.[id];
    if (!other) continue;
    if (other.state === v.state) same++;
    else { diff++; console.log(`  ${frame} ${id}: ${v.state} vs ${other.state}`); }
  }
}
const twinFlips = Object.keys(a.twin).filter((id) => a.twin[id].state !== b.twin[id].state);
console.log(`Per-frame agreement: ${same}/${same + diff} (${((100 * same) / (same + diff)).toFixed(1)}%)`);
console.log(`Final map stalls that changed between runs: ${twinFlips.length ? twinFlips.join(', ') : 'none'}`);
const ms = (r) => Object.values(r.perFrame).map((x) => x.ms).filter(Boolean).sort((x, y) => x - y);
console.log(`Median latency: ${ms(a)[ms(a).length >> 1]}ms / ${ms(b)[ms(b).length >> 1]}ms`);
