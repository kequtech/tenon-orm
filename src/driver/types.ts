/** pg default representations, shared by generation and query inspection. */
export type ValueTypes = Readonly<{ read: string; write: string }>;
type TypeMapping = string | ValueTypes;

// Arrays use verified built-in OIDs: their parsers can differ from scalar parsers.
export const arrayTypes: Readonly<Record<string, TypeMapping>> = {
  '1000': 'boolean',
  '1001': 'import("node:buffer").Buffer',
  '1005': 'number',
  '1007': 'number',
  '1021': 'number',
  '1022': 'number',
  '1028': 'number',
  '1016': { read: 'string', write: 'string | bigint' },
  '1231': { read: 'number', write: 'string | number' },
  '1009': 'string',
  '1014': 'string',
  '1015': 'string',
  '1183': 'string',
  '1270': 'string',
  '2951': 'string',
  '1182': { read: 'globalThis.Date | number', write: 'globalThis.Date | string' },
  '1115': { read: 'globalThis.Date | number', write: 'globalThis.Date | string' },
  '1185': { read: 'globalThis.Date | number', write: 'globalThis.Date | string' },
  '199': { read: 'unknown', write: 'string' },
  '3807': { read: 'unknown', write: 'string' },
};

export const scalarTypes: Readonly<Record<string, TypeMapping>> = {
  int2: 'number',
  int4: 'number',
  oid: 'number',
  float4: 'number',
  float8: 'number',
  bool: 'boolean',
  text: 'string',
  name: 'string',
  varchar: 'string',
  bpchar: 'string',
  time: 'string',
  timetz: 'string',
  uuid: 'string',
  date: { read: 'globalThis.Date | number', write: 'globalThis.Date | string' },
  timestamp: { read: 'globalThis.Date | number', write: 'globalThis.Date | string' },
  timestamptz: { read: 'globalThis.Date | number', write: 'globalThis.Date | string' },
  int8: { read: 'string', write: 'string | bigint' },
  numeric: { read: 'string', write: 'string | number' },
  json: { read: 'unknown', write: 'string' },
  jsonb: { read: 'unknown', write: 'string' },
  bytea: 'import("node:buffer").Buffer',
};

export function valueTypes(mapping: TypeMapping): ValueTypes {
  return typeof mapping === 'string' ? { read: mapping, write: mapping } : mapping;
}
