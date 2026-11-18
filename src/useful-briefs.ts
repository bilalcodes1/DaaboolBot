import { generateAssistantJson, type AssistantAiEnv } from './assistant-ai';
import { briefSlots, type BriefSlot, type DevicePlatform } from './brief-schedule';
import { DEVICE_PROMPT, TOOLS_PROMPT, renderAiTools, renderDeviceTip, type BriefDraft, type BriefReference } from './brief-content';
import { AI_PUBLISHERS, discoverFreeAiRelease, confirmFreeAiTool, discoverDeviceReleases, checkDeviceRelease, checkDeviceGuide, officialUrl,
  type OfficialRelease, type DeviceEvidence, type DeviceSourceCheck, type FreeRelease, type ToolEvidence } from './brief-sources';
import { getBaghdadNow } from './calendar';
import { getAutomationConfig, queueControlledJob, type ControlledHandler } from './controlled-scheduler';
import { EventStore } from './event-store';
import { loadRamadiMorning, renderRamadiMorning, weatherActions, hazardousWeather, RAMADI_FORECAST } from './weather-brief';

const DAY = 86_400_000;
export const BRIEF_JOB = 'controlled_useful_brief';
interface BriefPayload extends BriefDraft {
  key: BriefSlot['key'];
  date: string;
  generation: number;
  version: 1;
}

function briefAi(env: AssistantAiEnv, prompt: string, evidence: unknown, requestKey: string, maxTokens: number, fetcher: typeof fetch) {
  const { GEMINI_API_KEY: _otherProvider, ...groq } = env;
  return generateAssistantJson(groq, [
    { role: 'system', content: prompt },
    { role: 'user', content: JSON.stringify(evidence) },
  ], requestKey, { maxTokens, conversational: false }, fetcher);
}

