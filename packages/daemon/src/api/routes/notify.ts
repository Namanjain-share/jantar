/**
 * v0.5.3 alerts: `notifyTest` (POST /v1/notify/test, admin, the Mac only),
 * one test push of an alert group to every device (jantar notify test
 * [group]). Wave 0's stub answers 501 until the alerts package builds it.
 */
import { notImplementedRoute, type RouteTable } from '../route-kit.js';

export const NOTIFY_ROUTE_IMPLS: RouteTable = {
  notifyTest: notImplementedRoute('Test alerts'),
};
