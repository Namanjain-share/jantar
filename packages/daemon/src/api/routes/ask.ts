/**
 * v0.5.3 Ask's routes (feature `ask`): placeholders that answer 501 until
 * the Ask part lands (daemon ask/).
 */
import { notImplementedRoute, type RouteTable } from '../route-kit.js';

const stub = notImplementedRoute('Ask');

export const ASK_ROUTE_IMPLS: RouteTable = {
  askList: stub,
  askSend: stub,
  askClear: stub,
  askCancel: stub,
  askAdd: stub,
  askSkip: stub,
  askUndo: stub,
};
