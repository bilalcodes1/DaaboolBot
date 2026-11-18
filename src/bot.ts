import {referencedCancellationIntent} from './assistant-cancel';
import { handleProductUpdate } from './product-router';
import { handleNaturalAdmin, anonymousAdminIntent, DISCUSSION_GROUP } from './natural-admin';
import { hasBotMention, normalizeArabic, stripMentions } from './input';
import { NluClassifier } from './nlu';
import { renderQuery } from './query';
import { TelegramClient, TelegramError } from './telegram';
import type { Env, TelegramMessage, TelegramUpdate } from './types';
import { stripWakeWord } from './personality';
import { handleContributions, type ContributionEnv } from './event-workflow';
import { EventStore } from './event-store';
import { classifyEventAction, isBareEventType } from './event-extract';
import { isStudentNamesRequest, sendStudentNames } from './student-names';
import { classifyAgendaQuestion, renderAgendaSchedule } from './agenda';
import { getInlineAcademicAnswer } from './inline-academic';
import { handleAssistantMessage, handleAssistantCallback, getAssistantInlineAnswer } from './assistant-handler';
import { isAssistantAiEnabled } from './assistant-ai';
import { assistantStorageReady, splitAssistantHtml } from './assistant-store';
import { recordAssistantDeliveredTurn } from './assistant-direct-context';

const HELP = 'آني دعبول 🤖\nبالخاص اسألني مباشرةً؛ وبالكروب ناديني «دعبول» أو منشنّي.\n«شعدنا؟» للتبليغات القادمة، و«شعدنا باچر؟» لمحاضرات وتبليغات باچر.\nتگدر تكتب:\n• شعدنا باجر؟\n• مختبرات مجموعة B الأسبوع الجاي\n• شنو عندي المحاضرة اللي تجي؟\n• منو الدكتور مال المحاضرة الجاية؟\n• شعدنا امتحانات وكوزات الأسبوع الجاي؟\n• دزلي ملف امتحان المترجمات\n• شنو لازم اقره للمترجمات؟\n• دعبول الاثنين الجاي عدنا امتحان مترجمات للكل\nلإضافة مساهمة جديدة، ابدأ رسالتك بـ«دعبول» حصراً. بعدها رد على رسالتي حتى نكملها.\nالتبليغات تبقى عندي ويا المطلوب والمرفق بعد اعتماد الأدمن.\nأوقات المحاضرات مؤقتة وتقديرية.';

function isHelp(text: string, username: string): boolean {
  return new RegExp(`^/(?:start|help)(?:@${username})?(?:\\s+\\S+)?$`, 'i').test(text.trim());
}

/** A clear question may interrupt a private form without becoming its next field. */
function privateQuestion(text: string, now: Date): boolean {
  if (isStudentNamesRequest(text)) return true;
  if (classifyAgendaQuestion(text, now)) return true;
  // A type-only answer to an established form remains linked to its prompt.
  if (isBareEventType(text)) return false;
  if (classifyEventAction(text) === 'list') return true;
  const normalized = normalizeArabic(text).replace(/ة/g, 'ه').replace(/ى/g, 'ي');
  return /(?:^|\s)(?:شنو|شعدنا|شعدنه|شعندنا|اشعدنا|اشعندنا|شنعدنا|شوكت|متي|ايمتي|ايمتا|امتي|وين|اين|منو|ماذا|ماهي|ماهو|هل|جدول|جدولنا|اعرض|عرض|اعطني|اعطيني|انطيني|دزلي|جيبلي|ذكرني)(?=$|\s)/u.test(normalized)
    || /(?:^|\s)ما\s+(?:هي|هو|وقت|موعد|جدول|لدينا|عندنا|المحاضره|الواجب|الامتحان)(?=$|\s)/u.test(normalized)
    || /(?:^|\s)(?:المحاضره|محاضره)\s+(?:(?:الجايه|الحاليه|المتبقيه)|(?:اللي|الي)\s+(?:تجي|جايه|بعدها)|التي\s+تليها)(?=$|\s)/u.test(normalized)
    || (/(?:^|\s)(?:ال)?(?:مختبرات|لابات|محاضرات)(?=$|\s)/u.test(normalized)
      && /(?:^|\s)(?:الاسبوع|هالاسبوع|اليوم|باجر|باچر|غدا|بكرا|الاحد|الاثنين|الثلاثاء|الاربعاء|الخميس|الجمعه|السبت)(?=$|\s)/u.test(normalized));
}

