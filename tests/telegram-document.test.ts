import { describe, expect, it, vi } from 'vitest';
import { TelegramClient, TelegramError } from '../src/telegram';

const TOKEN = 'telegram-test-token-not-real';

function documentForm(): FormData {
  const form = new FormData();
  form.set('chat_id', '-101');
  form.set('document', new Blob(['%PDF-1.4\nsynthetic\n%%EOF'], { type: 'application/pdf' }), 'اسماء-الطلاب.pdf');
  form.set('reply_parameters', JSON.stringify({ message_id: 17, allow_sending_without_reply: true }));
  return form;
}

describe('Telegram document transport', () => {
  it('round-trips a multipart PDF and Arabic filename with the runtime-generated boundary', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url).endsWith('/sendDocument')).toBe(true);
      expect(init?.redirect).toBe('manual');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const request = new Request(url, init);
      expect(request.headers.get('Content-Type')).toMatch(/^multipart\/form-data; boundary=/);
      const form = await request.formData();
      expect(form.get('chat_id')).toBe('-101');
      expect(JSON.parse(String(form.get('reply_parameters')))).toEqual({ message_id: 17, allow_sending_without_reply: true });
      const document = form.get('document') as File;
      expect(document.name).toBe('اسماء-الطلاب.pdf');
      expect(document.type).toBe('application/pdf');
      expect(await document.text()).toBe('%PDF-1.4\nsynthetic\n%%EOF');
      return Response.json({ ok: true, result: { message_id: 18 } });
    });
    expect(await new TelegramClient(TOKEN, fetcher).call('sendDocument', documentForm())).toEqual({ message_id: 18 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('preserves ordinary JSON messages alongside document uploads', async () => {
    const payload = { chat_id: 101, text: 'جدول اليوم' };
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const request = new Request(url, init);
      expect(request.headers.get('Content-Type')).toBe('application/json');
      expect(await request.json()).toEqual({...payload,reply_markup:{remove_keyboard:true}});
      return Response.json({ ok: true, result: true });
    });
    await new TelegramClient(TOKEN, fetcher).call('sendMessage', payload);
  });

  it('preserves rate-limit retries without exposing Telegram error details', async () => {
    const client = new TelegramClient(TOKEN, async () => Response.json({
      ok: false, error_code: 429, description: TOKEN, parameters: { retry_after: 9 },
    }, { status: 429 }));
    const error = await client.call('sendDocument', documentForm()).catch(value => value);
    expect(error).toBeInstanceOf(TelegramError);
    expect(error).toMatchObject({ code: 429, retryable: true, retryAfter: 9 });
    expect(String(error)).not.toContain(TOKEN);
  });
});
