// The live map, drawn as a painted curb that fills in as cameras pass.
import { add, scale, type CityMap, type StallState, type TwinSnapshot, type Vec2 } from '@carmacar/shared';
import type { World } from './world';

const COLORS: Record<StallState, string> = { free: '#1FA35C', occupied: '#D8392B', unknown: '#8D969C' };
const ROLE_COLORS: Record<string, string> = {
  scout: '#37D3E8',
  hero: '#FF8A1F',
  network: '#F4F5F2',
  manual: '#B9C1C6',
};

export class LiveMap {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly k: number;
  private readonly ox: number;
  private readonly oz: number;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly city: CityMap,
  ) {
    this.ctx = canvas.getContext('2d')!;
    const xs = city.nodes.map((n) => n.x);
    const zs = [...city.nodes.map((n) => n.z), ...city.garages.flatMap((g) => [g.z - g.depth / 2, g.z + g.depth / 2])];
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const pad = 62;
    this.k = Math.min((canvas.width - pad * 2) / (maxX - minX), (canvas.height - pad * 2) / (maxZ - minZ));
    this.ox = canvas.width / 2 - (this.k * (minX + maxX)) / 2;
    this.oz = canvas.height / 2 + (this.k * (minZ + maxZ)) / 2;
  }

  private px(p: Vec2): [number, number] {
    return [this.ox + p.x * this.k, this.oz - p.z * this.k];
  }

  /** The moving car nearest a click on the canvas. */
  carAt(clientX: number, clientY: number, world: World): string | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * this.canvas.width;
    const y = ((clientY - rect.top) / rect.height) * this.canvas.height;
    let best: string | null = null;
    let bestDist = 16;
    for (const car of world.cars.values()) {
      if (car.phase === 'parked') continue;
      const [cx, cy] = this.px(car.pos);
      const d = Math.hypot(cx - x, cy - y);
      if (d < bestDist) {
        bestDist = d;
        best = car.id;
      }
    }
    return best;
  }

  /** The stall nearest a click on the canvas. */
  stallAt(clientX: number, clientY: number): string | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * this.canvas.width;
    const y = ((clientY - rect.top) / rect.height) * this.canvas.height;
    let best: string | null = null;
    let bestDist = 14;
    for (const s of this.city.stalls) {
      const [sx, sy] = this.px(s.center);
      const d = Math.hypot(sx - x, sy - y);
      if (d < bestDist) {
        bestDist = d;
        best = s.id;
      }
    }
    return best;
  }

  draw(twin: TwinSnapshot | null, world: World, highlight: string | null, selected: string | null, route: Vec2[] | null) {
    const { ctx, canvas, city } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const nodeById = new Map(city.nodes.map((n) => [n.id, n]));

    ctx.lineCap = 'butt';
    ctx.lineWidth = 15;
    for (const s of city.segments) {
      // Streets take on color as traffic builds, like a real traffic map.
      const level = twin?.traffic?.[s.id] ?? 1;
      ctx.strokeStyle = level >= 3 ? '#B23A2E' : level >= 2 ? '#B98A1F' : '#4b5359';
      ctx.beginPath();
      ctx.moveTo(...this.px(nodeById.get(s.a)!));
      ctx.lineTo(...this.px(nodeById.get(s.b)!));
      ctx.stroke();
      if (twin?.avoidedStreets?.includes(s.street)) {
        // A goal, not traffic, so it gets its own look.
        ctx.strokeStyle = '#7CC4FF';
        ctx.lineWidth = 4;
        ctx.setLineDash([10, 8]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 15;
      }
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const g of city.garages) {
      const w = g.width * this.k;
      const h = g.depth * this.k;
      const [cx, cy] = this.px(g);
      ctx.fillStyle = '#3F474D';
      ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
      const open = Array.from({ length: g.levels }, (_, level) =>
        city.stalls.filter((s) => s.garageId === g.id && s.level === level && twin?.stalls[s.id]?.state === 'free').length,
      );
      ctx.fillStyle = '#F4F5F2';
      ctx.font = '700 17px Overpass, Arial, sans-serif';
      ctx.fillText(g.name, cx, cy - 10);
      ctx.fillStyle = '#1FA35C';
      ctx.font = '700 16px Overpass, Arial, sans-serif';
      ctx.fillText(open.map((n, i) => `L${i + 1}: ${n}`).join('  '), cx, cy + 11);
    }

    ctx.lineWidth = 9;
    for (const s of city.stalls) {
      if (s.garageId) continue;
      const state = twin?.stalls[s.id]?.state ?? 'unknown';
      const half = scale(s.axis, s.length * 0.42);
      ctx.strokeStyle = COLORS[state];
      ctx.beginPath();
      ctx.moveTo(...this.px(add(s.center, half)));
      ctx.lineTo(...this.px(add(s.center, scale(half, -1))));
      ctx.stroke();
      if (twin?.stalls[s.id]?.reservedBy) {
        ctx.strokeStyle = '#F2B90F';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.lineWidth = 9;
      }
      if (s.id === highlight) {
        const [x, y] = this.px(s.center);
        ctx.strokeStyle = '#F4F5F2';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, 15, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 9;
      }
    }

    if (route && route.length > 1) {
      ctx.strokeStyle = '#FF8A1F';
      ctx.lineWidth = 5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      route.forEach((p, i) => (i === 0 ? ctx.moveTo(...this.px(p)) : ctx.lineTo(...this.px(p))));
      ctx.stroke();
    }

    ctx.font = '600 19px Overpass, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const d of city.destinations) {
      const [x, y] = this.px(d);
      const label = d.name.split(' ')[0];
      // Labels near the edge of the map flip inward so they are not clipped.
      const flip = x + d.normal.x * 60 < 0 || x + d.normal.x * 60 > canvas.width ? -1 : 1;
      const [dx, dy] = [d.normal.x * 26 * flip, -d.normal.z * 22];
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#2C3135';
      ctx.strokeText(label, x + dx, y + dy);
      ctx.fillStyle = '#F4F5F2';
      ctx.fillText(label, x + dx, y + dy);
    }

    for (const car of world.cars.values()) {
      if (car.phase === 'parked' || (car.insideGarage && car.id !== selected)) continue;
      const [x, y] = this.px(car.pos);
      ctx.fillStyle = ROLE_COLORS[car.role] ?? '#fff';
      ctx.beginPath();
      ctx.arc(x, y, car.role === 'hero' ? 8 : 5, 0, Math.PI * 2);
      ctx.fill();
      if (car.id === selected) {
        ctx.strokeStyle = '#F2B90F';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, 12, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
}
