import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { ConversationService } from './conversationService.js';
import type { EventService } from './eventService.js';

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  return schema.parse(body);
}

export function params(request: FastifyRequest): Record<string, string | undefined> {
  return request.params as Record<string, string | undefined>;
}

export function param(request: FastifyRequest, name: string): string {
  const value = params(request)[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`missing_path_param:${name}`);
  }
  return value;
}

export function queryRecord(request: FastifyRequest): Record<string, unknown> {
  return request.query as Record<string, unknown>;
}

export function stringQuery(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

export function arrayQuery(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

export function intQuery(value: unknown, fallback: number): number {
  const raw = stringQuery(value);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : fallback;
}

export function dateQuery(value: unknown): Date | null {
  const raw = stringQuery(value);
  if (raw === null) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function eventServiceOr404(reply: FastifyReply, service: ConversationService, conversationId: string): Promise<EventService | null> {
  const eventService = await service.getEventService(conversationId);
  if (eventService === null) {
    reply.status(404).send({ detail: 'Conversation not found' });
    return null;
  }
  return eventService;
}

export function successOrNotFound(reply: FastifyReply, success: boolean): { success: boolean } | { detail: string } {
  if (!success) {
    reply.status(404);
    return { detail: 'Conversation not found' };
  }
  return { success: true };
}

export function notImplemented(reply: FastifyReply, detail: string): { detail: string } {
  reply.status(501);
  return { detail };
}

export function acceptedDeviation(reply: FastifyReply, feature: string): { readonly detail: string; readonly accepted_deviation: true; readonly feature: string } {
  reply.status(410);
  return {
    detail: `${feature} is intentionally not supported in the TypeScript port by design`,
    accepted_deviation: true,
    feature,
  };
}

