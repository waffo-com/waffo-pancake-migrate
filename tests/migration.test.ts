import { test, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPancakeProducts, createPancakeStore, listPancakeStores } from '../src/pancake/creator.js';
import { startAudit, audit, endAudit, registerSecret } from '../src/utils/audit.js';
import { spinner, stopSpinners } from '../src/utils/spinner.js';
import { PassThrough } from 'node:stream';
import { createCli } from '../src/cli.js';

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({type:'pkcs8',format:'pem'}).toString();
const merchantId = 'MER_' + '1'.repeat(22), storeId = 'STO_' + '2'.repeat(22), productId = 'PROD_' + '3'.repeat(22);
const store = {id:storeId,name:'Test store',status:'active'};
const input = {type:'onetime' as const,name:'Credits',description:null,prices:{USD:{amount:'19.90',taxCategory:'digital_goods' as const}},media:[],metadata:{},stripeProductId:'source',stripePriceIds:['source']};
const product = {id:productId,storeId,name:input.name,status:'active',hasProdVersion:false,prices:[{currency:'USD',priceInfo:input.prices.USD}]};
after(() => rmSync(dir, {recursive:true,force:true}));
const realFetch = globalThis.fetch;
const dir = mkdtempSync(join(tmpdir(),'migration-tests-'));
afterEach(() => { globalThis.fetch = realFetch; process.exitCode = 0; stopSpinners(); endAudit(); });
const response = (data: unknown) => new Response(JSON.stringify({data}), {headers:{'content-type':'application/json','x-request-id':'req-test'}});
function mockApi(options: {missingStore?:boolean; mismatch?:boolean; delayed?:boolean; nested?:boolean; rejectCreate?:boolean; wrongPrice?:boolean; wrongPeriod?:boolean} = {}) {
  const calls: string[] = []; let reads = 0;
  globalThis.fetch = async (url, init) => {
    const path = String(url); calls.push(path);
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (path.endsWith('/create-store')) return response({store});
    if (path.endsWith('/create-product')) {
      if (options.rejectCreate) return new Response('{}',{status:500});
      return response({product:{id:productId}});
    }
    let data;
    if (body.query.includes('stores(')) data = {stores:[store]};
    else if (body.query.includes('store(id:')) data = {store:options.missingStore ? null : store};
    else { reads++; data = {[body.query.includes("subscriptionProduct(") ? "subscriptionProduct" : "onetimeProduct"]:options.delayed && reads === 1 ? null : {...product,billingPeriod:options.wrongPeriod ? "yearly" : "monthly",prices:options.wrongPrice ? [{currency:"USD",priceInfo:{...input.prices.USD,amount:"1.00"}}] : product.prices,storeId:options.mismatch ? 'wrong' : storeId}}; }
    return response(options.nested ? {data} : data);
  };
  return calls;
}
test('store list accepts the actual unwrapped SDK response and nested response', async () => {
  for (const nested of [false,true]) { mockApi({nested}); assert.deepEqual(await listPancakeStores(merchantId,privateKey),[store]); }
});
test('missing store prevents all product writes', async () => {
  const calls=mockApi({missingStore:true});
  await assert.rejects(createPancakeProducts({merchantId,privateKey,storeId,products:[input]}),/could not be verified/);
  assert.equal(calls.some(c=>c.endsWith('/create-product')),false);
});
test('created but invisible store stops before migrating', async () => {
  const calls=mockApi({missingStore:true});
  await assert.rejects(createPancakeStore(merchantId,privateKey,store.name),/could not be verified/);
  assert.equal(calls.filter(c=>c.endsWith('/create-store')).length,1);
});
test('product read-back mismatch retains ID and reports unverified', async () => {
  mockApi({mismatch:true}); const [result]=await createPancakeProducts({merchantId,privateKey,storeId,products:[input]});
  assert.equal(result.success,false); assert.equal(result.pancakeProductId,productId); assert.match(result.error!,/read-back/);
});
test('eventual consistency retries reads, never creates again', async () => {
  const calls=mockApi({delayed:true}); const [result]=await createPancakeProducts({merchantId,privateKey,storeId,products:[input]});
  assert.equal(result.success,true); assert.equal(result.hasProdVersion,false); assert.equal(calls.filter(c=>c.endsWith('/create-product')).length,1);
});
test('HTTP failure is never reported as successful creation', async () => {
  mockApi({rejectCreate:true}); const [result]=await createPancakeProducts({merchantId,privateKey,storeId,products:[input]});
  assert.equal(result.success,false); assert.equal(result.pancakeProductId,undefined); assert.match(result.error!,/HTTP 500/);
});
test('audit redacts credentials and excludes request bodies and headers', async () => {
  const file=startAudit(join(dir,'redacted.jsonl')); registerSecret(privateKey); registerSecret('secret-token');
  audit('test',{error:`${privateKey} secret-token creem_abc sk_live_abc`,body:privateKey,headers:{Authorization:'secret-token'}});
  mockApi(); await createPancakeProducts({merchantId,privateKey,storeId,products:[input]});
  const text=readFileSync(file,'utf8');
  for (const secret of [privateKey,'secret-token','creem_abc','sk_live_abc','Authorization','PRIVATE KEY']) assert.equal(text.includes(secret),false);
  assert.match(text,/product.verified/); assert.match(text,/req-test/);
  assert.throws(()=>startAudit(file),/EEXIST/);
});
function creemMock(options: Parameters<typeof mockApi>[0] = {}) {
  const calls=mockApi(options); const pancakeFetch=globalThis.fetch;
  globalThis.fetch=async (url,init) => {
    const href=url instanceof Request ? url.url : String(url);
    if (!href.includes('creem.io')) return pancakeFetch(url,init);
    return new Response(JSON.stringify({items:[{id:'prod_source',mode:'prod',object:'product',name:'Credits',description:'',price:1990,currency:'USD',billing_type:'onetime',billing_period:'once',status:'active',tax_mode:'exclusive',tax_category:'digital-goods-service',created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z'}],pagination:{total_records:1,total_pages:1,current_page:1,next_page:null,prev_page:null}}),{headers:{'content-type':'application/json'}});
  };
  return calls;
}
async function cli(name:string,extra:string[] = []) {
  await createCli().parseAsync(['creem','--api-key','creem_fake','--merchant-id',merchantId,'--private-key',privateKey,'--store-id','new','--store-name',store.name,'--yes','--log-file',join(dir,name+'.jsonl'),...extra],{from:'user'});
  return readFileSync(join(dir,name+'.jsonl'),'utf8');
}
test('full Creem CLI new-store flow creates then verifies store and product', async () => {
  const calls=creemMock(); const log=await cli('cli-success');
  assert.notEqual(process.exitCode,1); assert.match(log,/store.created/); assert.match(log,/product.verified/); assert.match(log,/migration.finished/);
  assert.equal(calls.filter(c=>c.endsWith('/create-store')).length,1);
});
test('full CLI dry-run never writes a store or product', async () => {
  const calls=creemMock(); await cli('cli-dry',['--dry-run']); assert.equal(calls.length,0); assert.notEqual(process.exitCode,1);
});
test('full CLI reports nonzero exit on product verification failure', async () => {
  creemMock({mismatch:true}); const log=await cli('cli-fail'); assert.equal(process.exitCode,1); assert.match(log,/"failed":1/);
});
test('full CLI stops on invisible newly created store', async () => {
  const calls=creemMock({missingStore:true}); const log=await cli('cli-store-fail'); assert.equal(process.exitCode,1); assert.match(log,/migration.failed/); assert.equal(calls.some(c=>c.endsWith('/create-product')),false);
});

test('price and subscription billing-period mismatches fail verification', async () => {
  for (const options of [{wrongPrice:true},{wrongPeriod:true}]) {
    mockApi(options);
    const [result] = await createPancakeProducts({merchantId,privateKey,storeId,products:[{...input,type:'subscription',billingPeriod:'monthly'}]});
    assert.equal(result.success,false); assert.equal(result.pancakeProductId,productId);
  }
});

test('Stripe branding fetch failure produces nonzero exit even with no writes', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({error:{message:'denied',type:'invalid_request_error'}}),{status:400,headers:{'content-type':'application/json'}});
  await createCli().parseAsync(['stripe','--stripe-key','sk_test_fake','--merchant-id',merchantId,'--private-key',privateKey,'--store-id',storeId,'--tax-category','saas','--skip-products','--skip-webhooks','--yes','--log-file',join(dir,'stripe-failure.jsonl')],{from:'user'});
  assert.equal(process.exitCode,1);
});

test('stale successful GraphQL response cannot validate a missing store', async () => {
  let creates = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/create-store')) { creates++; return response({store}); }
    const headers = new Headers(init?.headers);
    // Reproduce the gateway replay: old reads say active; current state is absent.
    return response({store: headers.has('X-Idempotency-Key') ? store : null});
  };
  await assert.rejects(createPancakeStore(merchantId, privateKey, store.name), /create response may have been replayed/);
  assert.equal(creates, 1, 'verification failure must not silently create another store');
});

test('fresh reads observe store deletion rather than replaying the first response', async () => {
  let exists = true;
  const cached = new Map<string, unknown>();
  globalThis.fetch = async (_url, init) => {
    const headers = new Headers(init?.headers);
    const key = headers.get('X-Idempotency-Key');
    const current = {stores: exists ? [store] : []};
    if (key && cached.has(key)) return response(cached.get(key));
    if (key) cached.set(key, current);
    return response(current);
  };
  assert.equal((await listPancakeStores(merchantId, privateKey)).length, 1);
  exists = false;
  assert.deepEqual(await listPancakeStores(merchantId, privateKey), []);
});

test('explicit creation ID survives a lost response without duplicate stores', async () => {
  const keys: string[] = [];
  const created = new Map<string, typeof store>();
  let loseResponse = true;
  globalThis.fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    if (String(url).endsWith('/create-store')) {
      const key = headers.get('X-Idempotency-Key')!;
      assert.ok(key); keys.push(key);
      if (!created.has(key)) created.set(key, {...store, id:'STO_' + String(created.size + 4).repeat(22)});
      if (loseResponse) { loseResponse = false; throw new Error('response lost after store was created'); }
      return response({store:created.get(key)});
    }
    assert.equal(headers.has('X-Idempotency-Key'), false);
    assert.ok(headers.get('X-Signature'), 'authentication is preserved');
    const {variables} = JSON.parse(String(init?.body));
    return response({store:[...created.values()].find(s => s.id === variables.id) ?? null});
  };
  await assert.rejects(createPancakeStore(merchantId,privateKey,store.name,'operation-a'), /response lost/);
  const first = await createPancakeStore(merchantId,privateKey,store.name,'operation-a');
  assert.equal(created.size, 1);
  assert.equal(keys[0], keys[1]);
  const second = await createPancakeStore(merchantId,privateKey,store.name,'operation-b');
  assert.equal(created.size, 2);
  assert.notEqual(first.id, second.id);
  assert.notEqual(keys[1], keys[2]);
});

test('CLI forwards explicit store creation ID and keeps product retry keys stable', async () => {
  creemMock(); const base = globalThis.fetch;
  const storeKeys: string[] = [], productKeys: string[] = [];
  globalThis.fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    if (String(url).endsWith('/create-store')) storeKeys.push(headers.get('X-Idempotency-Key')!);
    if (String(url).endsWith('/create-product')) productKeys.push(headers.get('X-Idempotency-Key')!);
    return base(url, init);
  };
  await cli('operation-a1',['--store-creation-id','a']);
  await cli('operation-a2',['--store-creation-id','a']);
  await cli('operation-b',['--store-creation-id','b']);
  assert.equal(storeKeys[0],storeKeys[1]);
  assert.notEqual(storeKeys[0],storeKeys[2]);
  assert.equal(new Set(productKeys).size,1);
});

test('audit redacts multiline bare private keys before JSON escaping', () => {
  const bareKey = privateKey.replace(/-----[^\n]+-----/g, '').trim();
  const quotedSecret = 'secret-with-"quotes"\nand-newlines';
  registerSecret(bareKey);
  registerSecret(quotedSecret);
  const file = startAudit(join(dir,'multiline-secret.jsonl'));
  audit('test', { error: `failure: ${bareKey} ${quotedSecret}`, message: { privateKey } });
  const contents = readFileSync(file,'utf8');
  for (const line of bareKey.split('\n')) assert.equal(contents.includes(line),false);
  const entry = JSON.parse(contents.trim().split('\n').at(-1)!);
  assert.equal(entry.error,'failure: [REDACTED] [REDACTED]');
  assert.equal(entry.message,undefined);
});

test('CLI exception stops enabled spinner timers before returning failure', async () => {
  const stream = new PassThrough(); stream.resume();
  const indicator = spinner({text:'request in progress', stream, isEnabled:true, discardStdin:false, hideCursor:false}).start();
  assert.equal(indicator.isSpinning,true);
  await cli('invalid-operation',['--store-creation-id','invalid operation']);
  assert.equal(process.exitCode,1);
  assert.equal(indicator.isSpinning,false);
});
