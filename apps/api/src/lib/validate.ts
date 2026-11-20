// lib/validate.ts — Zod body parsing helper (400 on invalid input).
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { badRequest } from './errors.js';

export function parseBody<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, request: FastifyRequest): T {
  const result = schema.safeParse(request.body);
  if (!result.success) {
    const first = result.error.issues[0];
    throw badRequest(first ? `${first.path.join('.')}: ${first.message}` : 'Invalid request body');
  }
  return result.data;
}

export function parseQuery<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, request: FastifyRequest): T {
  const result = schema.safeParse(request.query);
  if (!result.success) {
    const first = result.error.issues[0];
    throw badRequest(first ? `${first.path.join('.')}: ${first.message}` : 'Invalid query');
  }
  return result.data;
}
