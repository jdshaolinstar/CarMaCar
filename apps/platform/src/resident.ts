// AI residents. A simulation layer, not part of the product: Muse Spark plays a person with a life,
// who decides where to go next. They then use the same trip agent a real driver would.
import type { CityMap } from '@carmacar/shared';
import type OpenAI from 'openai';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['thought', 'request'],
  properties: {
    thought: { type: 'string', description: 'One short first-person sentence: what you feel like doing and why.' },
    request: { type: 'string', description: 'What you say to your car app, such as "Take me to Noodle Bar and find parking".' },
  },
};

export interface ResidentChoice {
  thought: string;
  request: string;
}

export async function decideNextTrip(
  client: OpenAI,
  model: string,
  city: CityMap,
  name: string,
  persona: string,
  lastPlace: string | null,
  onTokens: (tokens: number) => void,
): Promise<ResidentChoice | null> {
  const places = city.destinations.map((d) => `${d.name} (${d.kind})`).join(', ');
  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content: `You are ${name}, a resident of a small city. ${persona} Decide where you go next, in character. Places in town: ${places}.`,
      },
      {
        role: 'user',
        content: lastPlace ? `You have just been at ${lastPlace}. What do you do next?` : 'Your evening is starting. Where do you go first?',
      },
    ],
    response_format: { type: 'json_schema', json_schema: { name: 'next_trip', strict: true, schema: SCHEMA } },
  } as never);
  const usage = (response as any).usage?.total_tokens;
  if (usage) onTokens(usage);
  try {
    return JSON.parse((response as any).choices[0].message.content ?? 'null');
  } catch {
    return null;
  }
}