async function claim(db: D1Database, id: string, kind: string, now: number): Promise<boolean> {
  const admitted = await db.prepare("INSERT OR IGNORE INTO controlled_preparations(id,kind,state,started_at) VALUES(?,?,'running',?)")
    .bind(id, kind, now).run();
  return !!admitted.meta.changes;
}
async function finish(db: D1Database, id: string, now: number, saved: number, reason: string, result?: unknown) {
  await db.prepare('UPDATE controlled_preparations SET state=?,finished_at=?,saved=?,reason=?,result_json=? WHERE id=?')
    .bind(reason === 'preparation_failed' ? 'failed' : 'complete', now, saved, reason, result === undefined ? null : JSON.stringify(result), id).run();
}
async function previousKeys(db: D1Database, now: number): Promise<Set<string>> {
  const recent = await db.prepare(`SELECT DISTINCT json_extract(r.value,'$.key') AS key FROM outbox o
    JOIN json_each(CASE WHEN json_valid(o.payload_json) THEN o.payload_json ELSE '{}' END, '$.references') r
    WHERE o.type=? AND o.due_at>? AND r.type='object'
      AND (o.state IN ('pending','sending','sent') OR EXISTS (
        SELECT 1 FROM controlled_attempts a WHERE a.job_id=o.id AND a.state IN ('confirmed','requesting','unknown')
      ))`).bind(BRIEF_JOB, now - 60 * DAY).all<{ key: string }>();
  return new Set(recent.results.map(row => row.key));
}
function parseTool(value: string | null): ToolEvidence[] {
  if (!value) return [];
  try {
    const item = JSON.parse(value) as ToolEvidence | null;
    return item && typeof item.key === 'string'
      && typeof item.url === 'string' && !!officialUrl(item.url) && typeof item.freeUrl === 'string' && !!officialUrl(item.freeUrl)
      && typeof item.evidence === 'string' && typeof item.freeProof === 'string' && typeof item.accessProof === 'string'
      && typeof item.product === 'string' && Number.isFinite(item.publishedAt) ? [item] : [];
  } catch { return []; }
}
async function weatherDraft(env: AssistantAiEnv, id: string, now: number, fetcher: typeof fetch): Promise<BriefDraft | null> {
  const weather = await loadRamadiMorning(now, fetcher);
  if (!weather) return null;
  const actions = weatherActions(weather);
  let suggested: unknown;
  try {
    if (!hazardousWeather(weather)) suggested = await briefAi(env,
      'Return JSON {actions:[allowed advice IDs],advice:one or two short Iraqi Anbari sentences}. Speak naturally like a student advising friends. Use only observed weather and permitted actions, consider restDay (no assumption of classes), laterTemperature/humidity/wind/visibility if provided. Missing data is unknown. No weather numbers, forecasts not supplied, disease claims, attribution, URLs or mandatory jokes. Advice only. Avoid invented fog/dust/rain/snow.',
      { weather, restDay: [5,6].includes(getBaghdadNow(new Date(now)).weekday), allowed: actions, meanings: { umbrella: 'rain protection', warm: 'warm clothes', water: 'water in heat', wind: 'secure light belongings', mild: 'comfortable clothes' } },
      id, 240, fetcher);
  } catch { /* The forecast still ships with local advice. */ }
  return { text: renderRamadiMorning(weather, suggested), references: [{
    key: 'ramadi:' + weather.date, publishedAt: Date.parse(weather.time + ':00+03:00'), releaseUrl: RAMADI_FORECAST,
  }] };
}
interface PreparationRow { id: string; state: string; started_at: number; result_json: string | null }
function stageResult<T>(row: PreparationRow | undefined): T | null {
  if (row?.state !== 'complete' || !row.result_json) return null;
  try { return JSON.parse(row.result_json) as T; } catch { return null; }
}
async function runSourceStage(db: D1Database, key: string, kind: string, now: number, task: () => Promise<unknown>): Promise<boolean> {
  if (!await claim(db, key, kind, now)) return false;
  try {
    const result = await task();
    const saved = Array.isArray(result) ? result.length : Number(result != null);
    await finish(db, key, now, saved, saved ? 'verified_sources' : 'no_verified_sources', result);
  } catch { await finish(db, key, now, 0, 'preparation_failed'); }
  return true;
}
async function prepareDeviceEvidence(db: D1Database, platform: DevicePlatform, id: string, now: number, fetcher: typeof fetch)
  : Promise<{ wait: true; worked: boolean } | { wait: false; tip: DeviceEvidence | null }> {
  const rows = await db.prepare('SELECT id,state,started_at,result_json FROM controlled_preparations WHERE id GLOB ?')
    .bind(id + ':device:*').all<PreparationRow>();
  const stages = new Map(rows.results.map(row => [row.id, row]));
  const prefix = id + ':device:';
  const run = async (key: string, task: () => Promise<unknown>): Promise<{ wait: true; worked: boolean }> =>
    ({ wait: true, worked: await runSourceStage(db, key, 'brief_device_source', now, task) });
  const busy = (row: PreparationRow | undefined) => row?.state === 'running' && row.started_at > now - 120_000;
  const feedKey = prefix + 'feed';
  if (!stages.has(feedKey)) return run(feedKey, async () => {
    const seen = await previousKeys(db, now);
    return (await discoverDeviceReleases(platform, now, fetcher)).filter(item => !seen.has(item.key));
  });
  const feed = stages.get(feedKey);
  if (busy(feed)) return { wait: true, worked: false };
  const releases = stageResult<OfficialRelease[]>(feed) ?? [];
  for (const [i, release] of releases.entries()) {
    const key = prefix + i;
    if (!stages.has(key)) return run(key, () => checkDeviceRelease(platform, release, now, fetcher));
    const checked = stages.get(key);
    if (busy(checked)) return { wait: true, worked: false };
    let result = stageResult<DeviceSourceCheck>(checked);
    for (let guide = 0; guide < 2 && result?.type === 'guide'; guide++) {
      const guideKey = key + ':guide:' + guide;
      if (!stages.has(guideKey)) {
        const { release: original, url } = result;
        return run(guideKey, () => checkDeviceGuide(platform, original, url, fetcher));
      }
      const row = stages.get(guideKey);
      if (busy(row)) return { wait: true, worked: false };
      result = stageResult<DeviceSourceCheck>(row);
    }
    if (result?.type === 'verified') return { wait: false, tip: result.tip };
  }
  return { wait: false, tip: null };
}
async function deviceDraft(env: AssistantAiEnv, platform: DevicePlatform, tip: DeviceEvidence, id: string, fetcher: typeof fetch) {
  const { evidence, guide, requirement } = tip;
  const input = [{ index: 0, platform, evidence, guide, requirement }];
  return renderDeviceTip(platform, [tip], await briefAi(env, DEVICE_PROMPT, input, id, 650, fetcher));
}
async function prepareAiEvidence(db: D1Database, id: string, now: number, fetcher: typeof fetch): Promise<boolean> {
  const keys = AI_PUBLISHERS.flatMap(p => [id + ':' + p.id, id + ':' + p.id + ':plan']);
  const rows = await db.prepare(`SELECT id,state,started_at,result_json FROM controlled_preparations WHERE id IN (${keys.map(() => '?').join(',')})`)
    .bind(...keys).all<PreparationRow>();
  const stages = new Map(rows.results.map(row => [row.id, row]));
  for (const provider of AI_PUBLISHERS) {
    const releaseId = id + ':' + provider.id, planId = releaseId + ':plan';
    const release = stageResult<FreeRelease>(stages.get(releaseId));
    if (release && !stages.has(planId)) {
      return runSourceStage(db, planId, 'brief_publisher_plan', now, () => confirmFreeAiTool(provider, release, fetcher));
    }
  }
  for (const provider of AI_PUBLISHERS) {
    const key = id + ':' + provider.id;
    if (!stages.has(key)) return runSourceStage(db, key, 'brief_publisher_release', now, () => discoverFreeAiRelease(provider, now, fetcher));
  }
  return false;
}
async function toolsDraft(env: AssistantAiEnv, db: D1Database, id: string, now: number, fetcher: typeof fetch): Promise<BriefDraft | null> {
  const rows = await db.prepare(`SELECT result_json FROM controlled_preparations
    WHERE id IN (${AI_PUBLISHERS.map(() => '?').join(',')}) AND state='complete'`)
    .bind(...AI_PUBLISHERS.map(provider => id + ':' + provider.id + ':plan')).all<{ result_json: string | null }>();
  const seen = await previousKeys(db, now);
  const candidates = rows.results.flatMap(row => parseTool(row.result_json))
    .filter(item => !seen.has(item.key) && item.publishedAt <= now && item.publishedAt >= now - 7 * DAY)
    .sort((a, b) => b.publishedAt - a.publishedAt).slice(0, 3);
  if (!candidates.length) return null;
  const input = candidates.map(({ product, evidence }, index) => ({ index, product, evidence }));
  return renderAiTools(candidates, await briefAi(env, TOOLS_PROMPT, input, id, 750, fetcher));
}

