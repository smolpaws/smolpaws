import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { BashEventService } from './bashService.js';
import { executeBashRequestSchema } from './models.js';
import {
  arrayQuery,
  dateQuery,
  intQuery,
  parseBody,
  queryRecord,
  stringArrayBody,
  stringQuery,
} from './routeUtils.js';

export function registerBashRoutes(app: FastifyInstance, service: BashEventService): void {
  app.get('/api/bash/bash_events/search', async (request) => {
    const query = queryRecord(request);
    return service.searchBashEvents({
      kind: stringQuery(query.kind__eq),
      commandId: stringQuery(query.command_id__eq),
      timestampGte: dateQuery(query.timestamp__gte),
      timestampLt: dateQuery(query.timestamp__lt),
      orderGt: intQuery(query.order__gt, Number.NaN),
      pageId: stringQuery(query.page_id),
      limit: intQuery(query.limit, 100),
      sortOrder: query.sort_order === 'TIMESTAMP_DESC' ? 'TIMESTAMP_DESC' : 'TIMESTAMP',
    });
  });

  const batchGetBashEvents = async (request: FastifyRequest) => {
    const bodyIds = stringArrayBody(request.body);
    const eventIds = bodyIds.length > 0
      ? bodyIds
      : arrayQuery(queryRecord(request).event_ids);
    return service.batchGetBashEvents(eventIds);
  };

  app.get('/api/bash/bash_events', batchGetBashEvents);
  app.get('/api/bash/bash_events/', batchGetBashEvents);

  app.get('/api/bash/bash_events/:event_id', async (request, reply) => {
    const eventId = typeof request.params === 'object' && request.params !== null && 'event_id' in request.params ? String(request.params.event_id) : '';
    const event = await service.getBashEvent(eventId);
    if (event === null) {
      reply.status(404).send({ detail: 'Item not found' });
      return undefined;
    }
    return event;
  });

  app.post('/api/bash/start_bash_command', async (request) => {
    const { command } = await service.startBashCommand(parseBody(executeBashRequestSchema, request.body));
    return command;
  });

  app.post('/api/bash/execute_bash_command', async (request) => service.executeBashCommand(parseBody(executeBashRequestSchema, request.body)));

  app.delete('/api/bash/bash_events', async () => ({ cleared_count: await service.clearAllEvents() }));
}
