// The trip agent. Muse Spark decides what to do and calls tools; it never computes a route.
import type { CityMap, Destination, TripLeg, TripPlan, Vec2 } from '@carmacar/shared';
import { distance } from '@carmacar/shared';
import type OpenAI from 'openai';
import type { Twin } from './twin';

const MAX_ROUNDS = 8;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_destinations',
      description: 'List every place in the city a driver can go, with ids and kinds.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_twin',
      description: 'Get live parking near a destination, as seen by cameras: counts of free, occupied and unseen stalls.',
      parameters: {
        type: 'object',
        properties: { destination_id: { type: 'string' } },
        required: ['destination_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_parking',
      description: 'Find the best free, unreserved stall near a destination.',
      parameters: {
        type: 'object',
        properties: {
          destination_id: { type: 'string' },
          exclude_stall_ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['destination_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reserve_stall',
      description: 'Hold a stall for this car so no other car is sent there. Releases any stall it held before.',
      parameters: {
        type: 'object',
        properties: { stall_id: { type: 'string' } },
        required: ['stall_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_trip',
      description: 'Commit the final plan: ordered stops. Call this exactly once, as the last step.',
      parameters: {
        type: 'object',
        properties: {
          reply: { type: 'string', description: 'One or two friendly sentences for the driver.' },
          legs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                destination_id: { type: 'string' },
                stall_id: { type: ['string', 'null'] },
                stay_minutes: { type: ['number', 'null'] },
                arrive_by: { type: ['string', 'null'], description: 'Clock time, if the driver gave one.' },
              },
              required: ['destination_id', 'stall_id', 'stay_minutes', 'arrive_by'],
              additionalProperties: false,
            },
          },
        },
        required: ['reply', 'legs'],
        additionalProperties: false,
      },
    },
  },
];

const SYSTEM_PROMPT = `You are the CarMaCar trip agent for a city's live parking network. Drivers tell you where they want to go. You turn that into a plan.

Rules:
- Use list_destinations to resolve place names. Never invent a destination.
- Reserve a stall only for the first stop, because later stops may change by the time the driver gets there. Use stall_id null for later stops.
- Parking data is live from street cameras. If find_parking returns nothing, plan the stop with stall_id null and say so honestly.
- arrive_by is only for a time the driver must be there. "The movie ends at 3pm" is not an arrival time: set stay_minutes if you can work it out, otherwise leave both null and mention it in your reply.
- If the driver changes their mind, build a new plan from their request. The current plan is given to you.
- Finish by calling schedule_trip exactly once.`;

interface AgentContext {
  client: OpenAI;
  model: string;
  city: CityMap;
  twin: Twin;
  trip: TripPlan;
  position: Vec2;
  onTokens(total: number): void;
}

function runTool(name: string, args: any, ctx: AgentContext): { result: unknown; plan?: { reply: string; legs: TripLeg[] } } {
  const { city, twin, trip } = ctx;
  const byId = (id: string): Destination | undefined => city.destinations.find((d) => d.id === id);

  switch (name) {
    case 'list_destinations':
      return {
        result: city.destinations.map((d) => ({
          id: d.id,
          name: d.name,
          kind: d.kind,
          distance_m: Math.round(distance(d, ctx.position)),
        })),
      };
    case 'query_twin': {
      const d = byId(args.destination_id);
      if (!d) return { result: { error: 'Unknown destination' } };
      const near = city.stalls.filter((s) => distance(s.center, d) < 90);
      const count = (state: string) => near.filter((s) => twin.stall(s.id)?.state === state).length;
      return { result: { free: count('free'), occupied: count('occupied'), unseen: count('unknown') } };
    }
    case 'find_parking': {
      const d = byId(args.destination_id);
      if (!d) return { result: { error: 'Unknown destination' } };
      const found = twin.findParking(d, args.exclude_stall_ids ?? []);
      if (!found) return { result: { stall_id: null } };
      const garage = city.garages.find((g) => g.id === found.stall.garageId);
      const where = garage ? `${garage.name}, level ${(found.stall.level ?? 0) + 1}` : 'street parking';
      return { result: { stall_id: found.stall.id, walk_meters: found.walkMeters, where } };
    }
    case 'reserve_stall':
      return { result: { reserved: twin.reserve(args.stall_id, trip.carId) } };
    case 'schedule_trip': {
      const legs: TripLeg[] = (args.legs ?? []).flatMap((leg: any) => {
        const d = byId(leg.destination_id);
        if (!d) return [];
        return [{
          destinationId: d.id,
          destinationName: d.name,
          stallId: leg.stall_id ?? null,
          stayMinutes: leg.stay_minutes ?? null,
          arriveBy: leg.arrive_by ?? null,
        }];
      });
      return { result: { ok: legs.length > 0 }, plan: { reply: String(args.reply ?? ''), legs } };
    }
    default:
      return { result: { error: `Unknown tool ${name}` } };
  }
}

export async function runTripAgent(text: string, ctx: AgentContext): Promise<void> {
  const { client, model, twin, trip } = ctx;
  const log = (kind: 'request' | 'tool_call' | 'tool_result' | 'reply' | 'error', detail: string, name?: string) =>
    twin.addEvent({ tripId: trip.tripId, kind, detail, name });

  log('request', text);
  const current = trip.legs.length > 0 ? `\nCurrent plan: ${JSON.stringify(trip.legs)}` : '';
  const messages: any[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `${text}${current}` },
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
        trip.reply = message.content ?? 'I could not build a plan.';
        trip.status = 'failed';
        log('error', 'The agent stopped without scheduling a trip.');
        return;
      }
      for (const call of calls) {
        const name = call.function.name;
        let args: any = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          // A malformed call goes back to the model as a tool error below.
        }
        log('tool_call', JSON.stringify(args), name);
        const { result, plan } = runTool(name, args, ctx);
        log('tool_result', JSON.stringify(result).slice(0, 400), name);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        if (plan && plan.legs.length > 0) {
          trip.legs = plan.legs;
          trip.reply = plan.reply;
          trip.status = 'ready';
          log('reply', plan.reply);
          return;
        }
      }
    }
    trip.status = 'failed';
    trip.reply = 'I ran out of steps building that plan.';
    log('error', trip.reply);
  } catch (err) {
    trip.status = 'failed';
    trip.reply = 'The trip agent is unavailable right now.';
    log('error', err instanceof Error ? err.message.slice(0, 200) : 'Agent call failed');
  }
}
