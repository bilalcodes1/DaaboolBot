import { readFile } from 'node:fs/promises';
import { URL as NodeURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { assistantStorageReady, claimAssistantTurn, releaseAssistantTurn, reserveAssistantTurnUser, type AssistantTurn } from '../src/assistant-store';

describe('assistant admission with actual D1 batch semantics',()=>{
  it('keeps changes() and durable admission atomic across a real D1 batch and replay',async()=>{
    const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-10-13',
      script:'export default { fetch() { return new Response("local test"); } };',d1Databases:{DB:'assistant-admission-runtime-test'}}));
    try {
      const db=await mf.getD1Database('DB') as unknown as D1Database;
      for(const name of ['0007_assistant_conversations.sql','0009_assistant_turn_admission.sql','0011_assistant_diagnostics.sql']) {
        const source=await readFile(new NodeURL(`../migrations/${name}`,import.meta.url),'utf8');
        for(const sql of source.split(';').map(value=>value.trim()).filter(Boolean)) await db.prepare(sql).run();
      }
      // The readiness query's pragma_table_info() is supported by real D1 too;
      // this fixture intentionally contains only the conversation tables.
      expect(await assistantStorageReady(db)).toBe(false);
      const now=Date.parse('2026-10-24T10:00:00Z');
      const turn:AssistantTurn={id:'message:1',scope:'1:0:1',userId:1,chatId:1,threadId:null,messageId:1,question:'مرحبا',now};
      const claimed=await claimAssistantTurn(db,turn);
      expect(await reserveAssistantTurnUser(db,turn,claimed.token!)).toBe(true);
      await releaseAssistantTurn(db,turn.id,claimed.token!);
      const replay={...turn,now:now+1_000};const reclaimed=await claimAssistantTurn(db,replay);
      expect(reclaimed.userAdmitted).toBe(true);
      expect(await reserveAssistantTurnUser(db,replay,reclaimed.token!)).toBe(true);
      expect(await db.prepare('SELECT requests,minute_requests FROM assistant_user_limits').first()).toEqual({requests:1,minute_requests:1});
      await db.prepare('UPDATE assistant_user_limits SET requests=60').run();
      const next={...turn,id:'message:2',messageId:2};const nextClaim=await claimAssistantTurn(db,next);
      expect(await reserveAssistantTurnUser(db,next,nextClaim.token!)).toBe(false);
      expect((await db.prepare('SELECT user_admitted FROM assistant_turns WHERE id=?').bind(next.id).first<{user_admitted:number}>())?.user_admitted).toBe(0);
    } finally {await mf.dispose();}
  },30_000);
});
