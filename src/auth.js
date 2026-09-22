const CHAT_TYPES = new Set(['private', 'group', 'supergroup']);

export function authorizeMessage(msg, ownerId, chatId) {
  if (!msg?.from) return 'ignore';
  if (msg.forward_origin || msg.forward_date) return 'ignore';
  if (!CHAT_TYPES.has(msg.chat?.type)) return 'ignore';
  if (ownerId == null) return 'register';
  const allowedChat = chatId ?? ownerId;
  return msg.from.id === ownerId && msg.chat.id === allowedChat ? 'allow' : 'ignore';
}

export function authorizeCallback(from, ownerId, chatId, chat) {
  if (ownerId == null || from?.id !== ownerId) return false;
  const allowedChat = chatId ?? ownerId;
  return chat?.id === allowedChat;
}
