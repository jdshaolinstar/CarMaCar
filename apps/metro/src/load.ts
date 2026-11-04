// Loads a city's network and commuter flows, caching the slow parts between runs.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { buildZones, readCommutes, type OdMatrix, type ZoneGrid } from './demand';
import { buildNetwork, type Network, type OsmFile } from './network';

const data = (name: string) => new URL(`../data/${name}`, import.meta.url);
const path = (name: string) => decodeURIComponent(data(name).pathname).replace(/^\/([A-Za-z]:)/, '$1');

export async function loadCity(id: string): Promise<{ network: Network; grid: ZoneGrid; matrix: OdMatrix }> {
  const osm = JSON.parse(readFileSync(data(`${id}-osm.json`), 'utf8')) as OsmFile;
  const network = buildNetwork(osm);
  const grid = buildZones(network);
  const cache = data(`${id}-od.json`);
  if (existsSync(cache)) {
    const saved = JSON.parse(readFileSync(cache, 'utf8'));
    return {
      network,
      grid,
      matrix: { origins: Int32Array.from(saved.origins), destinations: Int32Array.from(saved.destinations), workers: Int32Array.from(saved.workers), total: saved.total },
    };
  }
  const matrix = await readCommutes(network, grid, path('ca_od_main_JT00_2023.csv.gz'), path('ca_xwalk.csv.gz'));
  writeFileSync(cache, JSON.stringify({ origins: [...matrix.origins], destinations: [...matrix.destinations], workers: [...matrix.workers], total: matrix.total }));
  return { network, grid, matrix };
}
