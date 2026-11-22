import type { ValueTransformer } from 'typeorm';

/**
 * PostgreSQL returns NUMERIC columns as strings (JavaScript numbers cannot hold
 * every NUMERIC exactly). Lab values fit comfortably in a double, so convert here.
 */
export const numericTransformer: ValueTransformer = {
  to: (value?: number | null) => value,
  from: (value?: string | null) => (value === null || value === undefined ? null : Number(value)),
};
