import type { AssistantAiEnv } from './assistant-ai';

export interface Env extends AssistantAiEnv {
  TELEGRAM_BOT_TOKEN: string;
  WEBHOOK_SECRET_TOKEN: string;
  AI?: NluAiBinding;
  AI_FREE_TIER_CONFIRMED?: string;
  DB?: D1Database;
  OWNER_SETUP_TOKEN_HASH?: string;
  CONTRIBUTIONS_ENABLED?: string;
  PRODUCT_MODE_ENABLED?: string;
  PRODUCT_AUTOMATION_ENABLED?: string;
  GROUP_AI_ENABLED?: string;
  PRODUCT_ALLOWED_GROUP_IDS?: string;
}

export interface NluAiBinding {
  run(model: string, inputs: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
}

export interface MessageEntity {
  type: string;
  offset: number;
  length: number;
}

export interface TelegramMessage {
  is_topic_message?: boolean;
  message_id: number;
  date?: number;
  from?: TelegramUser;
  sender_chat?: { id: number };
  via_bot?: TelegramUser;
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel' };
  text?: string;
  caption?: string;
  caption_entities?: MessageEntity[];
  photo?: TelegramPhoto[];
  document?: TelegramDocument;
  reply_to_message?: TelegramReplyReference;
  chat_shared?: TelegramChatShared;
  entities?: MessageEntity[];
  message_thread_id?: number;
}

/** Telegram references only: this bot does not download attachments. */
export interface TelegramPhoto {
  file_id: string;
  file_unique_id?: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramReplyReference {
  is_topic_message?: boolean;
  via_bot?: TelegramUser;
  message_id: number;
  date?: number;
  chat: TelegramMessage['chat'];
  from?: TelegramUser;
  text?: string;
  caption?: string;
}

export interface TelegramChatShared {
  request_id: number;
  chat_id: number;
  title?: string;
  username?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  chat_instance: string;
  message?: TelegramMessage;
  inline_message_id?: string;
  data?: string;
}

export interface InlineQuery {
  id: string;
  from: TelegramUser;
  query: string;
  offset: string;
}

export interface TelegramUpdate {
  update_id: number;
  channel_post?: TelegramMessage;
  message?: TelegramMessage;
  inline_query?: InlineQuery;
  callback_query?: TelegramCallbackQuery;
}
