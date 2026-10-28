import type { Client, Connection, FieldDef, Submittable } from 'pg';

export interface Description {
  parameters: number[];
  fields: FieldDef[];
}

/** Describe through pg custom query dispatch; send no Bind or Execute messages. */
export function describe(client: Client, text: string): Promise<Description> {
  return new Promise((resolve, reject) => {
    let connection: Connection | undefined;
    const description: Description = { parameters: [], fields: [] };
    const parameters = (message: { dataTypeIDs: number[] }) => {
      description.parameters = message.dataTypeIDs;
    };
    const cleanup = () => connection?.removeListener('parameterDescription', parameters);
    const query: Submittable & {
      callback(error: Error | null): void;
      handleRowDescription(message: { fields: FieldDef[] }): void;
      handleReadyForQuery(): void;
      handleError(error: Error): void;
    } = {
      // pg wraps callback to manage query_timeout, including clearing its timer.
      callback(error) {
        cleanup();
        if (error) reject(error);
        else resolve(description);
      },
      submit(wire) {
        connection = wire;
        wire.once('parameterDescription', parameters);
        try {
          wire.parse({ name: '', text, types: [] }, false);
          wire.describe({ type: 'S', name: '' }, false);
          wire.sync();
        } catch (error) {
          return error instanceof Error
            ? error
            : new Error('Describe dispatch failed', { cause: error });
        }
      },
      handleRowDescription(message) {
        description.fields = message.fields;
      },
      handleReadyForQuery() {
        query.callback(null);
      },
      handleError(error) {
        query.callback(error);
      },
    };
    client.query(query);
  });
}
