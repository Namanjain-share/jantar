/**
 * v0.10 Chat (spec 0.10 B5): the phone's thread routes, the Mac's chat keys
 * and the Siri door. Placeholders until Chat's part is wired.
 */
import { notImplementedRoute, type RouteTable } from '../route-kit.js';

const stub = notImplementedRoute('Chat');

export const CHAT_ROUTE_IMPLS: RouteTable = {
  chatList: stub,
  chatSend: stub,
  chatClear: stub,
  chatStatus: stub,
  chatCancel: stub,
  chatUndo: stub,
  chatCard: stub,
  chatCardDismiss: stub,
  chatPhotoAdd: stub,
  chatPhoto: stub,
  chatPhotoDelete: stub,
  chatKeyAdd: stub,
  chatKeyList: stub,
  chatKeyRevoke: stub,
  captureChat: stub,
};