function replyPayload(message: TelegramMessage, text: string) {
  if (text.length > 4096) throw new Error('Message length exceeded');
  return {
    chat_id: message.chat.id,
    text,
    parse_mode: 'HTML',
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    ...(message.message_thread_id !== undefined ? { message_thread_id: message.message_thread_id } : {}),
  };
}

export async function handleUpdate(update: TelegramUpdate, telegram: TelegramClient, now = new Date(),
  env: ContributionEnv = {}, classifier = new NluClassifier(), fetcher: typeof fetch = fetch): Promise<void> {
  telegram.setPreservePrivateKeyboard?.(env.PRODUCT_MODE_ENABLED==='true');
  if(env.PRODUCT_MODE_ENABLED==='true'){
    await handleProductUpdate(update,telegram,env as Env,now,fetcher);
    return;
  }
  if (update.inline_query) {
    const query = update.inline_query;
    if (query.from.is_bot) return;
    const empty = normalizeArabic(query.query) === '';
    const question = empty ? 'شنو عدنا باچر؟' : stripWakeWord(query.query) ?? query.query;
    if (!empty && query.offset === '' && isAssistantAiEnabled(env)) {
      const answer = await getAssistantInlineAnswer(question, query.from.id, env, now, fetcher);
      if (answer !== null) {
        const pages = splitAssistantHtml(answer);
        await telegram.call('answerInlineQuery', { inline_query_id: query.id, cache_time: 3, is_personal: true, next_offset: '',
          results: pages.slice(0, 10).map((page, index) => {
            // Telegram shows this preview before the user selects an article.
            // Display the actual answer (or retry guidance), not a generic label.
            const preview = page.replace(/<[^>]*>/g, '').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
              .replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&amp;', '&').replace(/\s+/g, ' ').trim();
            const characters = Array.from(preview);
            return { type: 'article', id: `assistant-${update.update_id}-${index}`,
              title: pages.length > 1 ? `جواب دعبول — ${index + 1}/${pages.length}` : 'جواب دعبول',
              description: characters.slice(0, 240).join('') + (characters.length > 240 ? '…' : ''),
              input_message_content: { message_text: page, parse_mode: 'HTML' } };
          }) });
        return;
      }
    }
    const agenda = classifyAgendaQuestion(question, now);
    const academic = (env.DB && env.CONTRIBUTIONS_ENABLED === 'true') || agenda?.scope === 'upcoming' || classifyEventAction(question) !== null
      ? await getInlineAcademicAnswer(question, query.offset, now, env) : null;
    if (academic) {
      await telegram.call('answerInlineQuery', { inline_query_id: query.id, results: academic.results,
        cache_time: 0, is_personal: true, next_offset: academic.next_offset });
      return;
    }
    const selection = query.offset === '' ? await classifier.classify(question, env, true) : null;
    const schedule = selection ? renderQuery(selection, now) : null;
    const results = schedule ? [{
      type: 'article',
      id: schedule.id,
      title: schedule.title,
      description: empty ? 'شنو عدنا باچر؟ اختار النتيجة حتى ترسل الجدول.' : 'جدول المرحلة الثالثة – علوم الحاسوب، جامعة الأنبار',
      input_message_content: { message_text: schedule.text, parse_mode: 'HTML' },
    }] : [];
    if (schedule && schedule.text.length > 4096) throw new Error('Message length exceeded');
    await telegram.call('answerInlineQuery', {
      inline_query_id: query.id,
      results,
      cache_time: 0,
      is_personal: true,
      next_offset: '',
    });
    return;
  }

  if (update.callback_query?.data==='ui:refresh' && update.callback_query.message?.chat.type==='private' && update.callback_query.from.id===update.callback_query.message.chat.id) {
    await telegram.call('answerCallbackQuery',{callback_query_id:update.callback_query.id,text:'تم التحديث'});
    await telegram.call('sendMessage',{chat_id:update.callback_query.from.id,text:'تم التحديث؛ احچي وياي مباشرة 😄',reply_markup:{remove_keyboard:true}});
    await telegram.call('editMessageReplyMarkup',{chat_id:update.callback_query.from.id,message_id:update.callback_query.message.message_id,reply_markup:{inline_keyboard:[]}});return;
  }
  if (update.callback_query) {
    if (!await handleAssistantCallback(update, telegram, env, now)) await handleContributions(update, telegram, now, env, null);
    return;
  }
  const anonymous = update.channel_post ?? (update.message?.sender_chat ? update.message : undefined);
  if (anonymous && env.DB) {
    const body = stripWakeWord(anonymous.text ?? anonymous.caption ?? '');
    const settings = await new EventStore(env.DB).getSettings();
    if (body !== null && anonymousAdminIntent(body) && (anonymous.chat.id === settings.targetChatId || anonymous.chat.id === DISCUSSION_GROUP)) {
      const id = (await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${anonymous.chat.id}:${anonymous.message_id}`)));
      const code = Array.from(new Uint8Array(id)).slice(0,6).map(n=>n.toString(16).padStart(2,'0')).join('');
      await env.DB.prepare('INSERT OR IGNORE INTO anonymous_requests(id,chat_id,message_id,body,message_json,expires_at) VALUES(?,?,?,?,?,?)')
        .bind(code,anonymous.chat.id,anonymous.message_id,body,JSON.stringify(anonymous),now.getTime()+15*60000).run();
      await telegram.call('sendMessage',{chat_id:anonymous.chat.id,text:`وصل الطلب، بس تليگرام مخفي هوية المرسل. أحد حسابَي الأدمن يكتب إليّ بالخاص «تأكيد طلب ${code}» خلال ربع ساعة.`,reply_parameters:{message_id:anonymous.message_id}});
    }
    return;
  }
  const message = update.message;
  if (!message?.from || message.from.is_bot || message.via_bot || message.sender_chat) return;
  if (!['private', 'group', 'supergroup'].includes(message.chat.type)) return;
  const text = message.text ?? message.caption ?? '';
  if (message.chat.type === 'private' && /^(?:حدث دعبول|حدّث دعبول|تحديث دعبول)$/u.test(text.trim())) {
    await telegram.call('sendMessage',{chat_id:message.chat.id,text:'تم التحديث، احچي وياي مباشرة 😄',reply_markup:{remove_keyboard:true}});return;
  }
  let invocation = stripWakeWord(text);
  let username: string | undefined;
  // Group questions require targeting; private chats belong to this bot already.
  if (invocation === null && /@[a-z0-9_]+/i.test(text)) {
    username = (await telegram.getMe()).username;
    if (hasBotMention(message, username)) invocation = stripMentions(text).trim();
  }
  if (invocation === null && isAssistantAiEnabled(env) && message.reply_to_message?.from?.is_bot) {
    if (message.reply_to_message.from.id === (await telegram.getMe()).id) invocation = text.trim();
  }
  if(invocation===null&&isAssistantAiEnabled(env)&&message.reply_to_message?.via_bot?.is_bot&&referencedCancellationIntent(text)) {
    if(message.reply_to_message.via_bot.id===(await telegram.getMe()).id)invocation=text.trim();
  }
  const privateHelp = message.chat.type === 'private' && /^\/(?:start|help)(?:\s+\S+)?$/i.test(text.trim());
  const groupHelp = username !== undefined && isHelp(text, username);
  if (privateHelp || groupHelp) {
    await telegram.getMe();
    await telegram.call('sendMessage', {
      ...replyPayload(message, isAssistantAiEnabled(env)
        ? 'آني دعبول 🤖\nبالخاص احچي مباشرةً؛ بالكروب منشنّي أو ناديني أو رد على رسالتي.\nأجاوب أسئلتك، وأحلل التبليغات وأحفظها تلقائياً حسب كلامك.\nالرسالة تگدر تحتوي أكثر من مادة؛ الاحتمال يبقى موسوم احتمال، والمعلومة الناقصة ما أخمّنها.\nللمالك: «دعبول التذكيرات الدينية» لمعاينة وتشغيل التذكيرات.\nأوقات جدول المحاضرات مؤقتة؛ والتبليغات منسوبة للطلبة.' : HELP),
      ...(message.chat.type === 'private' ? { reply_markup: { remove_keyboard: true } } : {}),
    });
    return;
  }
  let routedUpdate = update;
  if (message.chat.type === 'private' && text.trim() && !message.chat_shared) {
    const question = privateQuestion(invocation ?? text, now);
    if (invocation === null && ((!message.reply_to_message && message.text !== undefined) || question || isAssistantAiEnabled(env) && message.text !== undefined)) invocation = text.trim();
    if (question && message.reply_to_message) {
      // Keep the actual user's question ID, but do not let a form consume the question.
      const { reply_to_message: _reply, ...independentQuestion } = message;
      routedUpdate = { ...update, message: independentQuestion };
    }
  }
  if (invocation === null && !message.reply_to_message && !message.chat_shared) return;
  if (invocation !== null) await telegram.getMe();
  if (invocation !== null && isStudentNamesRequest(invocation)) {
    const summary = await sendStudentNames(message, telegram, invocation);
    if (env.DB && isAssistantAiEnabled(env)) {
      try {
        if (await assistantStorageReady(env.DB)) await recordAssistantDeliveredTurn(env.DB, {
          updateId: update.update_id, userId: message.from.id, chatId: message.chat.id,
          threadId: message.message_thread_id ?? null, messageId: message.message_id,
          question: invocation, now: now.getTime(),
        }, summary);
      } catch { /* A context-storage failure must not retry a delivered document. */ }
    }
    return;
  }
  if (invocation !== null && isAssistantAiEnabled(env) && await handleNaturalAdmin(routedUpdate,telegram,env,invocation,now,fetcher)) return;
  if (await handleAssistantMessage(routedUpdate, telegram, now, env, invocation, fetcher)) return;
  const agenda = invocation !== null ? classifyAgendaQuestion(invocation, now) : null;
  if (agenda) {
    const schedule = renderAgendaSchedule(agenda, now);
    if (schedule) await telegram.call('sendMessage', replyPayload(message, schedule.text));
    if (env.DB && env.CONTRIBUTIONS_ENABLED === 'true') {
      try {
        await handleContributions(routedUpdate, telegram, now, env, invocation, { query: agenda.query });
      } catch (error) {
        if (error instanceof TelegramError) throw error;
        await telegram.call('sendMessage', replyPayload(message, 'ما قدرت أجيب التبليغات المعتمدة هسه. جرّب بعد شوي؛ ما أگدر أجزم شعدنا بدونها.'));
      }
    } else if (!schedule) {
      await telegram.call('sendMessage', replyPayload(message, 'التبليغات بعدهامو مفعّلة. تگدر تسألني عن جدول المحاضرات.'));
    }
    return;
  }
  if (await handleContributions(routedUpdate, telegram, now, env, invocation)) return;
  if (invocation === null || invocation === '') return;
  const selection = await classifier.classify(invocation, env);
  await telegram.call('sendMessage', replyPayload(message, renderQuery(selection, now).text));
}
