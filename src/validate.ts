// Schema v1 allowlist. An event is forwarded only if its name is known and
// every property it carries is known and holds an allowed value. Anything
// else drops that one event and keeps the rest of the batch, so a newer CLI
// with an extra field loses that event instead of the whole run.
import schema from '../schema/v1.json';

export type Props = Record<string, unknown>;
export interface Event {
  event: string;
  ts: string;
  props: Props;
}
export interface Batch {
  schema: 1;
  install_id: string;
  events: unknown[];
}

const { limits, enums, flags, recipes, events: eventSpecs } = schema;
const recipeNames = new Set(Object.keys(recipes));
const recipeSteps = recipes as Record<string, string[]>;
const flagNames = new Set(flags);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION = /^v\d{1,3}\.\d{1,4}\.\d{1,5}(-[0-9A-Za-z.-]{1,20})?$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;
const isRecipe = (v: unknown) => v === 'custom' || (typeof v === 'string' && recipeNames.has(v));

/** Whether one property value matches its spec, e.g. "enum:command" or "int:services". */
function valid(spec: string, value: unknown, props: Props): boolean {
  const [kind, arg] = spec.split(':');
  switch (kind) {
    case 'bool':
      return typeof value === 'boolean';
    case 'version':
      return value === 'dev' || (typeof value === 'string' && VERSION.test(value));
    case 'enum':
      return typeof value === 'string' && (enums as Record<string, string[]>)[arg].includes(value);
    case 'int':
      return isCount(value, (limits as Record<string, number>)[arg]);
    case 'recipe':
      return isRecipe(value);
    case 'step': {
      // A built-in step must belong to the event's recipe; custom recipes only report "custom".
      if (value === 'custom') return true;
      const recipe = props.recipe;
      return typeof recipe === 'string' && recipe !== 'custom' && (recipeSteps[recipe] ?? []).includes(value as string);
    }
    case 'recipe_counts':
      return (
        isObject(value) && Object.entries(value).every(([name, n]) => isRecipe(name) && isCount(n, limits.services))
      );
    case 'flags':
      return (
        isObject(value) && Object.entries(value).every(([name, on]) => flagNames.has(name) && typeof on === 'boolean')
      );
    default:
      return false;
  }
}

/** The batch envelope: schema version, install ID and an events array. */
export function parseBatch(body: unknown): Batch | null {
  if (!isObject(body) || body.schema !== 1) return null;
  if (typeof body.install_id !== 'string' || !UUID_V4.test(body.install_id)) return null;
  if (!Array.isArray(body.events)) return null;
  return body as unknown as Batch;
}

export type Drop = 'shape' | 'event' | 'property' | 'value' | 'timestamp';

/** One event, or the reason it was dropped. */
export function validateEvent(raw: unknown): { ok: true; event: Event } | { ok: false; reason: Drop } {
  if (!isObject(raw) || typeof raw.event !== 'string' || !isObject(raw.props)) return { ok: false, reason: 'shape' };
  const spec = (eventSpecs as Record<string, Record<string, string>>)[raw.event];
  if (!spec) return { ok: false, reason: 'event' };
  if (typeof raw.ts !== 'string' || Number.isNaN(Date.parse(raw.ts))) return { ok: false, reason: 'timestamp' };

  const props = raw.props;
  for (const [key, value] of Object.entries(props)) {
    if (!(key in spec)) return { ok: false, reason: 'property' };
    if (!valid(spec[key], value, props)) return { ok: false, reason: 'value' };
  }
  return { ok: true, event: { event: raw.event, ts: new Date(raw.ts).toISOString(), props } };
}

export const LIMITS = limits;
