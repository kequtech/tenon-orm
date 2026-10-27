import { readStatementMetadata } from './inspection/catalog.js';
import { withInspectionConnection } from './inspection/connection.js';
import { queryDescription } from './inspection/result.js';
import type { DescribeOptions, QueryDescription } from './inspection/types.js';
import { plainObject } from './validation.js';

/** Describe finished SQL without binding values or executing the inspected statement. */
export async function describeQuery(options: DescribeOptions): Promise<QueryDescription> {
  const input = plainObject(options, 'Describe options');
  for (const key of Object.keys(input)) {
    if (!['connection', 'query', 'session', 'timeouts'].includes(key)) {
      throw new Error(`Unknown Describe option: ${key}`);
    }
  }
  let text: unknown = input.query;
  if (text !== null && typeof text === 'object' && 'text' in text) text = text.text;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Describe query requires nonempty SQL text or a query object with text.');
  }
  const query = text;
  return withInspectionConnection(options, async (client, context) =>
    queryDescription(await readStatementMetadata(client, query), context),
  );
}