function validReferences(slot: BriefSlot, refs: BriefReference[], now: number): boolean {
  if (refs.length < 1 || refs.length > (slot.key === 'ai_tools' ? 3 : 1)) return false;
  if (refs.some(ref => !ref || typeof ref.key !== 'string' || typeof ref.releaseUrl !== 'string' || !Number.isFinite(ref.publishedAt))) return false;
  if (slot.key === 'weather') {
    const ref = refs[0]!;
    return ref.key === 'ramadi:' + slot.date && ref.releaseUrl === RAMADI_FORECAST
      && ref.publishedAt >= slot.prepareAt - 45 * 60_000 && ref.publishedAt <= slot.dueAt + 15 * 60_000;
  }
  const maxAge = (slot.key === 'ai_tools' ? 7 : 30) * DAY;
  return new Set(refs.map(ref => ref.key)).size === refs.length && refs.every(ref => {
    const proof = slot.key === 'ai_tools' ? ref.freeUrl : ref.guideUrl;
    return ref.publishedAt <= now && ref.publishedAt >= now - maxAge
      && !!officialUrl(ref.releaseUrl) && typeof proof === 'string' && !!officialUrl(proof);
  });
}

/** One bounded source preparation or final assembly per spare scheduler tick. */
export async function prepareUsefulBrief(db: D1Database, env: AssistantAiEnv, now: number, fetcher: typeof fetch): Promise<boolean> {
  const slot = briefSlots(getBaghdadNow(new Date(now))).find(item => now >= item.prepareAt && now < item.dueAt);
  if (!slot) return false;
  const config = await getAutomationConfig(db, slot.key);
  if (!config.enabled) return false;
  const settings = await new EventStore(db).getSettings();
  if (settings.targetChatId === null || settings.targetChatId >= 0) return false;
  const id = 'brief:' + slot.key + ':' + slot.date + ':' + config.generation;
  let device: DeviceEvidence | null = null;
  if (slot.platform) {
    const prepared = await prepareDeviceEvidence(db, slot.platform, id, now, fetcher);
    if (prepared.wait) return prepared.worked;
    device = prepared.tip;
  }
  if (slot.key === 'ai_tools' && now < slot.dueAt - 2 * 60_000) return prepareAiEvidence(db, id, now, fetcher);
  if (!await claim(db, id, slot.key, now)) return false;
  try {
    let draft: BriefDraft | null = null;
    if (slot.key === 'weather') draft = await weatherDraft(env, id, now, fetcher);
    else if (slot.key === 'ai_tools') draft = await toolsDraft(env, db, id, now, fetcher);
    else if (slot.platform && device) draft = await deviceDraft(env, slot.platform, device, id, fetcher);
    const payload: BriefPayload | null = draft ? { ...draft, key: slot.key, date: slot.date, generation: config.generation, version: 1 } : null;
    const queued = payload && await queueControlledJob(db, {
      id: 'controlled:brief:' + slot.key + ':' + slot.date, type: BRIEF_JOB, payload,
      dueAt: slot.dueAt, expiresAt: slot.expiresAt, chatId: settings.targetChatId, threadId: settings.targetThreadId,
      family: 'brief', config: { key: slot.key, generation: config.generation },
    }, now);
    await finish(db, id, now, Number(!!queued), queued ? 'queued' : payload ? 'slot_already_used' : 'no_verified_content');
  } catch { await finish(db, id, now, 0, 'preparation_failed'); }
  return true;
}

export const usefulBriefHandler: ControlledHandler = {
  types: [BRIEF_JOB],
  async resolve(db, job, now) {
    const body = job.payload as BriefPayload | null;
    const clock = getBaghdadNow(new Date(now));
    if (body?.version !== 1 || body.date !== clock.date || typeof body.text !== 'string'
      || body.text.length < 20 || body.text.length > 3500 || !Number.isSafeInteger(body.generation) || !Array.isArray(body.references)) return null;
    const slot = briefSlots(clock).find(item => item.key === body.key);
    if (!slot || now < slot.dueAt || now >= slot.expiresAt || !validReferences(slot, body.references, now)) return null;
    const settings = await new EventStore(db).getSettings();
    if (settings.targetChatId === null) return null;
    return {
      chatId: settings.targetChatId, method: 'sendMessage', family: 'brief', expiresAt: slot.expiresAt,
      config: { key: body.key, generation: body.generation },
      payload: { chat_id: settings.targetChatId, ...(settings.targetThreadId === null ? {} : { message_thread_id: settings.targetThreadId }),
        text: body.text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
    };
  },
};
