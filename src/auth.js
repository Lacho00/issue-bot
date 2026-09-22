export function authorizeMessage(msg, ownerId) {
  if (!msg?.from || msg.chat?.type !== 'private') return 'ignore';
  if (msg.forward_origin || msg.forward_date) return 'ignore';
  if (ownerId == null) return 'register';
  return msg.from.id === ownerId ? 'allow' : 'ignore';
}

export function authorizeCallback(from, ownerId) {
  return ownerId != null && from?.id === ownerId;
}
