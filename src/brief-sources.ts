import { readPublicSource } from './source-http';
import { arabicDigits } from './notification-format';
import type { DevicePlatform } from './brief-schedule';

const DAY = 86_400_000;
const HOSTS = [
  'blog.google', 'support.google.com', 'www.apple.com', 'support.apple.com',
  'blogs.windows.com', 'support.microsoft.com', 'learn.microsoft.com',
  'openai.com', 'help.openai.com', 'chatgpt.com', 'helpx.adobe.com', 'blog.adobe.com', 'news.adobe.com',
  'github.blog', 'docs.github.com', 'github.com',
];
const DEVICE_FEEDS: Record<DevicePlatform, string> = {
  android: 'https://blog.google/products-and-platforms/platforms/android/rss/',
  iphone: 'https://www.apple.com/newsroom/rss-feed.rss',
  windows: 'https://blogs.windows.com/windowsexperience/feed/',
};
const DEVICE_REFERENCES: Partial<Record<DevicePlatform, string>> = {
  iphone: 'https://support.apple.com/guide/iphone/whats-new-in-ios-iphfed2c4091/ios',
  windows: 'https://support.microsoft.com/en-us/windows/deployment/updates-lifecycle/inside-this-update',
};
const FEED_PREFIX_BYTES = 120_000;
const ARTICLE_MARKUP_CHARS = 90_000;
export const AI_PUBLISHERS = [
  { id: 'openai', name: 'ChatGPT', feed: 'https://openai.com/news/rss.xml', plan: 'https://chatgpt.com/pricing/' },
  { id: 'gemini', name: 'Gemini', feed: 'https://blog.google/products-and-platforms/products/gemini/rss/', plan: 'https://support.google.com/gemini/answer/16275805?hl=en' },
  { id: 'firefly', name: 'Adobe Firefly', feed: 'https://helpx.adobe.com/firefly/web/whats-new.html', plan: 'https://helpx.adobe.com/creative-cloud/apps/generative-ai/generative-credits-faq.html' },
  { id: 'copilot', name: 'GitHub Copilot', feed: 'https://github.blog/changelog/label/copilot/feed/', plan: 'https://docs.github.com/en/copilot/get-started/plans' },
] as const;
export type AiPublisher = (typeof AI_PUBLISHERS)[number];

export interface OfficialRelease {
  key: string;
  url: string;
  title: string;
  publishedAt: number;
  evidence: string;
}
export interface DeviceEvidence extends OfficialRelease {
  guideUrl: string;
  guide: string;
  requirement?: string;
}
export interface ToolEvidence extends OfficialRelease {
  product: string;
  freeUrl: string;
  freeProof: string;
  accessProof: string;
  allowance?: string;
}
export interface FreeRelease extends OfficialRelease { accessProof: string }

function allowedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && HOSTS.includes(url.hostname);
  } catch { return false; }
}
export function officialUrl(value: string, base?: string): string | null {
  try {
    const url = new URL(value, base);
    if (!allowedUrl(url.href)) return null;
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|trk$|linkId$|fbclid$)/iu.test(key)) url.searchParams.delete(key);
    }
    return url.href.length <= 600 ? url.href : null;
  } catch { return null; }
}
function onHost(value: string, hosts: readonly string[]): boolean {
  return allowedUrl(value) && hosts.includes(new URL(value).hostname);
}
function read(url: string, fetcher: typeof fetch, hosts: readonly string[], maxBytes = 850_000, prefix = false) {
  return readPublicSource(url, fetcher, { allowed: value => onHost(value, hosts), maxBytes, redirects: 2, prefix });
}
function decode(value: string): string {
  return value.replace(/&(amp|quot|apos|nbsp|lt|gt|rsquo|ldquo|rdquo|mdash|ndash);|&#(x[0-9a-f]+|\d+);/giu, (original, name?: string, code?: string) => {
    if (code) {
      const number = /^x/iu.test(code) ? parseInt(code.slice(1), 16) : Number(code);
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
    }
    const entities: Record<string, string> = { amp: '&', quot: '"', apos: "'", nbsp: ' ', lt: '<', gt: '>', rsquo: '’', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–' };
    return entities[name?.toLowerCase() ?? ''] ?? original;
  });
}
function plain(value: string): string {
  return decode(value.replace(/<!\[CDATA\[|\]\]>/gu, '').replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<(script|style|nav|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/giu, '')
    .replace(/<\/(?:p|div|li|ol|ul|h[1-6]|section|tr|dt|dd)>|<br\s*\/?>/giu, '\n').replace(/<[^>]*>/gu, ' '))
    .replace(/[^\S\n]+/gu, ' ').split(/\n+/u).map(line => line.trim()).filter(Boolean).join('\n');
}
function articleMarkup(value: string): string {
  const main = /<main\b[^>]*>/iu.exec(value);
  const start = main ? main.index + main[0].length : 0;
  const end = main ? value.indexOf('</main>', start) : -1;
  const content = value.slice(start, end === -1 ? undefined : end);
  const article = /<article\b[^>]*>/iu.exec(content);
  const bodyStart = article ? article.index + article[0].length : 0;
  const bodyEnd = article ? content.indexOf('</article>', bodyStart) : -1;
  return content.slice(bodyStart, Math.min(bodyStart + ARTICLE_MARKUP_CHARS, bodyEnd === -1 ? content.length : bodyEnd));
}
function tag(value: string, name: string): string {
  const pattern = '<' + name + '\\b[^>]*>([\\s\\S]*?)<\\/' + name + '>';
  return plain(new RegExp(pattern, 'iu').exec(value)?.[1] ?? '');
}
function publicationTime(value: string): number {
  if (!/\b20\d{2}\b/u.test(value) || value.length > 85) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const at = new Date(value + 'T00:00:00Z');
    return Number.isFinite(+at) && at.toISOString().startsWith(value) ? +at - 3 * 3_600_000 : NaN;
  }
  if (/^[A-Za-z]{3,9} \d{1,2}, 20\d{2}$/u.test(value)) return Date.parse(value + ' 00:00:00 GMT+0300');
  return Date.parse(value);
}
function recent(at: number, now: number, days: number): boolean {
  return Number.isFinite(at) && at <= now && at >= now - days * DAY;
}
function releaseKey(url: string): string {
  const stable = new URL(url);
  stable.search = '';
  stable.hash = '';
  return stable.href.replace(/\/$/u, '');
}
function feedReleases(xml: string, hosts: readonly string[], now: number, days: number, allowModifiedDate = false): OfficialRelease[] {
  const releases = new Map<string, OfficialRelease>();
  for (const entry of xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/giu)) {
    const [, kind, content] = entry;
    const body = content!;
    const date = tag(body, 'pubDate') || tag(body, 'published') || (allowModifiedDate && kind === 'entry' ? tag(body, 'updated') : '');
    const publishedAt = publicationTime(date);
    if (!recent(publishedAt, now, days)) continue;
    const url = officialUrl(tag(body, 'link') || tag(body, 'id'));
    const title = tag(body, 'title');
    if (!url || !onHost(url, hosts) || !title || title.length > 230) continue;
    const key = releaseKey(url);
    if (releases.has(key)) continue;
    const evidence = (tag(body, 'description') || tag(body, 'content') || tag(body, 'content:encoded')).slice(0, 1600);
    releases.set(key, { key, url, title, publishedAt, evidence });
    if (releases.size >= 24) break;
  }
  return [...releases.values()].sort((a, b) => b.publishedAt - a.publishedAt);
}
function articleTime(html: string): number {
  const prefix = html.slice(0, 180_000);
  const timestamp = /<(?:span|time)\b[^>]*class=["'][^"']*category-eyebrow__date[^"']*["'][^>]*>([^<]+)</iu.exec(prefix)?.[1]
    ?? /"(?:datePublished|publishedAt)"\s*:\s*"([^"]+)"/iu.exec(prefix)?.[1]
    ?? /<meta\b[^>]*property=["']article:published_time["'][^>]*content=["']([^"']+)["']/iu.exec(prefix)?.[1]
    ?? /<time\b(?=[^>]*itemprop=["']datePublished["'])[^>]*datetime=["']([^"']+)["']/iu.exec(prefix)?.[1];
  return publicationTime(plain(timestamp ?? ''));
}
const GENERIC_TIP_WORDS = new Set(['apple', 'iphone', 'android', 'windows', 'google', 'microsoft', 'with', 'more', 'from', 'your', 'this',
  'will', 'available', 'introduced', 'announces', 'improved', 'update', 'latest', 'regions', 'expands', 'learn', 'about', 'devices', 'users', 'gets']);
function topicWords(title: string): string[] {
  return [...new Set(title.toLowerCase().match(/[a-z]{4,}/gu) ?? [])].filter(word => !GENERIC_TIP_WORDS.has(word));
}
function instructions(value: string, title: string): string {
  const lines = value.split('\n'), topic = topicWords(title);
  const steps = lines.filter((line, i) => {
    if (line.length < 12 || line.length > 580 || /^press release\b/iu.test(line)) return false;
    if (!/(?:^|[.!?]\s|\bthen\s|,\s|\bto [^.!?]{1,45},\s)(?:open|go to|tap|click|select|choose|press (?!release)|turn on|turn off|swipe|type|search for|drag)\b/iu.test(line)
      && !/\b(?:you can|you'll need to|you need to)\s+(?:open|go to|tap|click|select|choose|turn on|swipe)\b/iu.test(line)) return false;
    const context = lines.slice(Math.max(0, i - 2), i + 3).join(' ').toLowerCase();
    return topic.some(word => context.includes(word));
  });
  return [...new Set(steps)].slice(0, 10).join('\n').slice(0, 2700);
}
function requirement(value: string): string | undefined {
  return value.split('\n').find(line => line.length >= 15 && line.length <= 320
    && /\b(?:requires?|available on|supported on|(?:is )?only available|or later|and later)\b/iu.test(line)
    && /\b(?:iOS|iPhone|Android|Windows|Pixel|Copilot\+|version|country|regions?)\b/iu.test(line));
}
function guideLink(value: string, platform: DevicePlatform): boolean {
  const u = new URL(value);
  if (platform === 'iphone') return u.hostname === 'support.apple.com' && /^\/guide\/iphone\//u.test(u.pathname);
  if (platform === 'android') return u.hostname === 'support.google.com' && /^\/(?:android|pixelphone|messages|contacts|phoneapp|googleplay|accessibility\/android)\/answer\//u.test(u.pathname);
  return u.hostname === 'support.microsoft.com' && /\/(?:windows|help|topic)\//u.test(u.pathname);
}
function guideLinks(markup: string, release: OfficialRelease, platform: DevicePlatform, base: string): string[] {
  const words = topicWords(release.title);
  const found = new Map<string, number>();
  for (const match of markup.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu)) {
    const url = officialUrl(decode(match[1]!), base);
    if (!url || !guideLink(url, platform)) continue;
    const label = plain(match[2]!).toLowerCase();
    const tokens = new Set(label.match(/[a-z]{4,}/gu) ?? []);
    const score = words.filter(word => tokens.has(word) || url.toLowerCase().includes(word)).length;
    if (score > 0) found.set(url, score);
  }
  return [...found].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([url]) => url);
}
const NEW_FEATURE = /\b(?:new|now|introduc\w+|launch\w+|releas\w+|updat\w+|improv\w+|expand\w+|adds?|availability)\b/iu;
const NOT_PUBLIC = /\b(?:coming soon|waitlist|private preview|early access only|available only to (?:insiders|testers)|available in beta only|insider preview|will be available|starts rolling out (?:next|later))\b/iu;
const DEVICE_RELEVANCE: Record<DevicePlatform, RegExp> = {
  android: /\b(?:Android|Pixel|Google Messages|Phone by Google)\b/iu,
  iphone: /\b(?:iPhone|iOS|Health app|Apple Intelligence)\b/iu,
  windows: /\bWindows(?: 1[01])?\b/iu,
};

export async function discoverDeviceReleases(platform: DevicePlatform, now: number, fetcher: typeof fetch): Promise<OfficialRelease[]> {
  const feed = DEVICE_FEEDS[platform], host = new URL(feed).hostname;
  const index = await read(feed, fetcher, [host], FEED_PREFIX_BYTES, true);
  if (!index) return [];
  return feedReleases(index, [host], now, 30, platform === 'iphone')
    .filter(item => DEVICE_RELEVANCE[platform].test(item.title + ' ' + item.evidence)
      && NEW_FEATURE.test(item.title + ' ' + item.evidence) && !NOT_PUBLIC.test(item.title)
      && !/\b(?:manufacturing program|earnings|partners for|corporate responsibility)\b/iu.test(item.title)).slice(0, 3);
}

export type DeviceSourceCheck =
  | { type: 'verified'; tip: DeviceEvidence }
  | { type: 'guide'; release: OfficialRelease; url: string };

export async function checkDeviceRelease(platform: DevicePlatform, item: OfficialRelease, now: number, fetcher: typeof fetch): Promise<DeviceSourceCheck | null> {
  const host = new URL(DEVICE_FEEDS[platform]).hostname;
  const html = await read(item.url, fetcher, [host]);
  if (!html) return null;
  const date = articleTime(html);
  // Apple Atom entries carry a modification time. The Newsroom article supplies the release date.
  const publishedAt = Number.isFinite(date) || platform === 'iphone' ? date : item.publishedAt;
  if (!recent(publishedAt, now, 30)) return null;
  const markup = articleMarkup(html), body = plain(markup);
  const evidence = [item.title, item.evidence, body.slice(0, 2000)].join('\n').slice(0, 3400);
  if (NOT_PUBLIC.test(item.evidence) || body.length < 65) return null;
  const release = { ...item, publishedAt, evidence };
  const guide = instructions(body, item.title), required = requirement(evidence);
  if (guide.length >= 40) return { type: 'verified', tip: { ...release, guideUrl: item.url, guide, ...(required ? { requirement: required } : {}) } };
  const url = guideLinks(markup, item, platform, item.url)[0] ?? DEVICE_REFERENCES[platform];
  return url ? { type: 'guide', release, url } : null;
}

export async function checkDeviceGuide(platform: DevicePlatform, item: OfficialRelease, url: string, fetcher: typeof fetch): Promise<DeviceSourceCheck | null> {
  if (!guideLink(url, platform)) return null;
  const html = await read(url, fetcher, [new URL(url).hostname], 1_800_000);
  if (!html) return null;
  const markup = articleMarkup(html), text = plain(markup);
  const guide = instructions(text, item.title);
  if (guide.length >= 40) {
    const required = requirement(item.evidence) ?? requirement(text);
    return { type: 'verified', tip: { ...item, guideUrl: url, guide, ...(required ? { requirement: required } : {}) } };
  }
  if (url !== DEVICE_REFERENCES[platform]) return null;
  const linked = guideLinks(markup, item, platform, url)[0];
  return linked && linked !== url ? { type: 'guide', release: item, url: linked } : null;
}

const PAID_OR_TEMPORARY = /\b(?:free trial|trial period|limited[- ]time|introductory offer|coming soon|waitlist|private preview|paid only|only (?:for|to) (?:paid|premium|pro|plus|enterprise|business)|not (?:yet )?(?:available|included) (?:to|on|for) (?:the )?free|(?:until|through) (?:January|February|March|April|May|June|July|August|September|October|November|December|\d)|first \d+ (?:days?|weeks?|months?) free)\b/iu;
const FREE_TIER = /\b(?:free(?:-tier)?\s+(?:users?|plan|tier|accounts?|access|generations)|(?:on|in|with)\s+(?:the\s+)?free\b|without a (?:paid|google ai)\s+plan|copilot free|at no cost)\b/iu;
const FREE_ACCESS = /\b(?:(?:available|included|accessible|released|launched|enabled)\s+(?:now\s+)?(?:to|for|on|in|with|at)\s+[^.!?\n]{0,82}(?:free(?:-tier)?\s+(?:users?|plan|tier|accounts?)|users? on free\b|copilot free|no cost)|(?:free(?:-tier)?\s+(?:users?|accounts?)|copilot free users?)\s+(?:(?:now|already)\s+)?(?:can|have access|receive|get)\b|(?:everyone|all users),?\s+including\s+(?:the\s+)?free\b)/iu;
const PROVIDER_RELEVANCE: Record<AiPublisher['id'], RegExp> = {
  openai: /\bChatGPT\b/iu,
  gemini: /\bGemini\b/iu,
  firefly: /\bFirefly\b/iu,
  copilot: /\bCopilot\b/iu,
};
const NOT_GENERAL_FREE = /\b(?:waitlist|rolling out|starts? rolling|will (?:be available|roll out|come to)|preview only|in beta|research preview|invitation only|verified U\.S\.|US only|U\.S\. only)\b/iu;
const PAST_OR_NEGATED_FREE = /\b(?:previously|formerly|no longer|not yet|not available|never available|except free|excluding free|free users (?:cannot|can't|won't|do not)|(?:was|were) available)\b/iu;
const GENERIC_RELEASE_WORDS = new Set(['chatgpt', 'gemini', 'github', 'copilot', 'adobe', 'firefly', 'free', 'launch', 'introducing',
  'available', 'feature', 'features', 'release', 'update', 'users', 'with', 'your', 'from', 'this', 'tools']);
function namesFeature(title: string, evidence: string): boolean {
  const titleWords = (title.toLowerCase().match(/[a-z][a-z0-9-]{3,}/gu) ?? []).filter(word => !GENERIC_RELEASE_WORDS.has(word));
  const words = new Set(evidence.toLowerCase().match(/[a-z][a-z0-9-]{3,}/gu) ?? []);
  return titleWords.some(word => words.has(word));
}

function proofLines(text: string, predicate: (value: string) => boolean): string | null {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  for (const [i, line] of lines.entries()) {
    // Check adjacent fragments because plans often put the tier name and allowance in separate HTML elements.
    for (const value of [line, lines.slice(i, i + 3).join(' ')]) {
      if (value.length < 15 || value.length > 700 || PAID_OR_TEMPORARY.test(value) || NOT_GENERAL_FREE.test(value)) continue;
      if (predicate(value)) return value;
    }
  }
  return null;
}
function freePlanProof(body: string, release: FreeRelease): string | null {
  const valid = (line: string) => FREE_TIER.test(line) && !PAST_OR_NEGATED_FREE.test(line) && !/\btrial\b/iu.test(line)
    && /\b(?:access|include\w*|limited|daily|monthly|limit\w*|completions?|use|generation\w*|available|without a .* plan)\b/iu.test(line);
  return proofLines(body, line => valid(line) && !!freeAllowance('', line, release.evidence))
    ?? proofLines(body, valid)
    ?? /\bFree\s+\$0(?:\s*\/\s*(?:mo(?:nth)?|month))?(?:\s|$)/iu.exec(body)?.[0]?.trim()
    ?? null;
}
function freeAllowance(release: string, plan: string, use: string): string | undefined {
  const units: Record<string, string> = {
    generations: 'توليد', images: 'صورة', messages: 'رسالة', prompts: 'طلب', requests: 'طلب',
    completions: 'إكمال كود', credits: 'رصيد', uses: 'استخدام',
  };
  for (const proof of [release, plan]) {
    const m = /(?:\bup to\s+|\blimited to\s+|\bget\s+|\breceive\s+|^|\s)(\d{1,3}(?:,\d{3})+|\d{1,5})\s+(generations|images|messages|prompts|requests|completions|credits|uses)(?:[^.!?\d]{0,55}?)\b(?:per|each|a)\s+(day|week|month)\b/iu.exec(proof);
    if (!m || !FREE_TIER.test(proof)) continue;
    const kind = m[2]!.toLowerCase();
    // A limit from a different feature or unit (e.g. text messages versus image generation) is not interchangeable.
    if (proof === plan && !new RegExp('\\b' + kind.slice(0, -1) + 's?\\b', 'iu').test(use)) continue;
    const period = { day: 'باليوم', week: 'بالأسبوع', month: 'بالشهر' }[m[3]!.toLowerCase()];
    return arabicDigits(m[1]!.replace(/,/gu, '٬')) + ' ' + units[kind] + ' ' + period;
  }
  return undefined;
}
function fireflyReleases(html: string, feed: string, now: number): OfficialRelease[] {
  const results: OfficialRelease[] = [];
  const markup = articleMarkup(html);
  for (const section of markup.matchAll(/<(h[234])\b[^>]*>([\s\S]*?)<\/\1>([\s\S]*?)(?=<h[234]\b|$)/giu)) {
    const title = plain(section[2]!), body = plain(section[3]!);
    const date = /\b(?:released|launched|available(?:\s+since)?)\s*(?:on\s+)?((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+20\d{2}|\d{4}-\d{2}-\d{2})\b/iu.exec(title + '\n' + body)?.[1];
    if (!date) continue;
    const publishedAt = publicationTime(date);
    if (!recent(publishedAt, now, 7) || title.length < 6 || title.length > 230) continue;
    results.push({ key: releaseKey(feed) + '#' + title.toLowerCase().replace(/[^a-z0-9]+/gu, '-'), url: feed, title, publishedAt, evidence: body.slice(0, 3200) });
    if (results.length >= 4) break;
  }
  return results;
}

function publicFreeRelease(item: OfficialRelease, body = ''): FreeRelease | null {
  const access = proofLines(item.evidence + '\n' + body, line => FREE_ACCESS.test(line) && !NOT_PUBLIC.test(line)
    && !PAST_OR_NEGATED_FREE.test(line) && namesFeature(item.title, line));
  if (!access) return null;
  const evidence = [item.title, access, item.evidence, body.slice(0, 1000)].join('\n').slice(0, 3200);
  return { ...item, evidence, accessProof: access };
}

export async function discoverFreeAiRelease(publisher: AiPublisher, now: number, fetcher: typeof fetch): Promise<FreeRelease | null> {
  const host = new URL(publisher.feed).hostname;
  const index = publisher.id === 'firefly' ? await read(publisher.feed, fetcher, [host])
    : await read(publisher.feed, fetcher, [host], FEED_PREFIX_BYTES, true);
  if (!index) return null;
  const releases = (publisher.id === 'firefly' && !/<(?:item|entry)\b/iu.test(index)
    ? fireflyReleases(index, publisher.feed, now)
    : feedReleases(index, [host], now, 7))
    .filter(item => (publisher.id === 'firefly' || PROVIDER_RELEVANCE[publisher.id].test(item.title + ' ' + item.evidence))
      && NEW_FEATURE.test(item.title + ' ' + item.evidence)
      && !PAID_OR_TEMPORARY.test(item.title) && !NOT_GENERAL_FREE.test(item.title))
    .slice(0, 3);
  // Rank a feed entry with free access evidence ahead of a teaser. Open at most one release page per tick.
  const item = releases.find(item => publicFreeRelease(item)) ?? releases[0];
  if (!item) return null;
  if (item.url === publisher.feed) return publicFreeRelease(item);
  const article = await read(item.url, fetcher, [host]);
  if (!article) return null;
  const date = articleTime(article);
  const publishedAt = Number.isFinite(date) ? date : item.publishedAt;
  if (!recent(publishedAt, now, 7)) return null;
  const body = plain(articleMarkup(article)).slice(0, 14_000);
  const contrary = body.split('\n').some(line => (PAID_OR_TEMPORARY.test(line) || NOT_GENERAL_FREE.test(line) || PAST_OR_NEGATED_FREE.test(line))
    && namesFeature(item.title, line));
  return contrary ? null : publicFreeRelease({ ...item, publishedAt }, body);
}

export async function confirmFreeAiTool(publisher: AiPublisher, release: FreeRelease, fetcher: typeof fetch): Promise<ToolEvidence | null> {
  const page = await read(publisher.plan, fetcher, [new URL(publisher.plan).hostname], 1_850_000);
  if (!page) return null;
  const plan = freePlanProof(plain(articleMarkup(page)).slice(0, 28_000), release);
  if (!plan) return null;
  const allowance = freeAllowance(release.accessProof, plan, release.evidence);
  return { ...release, product: publisher.name, freeUrl: publisher.plan, freeProof: plan, ...(allowance ? { allowance } : {}) };
}
