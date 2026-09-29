import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import type { Server } from 'node:http';
import { Db } from '../src/db.ts';
import { createSession } from '../src/auth.ts';
import { createApp } from '../src/server.ts';
import * as c from '../src/compliance.ts';
let db: Db;
const time = Date.UTC(2026, 8, 29, 12) / 1000;
const policy = () => structuredClone(c.loadPolicy());
const body = (over = {}) => ({ kind: 'refund', message: 'Please review this purchase.', locale: 'en', idempotencyKey: '1234567890abcdef', ...over });
const age = (birthDate: string, over = {}) => ({ birthDate, acknowledged: true, policyRevision: policy().revision, ...over });
beforeEach(() => { db = new Db(':memory:'); });
afterEach(() => { db.close(); vi.unstubAllEnvs(); });

describe('self-declared age (never verified identity)', () => {
  for (const [dob, passed] of [['2008-09-29', 1], ['2008-09-30', 0], ['1900-01-01', 1]] as const) it(`exact UTC birthday ${dob}`, () => {
    c.declareAge(db, 'a', age(dob), 'CZ', policy(), time);
    const row = db.get<c.AgeRow>('SELECT * FROM age_declarations')!;
    expect(row.passed).toBe(passed); expect(JSON.stringify(row)).not.toContain(dob);
    expect(Object.keys(row).sort()).toEqual(['wallet','passed','minimum_age','policy_revision','declared_at','expires_at'].sort());
  });
  for (const dob of ['2000-02-30', '2001-02-29', '2027-01-01', '1899-12-31', '2008-9-29', '', 'garbage']) it(`rejects invalid birth date ${dob}`, () => expect(() => c.declareAge(db, 'a', age(dob), 'CZ', policy(), time)).toThrow());
  it('requires explicit acknowledgement and current version', () => {
    expect(() => c.declareAge(db,'a',age('2000-01-01',{acknowledged:false}),'CZ',policy(),time)).toThrow();
    expect(() => c.declareAge(db,'a',age('2000-01-01',{policyRevision:'old'}),'CZ',policy(),time)).toThrow();
  });
  it('does not let a denied wallet immediately retry as older', () => {
    c.declareAge(db,'a',age('2015-01-01'),'CZ',policy(),time);
    expect(() => c.declareAge(db,'a',age('1990-01-01'),'CZ',policy(),time+1)).toThrow(/cannot be overwritten/);
    expect(() => c.declareAge(db,'a',age('1990-01-01'),'CZ',policy(),time+31*86400)).not.toThrow();
  });
  it('handles leap-day maturity conservatively on March 1', () => {
    c.declareAge(db,'a',age('2008-02-29'),'CZ',policy(),Date.UTC(2026,1,28)/1000);
    c.declareAge(db,'b',age('2008-02-29'),'CZ',policy(),Date.UTC(2026,2,1)/1000);
    expect(db.scalar('SELECT passed FROM age_declarations WHERE wallet = ?', 'a')).toBe(0);
    expect(db.scalar('SELECT passed FROM age_declarations WHERE wallet = ?', 'b')).toBe(1);
  });
  it('expires declarations and requires renewal for a higher country threshold or policy version', () => {
    c.declareAge(db,'a',age('2000-01-01'),'CZ',policy(),time);
    const p=policy();p.countryMinimumAge.US=21;
    expect(c.accessState(db,'a','US',p,true,time).age).toBe('expired');
    expect(c.accessState(db,'a','CZ',p,true,time+366*86400).age).toBe('expired');
    p.revision='next';expect(c.accessState(db,'a','CZ',p,true,time).age).toBe('expired');
  });
});
describe('per-feature access', () => {
  it('fails closed for unknown and untrusted countries', () => {
    vi.stubEnv('GEO_TRUST_HEADER','0');expect(c.detectedCountry({'x-geo-country':'CZ'})).toBeNull();
    vi.stubEnv('GEO_TRUST_HEADER','1');expect(c.detectedCountry({'x-geo-country':'CZ'})).toBe('CZ');
    for (const value of ['XX','ZZ','EU','QO','UK','CZ,US','AA','T1']) expect(c.detectedCountry({'x-geo-country':value})).toBeNull();
    expect(c.accessState(db,'a',null,policy(),true,time).features.market.reason).toBe('country_unknown');
  });
  it('supports country allowlists and deny precedence without inventing legal clearance', () => {
    const p=policy();p.features.market={allow:['CZ'],deny:['CZ']};
    expect(c.accessState(db,'a','CZ',p,true,time).features.market.reason).toBe('region_restricted');
    expect(c.accessState(db,'a','US',p,true,time).features.market.reason).toBe('region_restricted');
    expect(c.accessState(db,'a','BE',p,true,time).features.packs.reason).toBe('region_restricted');
    expect(c.accessState(db,'a','CZ',policy(),true,time).features.services.reason).toBe('age_required');
  });
  it('does not guess malformed policy or enabled flags', () => {
    const p=policy();p.features.market.allow=['*'];expect(()=>c.validatePolicy(p)).toThrow();
    p.features.market.allow=[];expect(c.validatePolicy(p)).toBe(p);
    vi.stubEnv('COMPLIANCE_ENFORCE','wat');expect(()=>c.enforcementEnabled()).toThrow();
  });
  it('restricts new activities after an objection even if age/geo controls are off', () => {
    c.createRequest(db,'a',body({kind:'privacy_object'}),policy(),time);
    expect(c.accessState(db,'a','CZ',policy(),false,time).features.arena.reason).toBe('privacy_restricted');
  });
});
describe('rights ledger and retention', () => {
  it('idempotent retries return the same receipt and reject changed payload', () => {
    const a=c.createRequest(db,'a',body(),policy(),time);const b=c.createRequest(db,'a',body(),policy(),time);
    expect(a.id).toBe(b.id);expect(()=>c.createRequest(db,'a',body({message:'Changed'}),policy(),time)).toThrow(/Idempotency/);
    expect(c.createRequest(db,'b',body(),policy(),time).id).not.toBe(a.id);
  });
  it('bounds messages, locales, types and active cases', () => {
    for (const bad of [{message:''},{message:'x'.repeat(4001)},{kind:'payout'},{locale:'xx'},{signature:'invalid'}]) expect(()=>c.createRequest(db,'a',body(bad),policy(),time)).toThrow();
    for(let i=0;i<20;i++) c.createRequest(db,'a',body({idempotencyKey:'1234567890abcdef'+i}),policy(),time);
    expect(()=>c.createRequest(db,'a',body({idempotencyKey:'1234567890abcdefMORE'}),policy(),time)).toThrow(/existing open/);
  });
  it('returns 404 across wallets, protects versions and does not move money', () => {
    const a=c.createRequest(db,'a',body(),policy(),time);
    expect(()=>c.ownedRequest(db,'b',a.id)).toThrow(/not found/);
    const r=c.updateRequest(db,a.id,{version:1,status:'answered',message:'Received; no payout has been sent.'},'operator',undefined,time+1);
    expect(r.status).toBe('answered');expect(r.version).toBe(2);
    expect(()=>c.updateRequest(db,a.id,{version:1,status:'closed',message:'old'},'operator')).toThrow(/Refresh/);
    expect(db.scalar('SELECT COUNT(*) FROM service_payments')).toBe(0);
    const reply=c.updateRequest(db,a.id,{version:2,status:'closed',message:'More information'},'user','a',time+2);
    expect(reply.status).toBe('received'); // user cannot close/approve their own claim
  });
  it('uses one calendar month, not thirty days, for privacy response targets', () => {
    const t=Date.UTC(2027,0,31,12)/1000;
    const r=c.createRequest(db,'a',body({kind:'privacy_access'}),policy(),t);
    expect(new Date(r.due_at*1000).toISOString()).toBe('2027-02-28T12:00:00.000Z');
  });
  it('exports a labelled subset without sessions, CSRF, other wallets or raw DOB', () => {
    const s=createSession(db,'a');c.createRequest(db,'a',body(),policy(),time);c.createRequest(db,'b',body({message:'other-person-secret'}),policy(),time);
    c.declareAge(db,'a',age('1990-01-01'),'CZ',policy(),time);
    const out=JSON.stringify(c.exportData(db,'a'));
    for(const secret of [s.csrf,s.id,'other-person-secret','1990-01-01'])expect(out).not.toContain(secret);
    expect(out).toContain('self_service_subset');
  });
  it('erases only reviewed profile scope and reapplies tombstones after restore', () => {
    createSession(db,'a');db.run("UPDATE wallets SET handle='test_user', country='CZ' WHERE address='a'");
    const r=c.createRequest(db,'a',body({kind:'privacy_erase'}),policy(),time);
    expect(()=>c.eraseProfile(db,r.id,1,'Not reviewed',time)).toThrow();
    c.updateRequest(db,r.id,{version:1,status:'in_review',message:'Reviewing'},'operator',undefined,time);
    const out=c.eraseProfile(db,r.id,2,'Profile removed; other records require assessment.',time);
    expect(out.status).toBe('answered');expect(db.scalar("SELECT COUNT(*) FROM sessions WHERE wallet='a'")).toBe(0);
    expect(db.get("SELECT handle,country FROM wallets WHERE address='a'")).toMatchObject({handle:null,country:null});
    expect(db.scalar('SELECT COUNT(*) FROM rights_requests')).toBe(1);
    db.run("UPDATE wallets SET handle='restored_user' WHERE address='a'");expect(c.reapplyProfileErasures(db)).toBe(1);
    expect(db.get("SELECT handle FROM wallets WHERE address='a'")!.handle).toBeNull();
  });
  it('requires reviewed correction to reset age or resume processing, never grants verified age', () => {
    c.declareAge(db,'a',age('2015-01-01'),'CZ',policy(),time);
    c.createRequest(db,'a',body({kind:'privacy_restrict'}),policy(),time);
    const r=c.createRequest(db,'a',body({kind:'privacy_correct',idempotencyKey:'another1234567890'}),policy(),time);
    expect(()=>c.correctAccess(db,r.id,{version:1,resetAge:true,message:'test'},time)).toThrow();
    c.updateRequest(db,r.id,{version:1,status:'in_review',message:'Review'},'operator',undefined,time);
    c.correctAccess(db,r.id,{version:2,resetAge:true,resumeProcessing:true,message:'Reviewed user request'},time);
    expect(c.accessState(db,'a','CZ',policy(),true,time)).toMatchObject({age:'missing',restricted:false});
  });
  it('retention preserves open cases, holds and active restriction evidence', () => {
    const p=policy();p.closedRequestRetentionDays=1;
    const a=c.createRequest(db,'a',body(),p,time);c.updateRequest(db,a.id,{version:1,status:'closed',message:'done'},'operator',undefined,time);
    const b=c.createRequest(db,'b',body(),p,time);c.updateRequest(db,b.id,{version:1,status:'closed',message:'legal hold',holdUntil:time+10*86400},'operator',undefined,time);
    const d=c.createRequest(db,'d',body({kind:'privacy_restrict'}),p,time);c.updateRequest(db,d.id,{version:1,status:'closed',message:'restriction ongoing'},'operator',undefined,time);
    c.createRequest(db,'e',body(),p,time);
    expect(c.sweepRetention(db,p,time+2*86400).requests).toBe(1);
    expect(db.scalar('SELECT COUNT(*) FROM rights_requests')).toBe(3);
    expect(db.scalar('SELECT COUNT(*) FROM rights_messages WHERE request_id = ?',a.id)).toBe(0);
  });
});

