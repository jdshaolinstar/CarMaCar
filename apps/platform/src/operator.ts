// The city operator. Muse Spark turns plain-language goals into settings for the Traffic Efficiency
// System. It runs on demand, not per car or per second: the routing itself stays deterministic.
import type { CityMap } from '@carmacar/shared';
import type OpenAI from 'openai';
import type { Twin } from './twin';

const MAX_ROUNDS = 6;
const TRIP_ID = 'operator';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_city_status',
      description: 'Current state of the city: traffic by street, open parking, and any streets being avoided.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'avoid_street',
      description: 'Discourage routing cars along a street. Higher seconds means stronger avoidance. 0 removes it.',
      parameters: {
        type: 'object',
        properties: {
          street: { type: 'string', description: 'Exact street name.' },
          extra_seconds: { type: 'number', description: 'Added cost per block. 30 is firm, 120 closes it in practice.' },
        },
        required: ['street', 'extra_seconds'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'report_to_operator',
      description: 'Finish by telling the operator what changed and what to expect. Call this exactly once, last.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string', description: 'One or two plain sentences.' } },
        required: ['summary'],
        additionalProperties: false,
      },
    },
  },
];

const SYSTEM_PROMPT = `You operate a city's Traffic Efficiency System. A person gives you a goal in plain language. The routing code does the moment-to-moment work; you steer it with tools.

Rules:
- Call get_city_status first, then act on what you see.
- Use exact street names from the status.
- Only change what the goal needs.
- Finish with report_to_operator. Be honest if a goal cannot be met with these tools.`;

interface OperatorContext {
  client: OpenAI;
  model: string;
  city: CityMap;
  twin: Twin;
  onTokens(total: number): void;
}

function cityStatus({ city, twin }: OperatorContext) {
  const snapshot = twin.snapshot(0, false);
  const streets = [...new Set(city.segments.map((s) => s.street))].map((name) => {
    const levels = city.segments.filter((s) => s.street === name).map((s) => snapshot.traffic[s.id] ?? 1);
    return { street: name, congestion: Math.max(...levels), avoiding_seconds: twin.tes.streetPenalties.get(name) ?? 0 };
  });
  const open = Object.values(snapshot.stalls).filter((s) => s.state === 'free').length;
  return { streets, open_stalls: open, destinations: city.destinations.map((d) => d.name) };
}

function runTool(name: string, args: any, ctx: OperatorContext): { result: unknown; done?: string } {
  if (name === 'get_city_status') return { result: cityStatus(ctx) };
  if (name === 'avoid_street') {
    const known = ctx.city.segments.some((s) => s.street === args.street);
    if (!known) return { result: { error: `No street named ${args.street}` } };
    const seconds = Math.max(0, Math.min(Number(args.extra_seconds) || 0, 300));
    if (seconds === 0) ctx.twin.tes.streetPenalties.delete(args.street);
    else ctx.twin.tes.streetPenalties.set(args.street, seconds);
    return { result: { ok: true, street: args.street, extra_seconds: seconds } };
  }
  if (name === 'report_to_operator') return { result: { ok: true }, done: String(args.summary ?? '') };
  return { result: { error: `Unknown tool ${name}` } };
}

export async function runOperator(text: string, ctx: OperatorContext): Promise<void> {
  const { client, model, twin } = ctx;
  const log = (kind: 'request' | 'tool_call' | 'tool_result' | 'reply' | 'error', detail: string, name?: string) =>
    twin.addEvent({ tripId: TRIP_ID, kind, detail, name });

  log('request', `City goal: ${text}`);
  const messages: any[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: text },
  ];
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await client.chat.completions.create({ model, messages, tools: TOOLS } as never);
      const usage = (response as any).usage?.total_tokens;
      if (usage) ctx.onTokens(usage);
      const message = (response as any).choices[0].message;
      messages.push(message);
      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        log('reply', message.content ?? 'No changes made.');
        return;
      }
      for (const call of calls) {
        const name = call.function.name;
        let args: any = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          // A malformed call goes back to the model as a tool error.
        }
        log('tool_call', JSON.stringify(args), name);
        const { result, done } = runTool(name, args, ctx);
        log('tool_result', JSON.stringify(result).slice(0, 300), name);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        if (done !== undefined) {
          log('reply', done);
          return;
        }
      }
    }
    log('error', 'The operator ran out of steps.');
  } catch (err) {
    log('error', err instanceof Error ? err.message.slice(0, 200) : 'Operator call failed');
  }
}
