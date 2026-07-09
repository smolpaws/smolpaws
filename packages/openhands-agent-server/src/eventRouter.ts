import type { FastifyInstance } from 'fastify';

import type { ConversationService } from './conversationService.js';
import { eventSortOrderSchema, messageFromSendRequest, sendMessageRequestSchema, confirmationResponseRequestSchema } from './models.js';
import { acceptedDeviation, arrayQuery, dateQuery, eventServiceOr404, intQuery, param, parseBody, queryRecord, stringQuery } from './routeUtils.js';

export function registerEventRoutes(app: FastifyInstance, service: ConversationService): void {
  app.get('/api/conversations/:conversation_id/events/search', async (request, reply) => {
    const eventService = await eventServiceOr404(reply, service, param(request, 'conversation_id'));
    if (eventService === null) return undefined;
    const query = queryRecord(request);
    return eventService.searchEvents(
      stringQuery(query.page_id),
      intQuery(query.limit, 100),
      stringQuery(query.kind),
      stringQuery(query.source),
      stringQuery(query.body),
      eventSortOrderSchema.catch('TIMESTAMP').parse(query.sort_order),
      dateQuery(query.timestamp__gte),
      dateQuery(query.timestamp__lt),
    );
  });

  app.get('/api/conversations/:conversation_id/events/count', async (request, reply) => {
    const eventService = await eventServiceOr404(reply, service, param(request, 'conversation_id'));
    if (eventService === null) return undefined;
    const query = queryRecord(request);
    return eventService.countEvents(stringQuery(query.kind), stringQuery(query.source), stringQuery(query.body), dateQuery(query.timestamp__gte), dateQuery(query.timestamp__lt));
  });

  app.get('/api/conversations/:conversation_id/events/:event_id', async (request, reply) => {
    const eventService = await eventServiceOr404(reply, service, param(request, 'conversation_id'));
    if (eventService === null) return undefined;
    const event = await eventService.getEvent(param(request, 'event_id'));
    if (event === null) {
      reply.status(404);
      return { detail: 'Event not found' };
    }
    return event;
  });

  app.get('/api/conversations/:conversation_id/events', async (request, reply) => {
    const eventService = await eventServiceOr404(reply, service, param(request, 'conversation_id'));
    if (eventService === null) return undefined;
    return eventService.batchGetEvents(arrayQuery(queryRecord(request).event_ids));
  });

  app.post('/api/conversations/:conversation_id/events', async (request, reply) => {
    const eventService = await eventServiceOr404(reply, service, param(request, 'conversation_id'));
    if (eventService === null) return undefined;
    const body = parseBody(sendMessageRequestSchema, request.body);
    await eventService.sendMessage(messageFromSendRequest(body), body.run);
    return { success: true };
  });

  app.post('/api/conversations/:conversation_id/events/respond_to_confirmation', async (request, reply) => {
    const eventService = await eventServiceOr404(reply, service, param(request, 'conversation_id'));
    if (eventService === null) return undefined;
    parseBody(confirmationResponseRequestSchema, request.body);
    return acceptedDeviation(reply, 'confirmation_responses');
  });
}
