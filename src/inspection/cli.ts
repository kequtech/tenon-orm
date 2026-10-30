export const describeFlags = {
  role: { type: 'string' },
  'search-path': { type: 'string' },
  'time-zone': { type: 'string' },
  'connect-timeout-ms': { type: 'string' },
  'statement-timeout-ms': { type: 'string' },
  'lock-timeout-ms': { type: 'string' },
} as const;

/** Translate CLI flags; validation and defaults belong to the public API. */
export function inspectionSettings(
  values: Partial<Record<keyof typeof describeFlags, string | undefined>>,
) {
  return {
    session: {
      ...(values.role !== undefined && { role: values.role }),
      ...(values['search-path'] !== undefined && { searchPath: values['search-path'] }),
      ...(values['time-zone'] !== undefined && { timeZone: values['time-zone'] }),
    },
    timeouts: {
      ...(values['connect-timeout-ms'] !== undefined
        ? { connectMs: Number(values['connect-timeout-ms']) }
        : {}),
      ...(values['statement-timeout-ms'] !== undefined
        ? { statementMs: Number(values['statement-timeout-ms']) }
        : {}),
      ...(values['lock-timeout-ms'] !== undefined
        ? { lockMs: Number(values['lock-timeout-ms']) }
        : {}),
    },
  };
}
