// Muse Spark as a vision model. Slower than SAM, but it understands what it is looking at.
// Used per-frame only when a person chooses it, and to check SAM's trash candidates.
import { pinhole, type CameraPose, type Stall } from '@carmacar/shared';
import type OpenAI from 'openai';
import sharp from 'sharp';
import { MAX_RANGE, type StallObservation } from './stalls';

export const TRASH_CATEGORIES = ['garbage bag', 'cardboard', 'bottle or can', 'food waste', 'other trash', 'not trash'] as const;
export type TrashCategory = (typeof TRASH_CATEGORIES)[number];

export interface SparkTrashItem {
  box: [number, number, number, number];
  category: TrashCategory;
}

const CROP_PADDING = 24;

export class SparkVision {
  constructor(
    private readonly client: OpenAI,
    readonly model: string,
    private readonly onTokens: (tokens: number) => void,
  ) {}

  private async askJson(image: Buffer, prompt: string, schema: object): Promise<any> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.toString('base64')}` } },
          ],
        },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } },
    } as never);
    const usage = (response as any).usage?.total_tokens;
    if (usage) this.onTokens(usage);
    return JSON.parse((response as any).choices[0].message.content ?? '{}');
  }

  /** Reads parking directly: stalls are outlined and labelled on the frame so answers map to known ids. */
  async readStalls(jpeg: Buffer, pose: CameraPose, stalls: Stall[]): Promise<StallObservation[]> {
    const cam = pinhole(pose);
    const eye = { x: pose.position[0], z: pose.position[2] };
    const floor = pose.floorY ?? 0;
    const visible: { stall: Stall; dist: number; points: [number, number][] }[] = [];
    for (const s of stalls) {
      if (s.garageId !== pose.garageId || (s.level ?? 0) !== (pose.level ?? 0)) continue;
      const dist = Math.hypot(s.center.x - eye.x, s.center.z - eye.z);
      if (dist > MAX_RANGE) continue;
      const corners: [number, number][] = [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ];
      const projected = corners.map(([a, b]) =>
        cam.project([
          s.center.x + (s.axis.x * a * s.length) / 2 + (s.normal.x * b * s.width) / 2,
          floor,
          s.center.z + (s.axis.z * a * s.length) / 2 + (s.normal.z * b * s.width) / 2,
        ]),
      );
      if (projected.some((p) => !p || p[0] < 0 || p[0] >= pose.width || p[1] < 0 || p[1] >= pose.height)) continue;
      visible.push({ stall: s, dist, points: projected as [number, number][] });
    }
    if (visible.length === 0) return [];

    const shapes = visible.map(({ stall, points }) => {
      const cx = points.reduce((t, p) => t + p[0], 0) / 4;
      const bottom = Math.max(...points.map((p) => p[1]));
      return `<polygon points="${points.map((p) => p.join(',')).join(' ')}" fill="none" stroke="#ff00ff" stroke-width="3"/><text x="${cx}" y="${Math.min(bottom + 24, pose.height - 6)}" font-family="Arial" font-size="22" font-weight="700" fill="#ff00ff" stroke="#000" stroke-width="0.8" text-anchor="middle">${stall.id}</text>`;
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pose.width}" height="${pose.height}">${shapes.join('')}</svg>`;
    const annotated = await sharp(jpeg).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 85 }).toBuffer();

    const ids = visible.map((v) => v.stall.id);
    const answer = await this.askJson(
      annotated,
      `Parking camera frame. Magenta outlines mark stalls labelled ${ids.join(', ')}. For each stall report "occupied" if a vehicle is parked in that outline, "free" if its ground is empty, or "unclear" if you cannot tell. A vehicle that only blocks the view of a stall behind it does not occupy that stall.`,
      {
        type: 'object',
        additionalProperties: false,
        required: ['stalls'],
        properties: {
          stalls: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'state'],
              properties: { id: { type: 'string', enum: ids }, state: { type: 'string', enum: ['occupied', 'free', 'unclear'] } },
            },
          },
        },
      },
    );
    const observations: StallObservation[] = [];
    for (const a of answer.stalls ?? []) {
      const seen = visible.find((v) => v.stall.id === a.id);
      if (seen && a.state !== 'unclear') observations.push({ stallId: a.id, state: a.state, weight: 1 / Math.max(seen.dist, 8) });
    }
    return observations;
  }

  /** Looks at one SAM candidate up close and says what it really is. */
  async checkTrash(jpeg: Buffer, box: [number, number, number, number], width: number, height: number): Promise<TrashCategory> {
    const left = Math.max(0, Math.floor(box[0] - CROP_PADDING));
    const top = Math.max(0, Math.floor(box[1] - CROP_PADDING));
    const crop = await sharp(jpeg)
      .extract({
        left,
        top,
        width: Math.min(width - left, Math.ceil(box[2] - box[0] + CROP_PADDING * 2)),
        height: Math.min(height - top, Math.ceil(box[3] - box[1] + CROP_PADDING * 2)),
      })
      .resize({ width: 256, withoutEnlargement: false })
      .jpeg({ quality: 85 })
      .toBuffer();
    const answer = await this.askJson(
      crop,
      'This is a close crop from a street camera in a simulated city. What is the object in the center? If it is a tire, a shadow, a person, a car part or anything else that is not discarded waste, answer "not trash".',
      {
        type: 'object',
        additionalProperties: false,
        required: ['category'],
        properties: { category: { type: 'string', enum: [...TRASH_CATEGORIES] } },
      },
    );
    return answer.category ?? 'not trash';
  }

  /** Finds trash in a whole frame, with no help from SAM. */
  async findTrash(jpeg: Buffer, pose: CameraPose): Promise<SparkTrashItem[]> {
    const answer = await this.askJson(
      jpeg,
      'Street camera frame from a simulated city. List every piece of discarded trash on the ground or sidewalk. Do not list vehicles, people, traffic lights or buildings. Give each box as x1, y1, x2, y2, scaled so the frame is 1000 by 1000.',
      {
        type: 'object',
        additionalProperties: false,
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['category', 'x1', 'y1', 'x2', 'y2'],
              properties: {
                category: { type: 'string', enum: TRASH_CATEGORIES.filter((c) => c !== 'not trash') },
                x1: { type: 'number' },
                y1: { type: 'number' },
                x2: { type: 'number' },
                y2: { type: 'number' },
              },
            },
          },
        },
      },
    );
    return (answer.items ?? []).map((i: any) => ({
      category: i.category,
      box: [(i.x1 / 1000) * pose.width, (i.y1 / 1000) * pose.height, (i.x2 / 1000) * pose.width, (i.y2 / 1000) * pose.height],
    }));
  }
}
