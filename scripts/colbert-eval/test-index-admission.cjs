'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installIndexAdmission } = require('./index-admission.cjs');
function fixture(run) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gmax-admission-repair-'));
  const directory=path.join(root,'resource-budget');fs.mkdirSync(directory);
  const record={pid:12345,start:'Sat Oct 24 03:36:34 2026',kind:'client',nonce:'foreign',mb:1,version:1};
  const file=path.join(directory,'foreign.json'),bytes=JSON.stringify(record);fs.writeFileSync(file,bytes);
  const budget={deps:{quarantine:()=>null,signal:()=>{}},readRecords:()=>[JSON.parse(fs.readFileSync(file))],check(){this.records(this.snapshot);}};
  try {run({budget,record,file,bytes,root});} finally {fs.rmSync(root,{recursive:true,force:true});}
}
test('timezone identity mismatch refuses before model work and preserves the foreign ledger bytes',()=>fixture(({budget,record,file,bytes,root})=>{
  budget.snapshot={processes:[{pid:record.pid,start:'Sat Oct 24 10:36:34 2026'}]};
  assert.throws(()=>installIndexAdmission(budget,root,()=>null),/identity differs/);
  assert.equal(fs.readFileSync(file,'utf8'),bytes);
}));
test('a matching live registration remains intact and participates in admission',()=>fixture(({budget,record,file,bytes,root})=>{
  budget.snapshot={processes:[{pid:record.pid,start:record.start}]};installIndexAdmission(budget,root,()=>null);
  assert.equal(budget.records(budget.snapshot)[0].pid,record.pid);assert.equal(fs.readFileSync(file,'utf8'),bytes);
}));
test('verified dead foreign reservations are excluded without deleting their files',()=>fixture(({budget,file,bytes,root})=>{
  budget.snapshot={processes:[]};budget.deps.signal=()=>{const error=new Error();error.code='ESRCH';throw error;};
  installIndexAdmission(budget,root,()=>null);assert.deepEqual(budget.records(budget.snapshot),[]);assert.equal(fs.readFileSync(file,'utf8'),bytes);
}));
test('host quarantine refuses without altering any reservation',()=>fixture(({budget,file,bytes,root})=>{
  assert.throws(()=>installIndexAdmission(budget,root,()=>'retained stop'),/host safety stop/);assert.equal(fs.readFileSync(file,'utf8'),bytes);
}));