describe('HTTP auth, CSRF, owner isolation and nonblocking exits', () => {
  let server: Server;let base: string;let a: ReturnType<typeof createSession>;let staff: ReturnType<typeof createSession>;
  beforeEach(async () => {
    vi.stubEnv('GEO_TRUST_HEADER','1');
    a=createSession(db,'wallet-a');staff=createSession(db,'staff');
    const app=createApp(db,{arenaSweepMs:0,accessLog:false,adminWallets:new Set(['staff']),complianceEnforce:true});
    await new Promise<void>(resolve=>{server=app.listen(0,'127.0.0.1',resolve)});base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  });
  afterEach(async()=>{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));});
  const call=async(method:string,path:string,body?:unknown,s?:ReturnType<typeof createSession>,headers:Record<string,string>={})=>{
    const r=await fetch(base+'/v1'+path,{method,headers:{'Content-Type':'application/json','x-geo-country':'CZ',...(s?{Cookie:`gc_session=${s.cookie}`,'X-CSRF-Token':s.csrf}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.status,body:await r.text()};
  };
  it('requires session, CSRF and explicit intended wallet on new submissions',async()=>{
    expect((await call('POST','/me/rights',body())).status).toBe(401);
    expect((await call('POST','/me/rights',{...body(),wallet:'wallet-a'},a,{'X-CSRF-Token':'bad'})).status).toBe(403);
    expect((await call('POST','/me/rights',{...body(),wallet:'other'},a)).status).toBe(403);
    expect((await call('POST','/me/rights',{...body(),wallet:'wallet-a'},a)).status).toBe(200);
  });
  it('blocks new pack quotes/arena entry but leaves leaving queue and rights accessible',async()=>{
    expect(JSON.parse((await call('POST','/packs/quote',{},a)).body).code).toBe('age_required');
    expect(JSON.parse((await call('POST','/arena/queue',{},a)).body).code).toBe('age_required');
    expect((await call('DELETE','/arena/queue',undefined,a)).status).toBe(204);
    expect((await call('POST','/me/rights',{...body(),wallet:'wallet-a'},a,{'x-geo-country':'BE'})).status).toBe(200);
  });
  it('allows declared eligible wallet, rechecks trusted geography and transaction wallet',async()=>{
    expect((await call('POST','/me/compliance/age',{...age('1990-01-01'),wallet:'wallet-a'},a)).status).toBe(200);
    expect((await call('POST','/me/compliance/check',{wallet:'wallet-a',feature:'market'},a)).status).toBe(200);
    expect((await call('POST','/me/compliance/check',{wallet:'other',feature:'market'},a)).status).toBe(403);
    expect(JSON.parse((await call('POST','/me/compliance/check',{wallet:'wallet-a',feature:'packs'},a,{'x-geo-country':'BE'})).body).code).toBe('region_restricted');
  });
  it('owner-scopes cases and rejects nonadmin answers; audit omits request text',async()=>{
    const r=JSON.parse((await call('POST','/me/rights',{...body(),wallet:'wallet-a'},a)).body);
    expect((await call('GET','/me/rights/'+r.id,undefined,staff)).status).toBe(404);
    expect((await call('GET','/admin/rights',undefined,a)).status).toBe(403);
    expect((await call('POST','/admin/rights/'+r.id,{version:1,status:'answered',message:'PRIVATE_OPERATOR_REPLY'},staff)).status).toBe(200);
    expect(JSON.stringify(db.all('SELECT * FROM admin_audit'))).not.toContain('PRIVATE_OPERATOR_REPLY');
    expect(JSON.parse((await call('GET','/me/rights/'+r.id,undefined,a)).body).messages[0].actor).toBe('operator');
  });
  it('requires recent sign-in to export, while keeping requests available',async()=>{
    db.run('UPDATE sessions SET created_at = ? WHERE id = ?',Math.floor(Date.now()/1000)-901,a.id);
    expect(JSON.parse((await call('POST','/me/rights/export',{wallet:'wallet-a'},a)).body).code).toBe('reauth_required');
    expect((await call('GET','/me/rights',undefined,a)).status).toBe(200);
  });
});

describe('temporary owner-selected age/geo-off defaults', () => {
  it.each(['production', 'development', 'test'])('%s does not enforce age/geography without an explicit override', environment => {
    vi.stubEnv('NODE_ENV', environment); vi.stubEnv('COMPLIANCE_ENFORCE', undefined);
    expect(c.enforcementEnabled()).toBe(false);
    vi.stubEnv('COMPLIANCE_ENFORCE', '1'); expect(c.enforcementEnabled()).toBe(true);
    vi.stubEnv('COMPLIANCE_ENFORCE', '0'); expect(c.enforcementEnabled()).toBe(false);
  });
  it('allows every feature with no declaration or a denied declaration, including BE/NL and unknown country', () => {
    vi.stubEnv('COMPLIANCE_ENFORCE', undefined);
    c.declareAge(db, 'denied-wallet', age('2015-01-01'), 'CZ', policy(), time);
    for (const country of ['BE', 'NL', 'CZ', null]) for (const wallet of ['no-declaration', 'denied-wallet']) {
      const state = c.accessState(db, wallet, country, policy(), c.enforcementEnabled(), time);
      for (const feature of c.FEATURES) expect(state.features[feature]).toEqual({ allowed: true, reason: null });
    }
    expect(db.scalar('SELECT COUNT(*) FROM age_declarations')).toBe(1); // switching enforcement off does not erase records
  });
});

describe('HTTP: unrestricted age/geo does not mean public accounts or admin access', () => {
  let server: Server; let base: string; let session: ReturnType<typeof createSession>;
  beforeEach(async () => {
    vi.stubEnv('COMPLIANCE_ENFORCE', undefined); vi.stubEnv('GEO_GATE', undefined);
    vi.stubEnv('GEO_TRUST_HEADER', '1');
    session = createSession(db, 'default-wallet');
    const app = createApp(db, { arenaSweepMs: 0, accessLog: false, adminWallets: new Set(['staff']), connection: () => ({} as never) });
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  });
  afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); });
  async function call(path: string, body?: unknown, overrides: Record<string, string> = {}) {
    const r = await fetch(base + '/v1' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Cookie: `gc_session=${session.cookie}`, 'X-CSRF-Token': session.csrf, ...overrides }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  }
  it('permits all feature checks and reaches pack validation rather than a geography/age refusal', async () => {
    for (const country of ['BE', 'NL', 'CZ', '']) for (const feature of c.FEATURES) {
      expect((await call('/me/compliance/check', { wallet: 'default-wallet', feature }, { 'x-geo-country': country })).status).toBe(200);
    }
    const state = await call('/me/compliance');
    expect(state.body.enabled).toBe(false); expect(state.body.age).toBe('missing');
    const quote = await call('/packs/quote', {}, { 'x-geo-country': 'BE' });
    expect(quote.status).toBe(400); // still validates purchase input; no RPC or payment
    expect(['geo_blocked', 'region_restricted', 'age_required']).not.toContain(quote.body.code);
  });
  it('still checks SIWS, CSRF, transaction wallet and admin role', async () => {
    const b = { wallet: 'default-wallet', feature: 'market' };
    expect((await call('/me/compliance/check', b, { Cookie: '' })).status).toBe(401);
    expect((await call('/me/compliance/check', b, { 'X-CSRF-Token': 'invalid' })).status).toBe(403);
    expect((await call('/me/compliance/check', { ...b, wallet: 'someone-else' })).status).toBe(403);
    expect((await call('/admin/rights')).status).toBe(403);
  });
  it('preserves privacy restrictions while requests remain available and private', async () => {
    const r = await call('/me/rights', { ...body({ kind: 'privacy_restrict' }), wallet: 'default-wallet' });
    expect(r.status).toBe(200);
    const decision = await call('/me/compliance/check', { wallet: 'default-wallet', feature: 'market' });
    expect(decision.status).toBe(403); expect(decision.body.code).toBe('privacy_restricted');
    expect((await call('/me/rights')).status).toBe(200);
    const other = createSession(db, 'other-wallet');
    expect((await call('/me/rights/' + r.body.id, undefined, { Cookie: `gc_session=${other.cookie}` })).status).toBe(404);
  });
});
