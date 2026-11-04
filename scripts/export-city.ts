// Writes the demo city as a data file, as a starting point for your own.
//   npx tsx scripts/export-city.ts my-city.json
import { writeFileSync } from 'node:fs';
import { generateCity } from '@carmacar/shared';

const file = process.argv[2] ?? 'city.json';
const city = generateCity();
writeFileSync(file, JSON.stringify(city, null, 2));
console.log(`Wrote ${file}: ${city.segments.length} streets, ${city.stalls.length} stalls, ${city.garages.length} garages.`);
