import test from 'node:test';
import assert from 'node:assert/strict';
const bytes = text => new TextEncoder().encode(text);

test('PalmDOC decompression checks literal/reference bounds and exact output ceilings', async () => {
  const {decompressPalmDOC} = await import('../mobi.js');
  assert.equal(new TextDecoder().decode(decompressPalmDOC(bytes('abc'),3)), 'abc');
  assert.equal(new TextDecoder().decode(decompressPalmDOC(Uint8Array.of(97,0x80,0x08),4)), 'aaaa');
  for (const raw of [Uint8Array.of(8,97),Uint8Array.of(0x80),Uint8Array.of(0x80,0),Uint8Array.of(0x80,8)]) assert.throws(()=>decompressPalmDOC(raw,100),/PalmDOC/);
  assert.throws(()=>decompressPalmDOC(bytes('abcd'),3),/expansion limit/);
});

function huffFixture(value, literal = true) {
  const h = new ArrayBuffer(16+1024+256), v = new DataView(h);
  new Uint8Array(h).set(bytes('HUFF')); v.setUint32(8,16);v.setUint32(12,1040);
  for(let i=0;i<256;i++)v.setUint32(16+i*4,(i<<8)|0x80|8);
  const d = new ArrayBuffer(20+value.length), w = new DataView(d);
  new Uint8Array(d).set(bytes('CDIC'));w.setUint32(4,16);w.setUint32(8,1);w.setUint32(12,0);w.setUint16(16,2);w.setUint16(18,(literal?0x8000:0)|value.length);new Uint8Array(d).set(value,20);
  return [h,d];
}
test('HUFF dictionaries reject cycles, malformed codes, huge expansions and truncated offset tables', async () => {
  const {huffcdic}=await import('../mobi.js');
  const open=records=>huffcdic({huffcdic:0,numHuffcdic:2},async i=>records[i],16,100);
  const good=huffFixture(bytes('word'));
  assert.equal(new TextDecoder().decode((await open(good))(Uint8Array.of(0,0))),'wordword');
  const decoder = await open(good);
  assert.throws(() => decoder(Uint8Array.of(0,0,0,0,0)), /expansion limit/);
  const cyclic = await open(huffFixture(Uint8Array.of(0),false));
  assert.throws(()=>cyclic(Uint8Array.of(0)),/cyclic/);
  const badCode=huffFixture(bytes('a'));new DataView(badCode[0]).setUint32(16,0);
  const awaitedBad=await open(badCode);
  assert.throws(()=>awaitedBad(Uint8Array.of(0)),/code length/);
  const truncated=huffFixture(bytes('a'));new DataView(truncated[1]).setUint32(12,16);new DataView(truncated[1]).setUint32(8,65536);
  await assert.rejects(open(truncated),/offset table/);
  await assert.rejects(huffcdic({huffcdic:0,numHuffcdic:2},async i=>good[i],16,1),/dictionary expansion/);
});

test('MOBI index declarations are bounded before table allocation or variable-length loops', async () => {
  const {getIndexData}=await import('../mobi.js');
  // A synthetic INDX control record with a minimal TAGX trailer.
  const record=new ArrayBuffer(72),v=new DataView(record);
  new Uint8Array(record).set(bytes('INDX'));v.setUint32(4,60);v.setUint32(24,0);v.setUint32(28,65001);
  new Uint8Array(record).set(bytes('TAGX'),60);v.setUint32(64,12);v.setUint32(68,1);
  assert.deepEqual((await getIndexData(0,async()=>record)).table,[]);
  v.setUint32(64,0xffffffff);await assert.rejects(getIndexData(0,async()=>record),/TAGX/);
  v.setUint32(64,12);v.setUint32(24,0xffffffff);await assert.rejects(getIndexData(0,async()=>record),/INDX/);
});

