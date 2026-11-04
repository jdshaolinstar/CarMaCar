import {
  decodeMaskToRaster,
  decodeMaskToSVGPath,
  parseImageStream,
  recordsOfKind,
  type ResponsesEvent,
} from '@meta-sam/parser';
import type OpenAI from 'openai';
import type { VehicleMask, VisionProvider } from './provider';

// "vehicle", not "car": "car" misses large, close, low-poly cars, which reads as a false "free".
const CONCEPT = 'vehicle';

// The API sends response.content_part.done but not response.output_text.done, which the parser needs.
async function* normalized(stream: AsyncIterable<any>): AsyncGenerator<ResponsesEvent> {
  const done = new Set<string>();
  for await (const event of stream) {
    const lane = `${event.item_id}:${event.output_index}:${event.content_index}`;
    if (event.type === 'response.output_text.done') {
      if (!done.has(lane)) {
        done.add(lane);
        yield event;
      }
      continue;
    }
    yield event;
    if (event.type === 'response.content_part.done' && !done.has(lane) && event.part?.type === 'output_text') {
      done.add(lane);
      yield {
        type: 'response.output_text.done',
        item_id: event.item_id,
        output_index: event.output_index,
        content_index: event.content_index,
        text: event.part.text,
      } as ResponsesEvent;
    }
  }
}

export class SamProvider implements VisionProvider {
  readonly model = 'sam-3.1';

  constructor(private readonly client: OpenAI) {}

  async findVehicles(jpeg: Buffer): Promise<VehicleMask[]> {
    const stream = await this.client.responses.create({
      model: this.model,
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: CONCEPT },
            { type: 'input_image', image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}` },
          ],
        },
      ],
    } as never);
    const result = await parseImageStream(normalized(stream as never)).finalResult;
    if (result.outcome.status !== 'completed') {
      throw new Error(`SAM incomplete: ${result.outcome.reason} ${result.outcome.detail ?? ''}`);
    }
    const boxes = new Map(recordsOfKind(result.records, 'box').map((b) => [b.objectId, b]));
    return recordsOfKind(result.records, 'mask').flatMap((m) => {
      const b = boxes.get(m.objectId);
      if (!b) return [];
      return [
        {
          objectId: m.objectId,
          box: [b.left, b.top, b.right, b.bottom] as [number, number, number, number],
          raster: decodeMaskToRaster(m.mask),
          width: m.mask.width,
          height: m.mask.height,
          svgPath: decodeMaskToSVGPath(m.mask),
        },
      ];
    });
  }
}
