// The Spark Strategist. On a regular cycle Muse Spark reviews the whole city and steers the Traffic
// Efficiency System through tools. The engine then applies those decisions to every car, every second.
// This is the split real traffic centers use: people or models set strategy, controllers execute it.
import type { Stall, TrafficEngine } from '@carmacar/shared';
import type OpenAI from 'openai';

const MAX_ROUNDS = 5;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'avoid_street',
      description: 'Steer routes away from a street. Higher means stronger. 0 removes it.',
      parameters: {
        type: 'object',
        properties: { street: { type: 'string' }, extra_seconds: { type: 'number', description: '0 to 120' } },
        required: ['street', 'extra_seconds'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'favor_direction',
      description: 'Give a light a longer green in one direction, to clear a queue.',
      parameters: {
        type: 'object',
        properties: {
          intersection: { type: 'string' },
          direction: { type: 'string', enum: ['east-west', 'north-south'] },
          seconds: { type: 'number', description: 'Up to 60' },
        },
        required: ['intersection', 'direction', 'seconds'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'steer_parking',
      description: 'Make a parking area more or less attractive to new drivers. Negative attracts cars, positive repels them.',
      parameters: {
        type: 'object',
        properties: { place: { type: 'string', description: 'A garage name, or "Street parking".' }, extra_seconds: { type: 'number', description: '-60 to 120' } },
        required: ['place', 'extra_seconds'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish_review',
      description: 'End this review. Call exactly once, last, even if you changed nothing.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string', description: 'One plain sentence: what you saw and what you did.' } },
        required: ['summary'],
        additionalProperties: false,
      },
    },
  },
];

const SYSTEM_PROMPT = `You are the strategist for a city's Traffic Efficiency System. Routing code moves each car; you set the strategy for the next 30 seconds.

Principles:
- Congestion is how many times longer a street takes than when empty. Above 2 is worth acting on.
- If drivers are converging on one destination, spread them: steer parking to garages or streets with room, before queues form.
- If a light has a long queue one way and little the other, favor that direction.
- Clear your own earlier steering once it is no longer needed. Stale penalties cause harm.
- Change as little as you can. If the city is flowing, change nothing.

Use exact names from the status. Always finish with finish_review.`;

export interface StrategistContext {
  client: OpenAI;
  model: string;
  engine: TrafficEngine;
  /** Current time, in the engine's clock. */
  now: number;
  available: (stall: Stall) => boolean;
  log: (kind: 'tool_call' | 'tool_result' | 'reply' | 'error', detail: string, name?: string) => void;
  onTokens: (total: number) => void;
}

function runTool(name: string, args: any, ctx: StrategistContext): { result: unknown; summary?: string } {
  const { engine, now } = ctx;
  if (name === 'avoid_street') {
    return { result: { ok: engine.avoidStreet(String(args.street), Math.min(120, Math.max(0, Number(args.extra_seconds) || 0))) } };
  }
  if (name === 'favor_direction') {
    const seconds = Math.min(60, Math.max(0, Number(args.seconds) || 0));
    return { result: { ok: engine.favorDirection(String(args.intersection), args.direction === 'east-west' ? 'ew' : 'ns', seconds, now) } };
  }
  if (name === 'steer_parking') {
    return { result: { ok: engine.steerParking(String(args.place), Math.min(120, Math.max(-60, Number(args.extra_seconds) || 0))) } };
  }
  if (name === 'finish_review') return { result: { ok: true }, summary: String(args.summary ?? '') };
  return { result: { error: `Unknown tool ${name}` } };
}

/** One review of the city. Returns what the strategist said it did. */
export async function runStrategistCycle(ctx: StrategistContext, lastSummary: string | null): Promise<string | null> {
  const { client, model, engine, now, available, log, onTokens } = ctx;
  const digest = engine.cityDigest(now, available);
  const messages: any[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `City status:\n${JSON.stringify(digest)}\n\nYour last review: ${lastSummary ?? 'none yet'}`,
    },
  ];
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await client.chat.completions.create({ model, messages, tools: TOOLS } as never);
      const usage = (response as any).usage?.total_tokens;
      if (usage) onTokens(usage);
      const message = (response as any).choices[0].message;
      messages.push(message);
      const calls = message.tool_calls ?? [];
      if (calls.length === 0) return message.content ?? null;
      for (const call of calls) {
        const name = call.function.name;
        let args: any = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          // A malformed call goes back to the model as a tool error.
        }
        const { result, summary } = runTool(name, args, ctx);
        if (name !== 'finish_review') log('tool_call', JSON.stringify(args), name);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        if (summary !== undefined) {
          log('reply', summary);
          return summary;
        }
      }
    }
  } catch (err) {
    log('error', err instanceof Error ? err.message.slice(0, 200) : 'Strategist call failed');
  }
  return null;
}
