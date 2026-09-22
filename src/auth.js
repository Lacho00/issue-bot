const CHAT_TYPES = new Set(['private', 'group', 'supergroup']);

export function isForwarded(msg) {
  return Boolean(msg?.forward_origin || msg?.forward_date);
}

export function authorizeMessage(msg, ownerId, chatId) {
  if (!msg?.from) return 'ignore';
  if (!CHAT_TYPES.has(msg.chat?.type)) return 'ignore';
  // Un reenvío cuenta como mensaje del dueño si lo reenvía él en su chat; nunca registra.
  if (ownerId == null) return isForwarded(msg) ? 'ignore' : 'register';
  const allowedChat = chatId ?? ownerId;
  return msg.from.id === ownerId && msg.chat.id === allowedChat ? 'allow' : 'ignore';
}

export function authorizeCallback(from, ownerId, chatId, chat) {
  if (ownerId == null || from?.id !== ownerId) return false;
  const allowedChat = chatId ?? ownerId;
  return chat?.id === allowedChat;
}
