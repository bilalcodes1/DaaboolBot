# دعبول — Daabool 🤖

An Iraqi Arabic Telegram assistant for third-year Computer Science students at the University of Anbar. It helps with class schedules, academic announcements, and enabled daily updates.

**Telegram:** [@daaboolbot](https://t.me/daaboolbot) · **المطوّر:** بلال زامل أحمد · [الموقع](https://bilalzamilahmed.page/) · [GitHub](https://github.com/bilalcodes1)

## شنو يسوي؟

- يجاوب عن جدول الأسبوع، محاضرات باچر، المواد والمدرّسين وفق الجدول المعتمد.
- يستقبل التبليغات الدراسية بلغة طبيعية، ويعرضها أو يعدّلها ويحذف التكرار مع إبقاء صلاحيات الإدارة مرتبطة بحسابات تيليگرام الموثّقة.
- يرد بالمحادثة بالعراقي في الخاص وبالمنشن داخل المجموعة.
- يدير التذكيرات والفقرات اليومية المفعّلة، ومنها الطقس والمواقيت والمحتوى التثقيفي.
- يستخدم الذكاء الاصطناعي اختيارياً لفهم الكلام، مع بقاء البيانات الأكاديمية والصلاحيات ضمن منطق التطبيق.

## التقنيات

TypeScript · Cloudflare Workers · Cloudflare D1 · Telegram Bot API · Webhooks · Groq (اختياري)

يستخدم المجدول توقيت `Asia/Baghdad`. تعتمد المواعيد والمواد على جدول الدفعة المعتمد، وتبقى مفاتيح الخدمات خارج المستودع.

## تشغيل محلي

يتطلب Node.js 24 أو أحدث وnpm.

```sh
npm ci
npm run demo:local
```

للتطوير مع Worker محلي، انسخ `.dev.vars.example` إلى `.dev.vars` وأضف مفاتيحك المحلية هناك، ثم شغّل:

```sh
npm run dev
```

لا ترفع `.dev.vars` أو ملفات `.env` أو مخرجات النشر والتقييم إلى GitHub. إعداد Cloudflare، أسرار Worker، وتهيئة D1 موضّحة في ملفات `docs/`.

## Public-source note

This public repository is a reusable codebase. The private class roster/PDF, Telegram account and destination identifiers, and production D1 identifier are deliberately omitted. Configure your own owner, destinations, D1 database, secrets, and private roster source before deployment.

## فحوص المشروع

```sh
npm run typecheck
npm test
npm run build
```

## روابط

- [دعبول على تيليگرام](https://t.me/daaboolbot)
- [موقع المطوّر](https://bilalzamilahmed.page/)
- [Instagram](https://www.instagram.com/bilalcodes1)
- [YouTube](https://www.youtube.com/@bilalcodes1)
- [LinkedIn](https://www.linkedin.com/in/bilal-zamil-ahmed-33a289374/)
- [GitHub](https://github.com/bilalcodes1)
