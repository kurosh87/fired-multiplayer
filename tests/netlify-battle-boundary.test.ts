import {test} from 'node:test';
import assert from 'node:assert/strict';
import {privateBattleOrigin} from '../apps/server/src/netlify-battles.ts';

test('private battle Function admits only immutable previews for the intended site',()=>{
  const deployment={siteId:'4fcf6389-9abb-4239-8134-d99fa08b85d8',context:'deploy-preview'};
  const origin='https://0123456789abcdef01234567--kanto-online-preview.netlify.app';
  assert.equal(privateBattleOrigin(new Request(origin+'/api/online/battles'),deployment),origin);
  assert.equal(privateBattleOrigin(new Request(origin+'/api/online/battles'),{...deployment,context:'branch-deploy'}),origin);
  for(const url of ['https://kanto-online-preview.netlify.app','http://0123456789abcdef01234567--kanto-online-preview.netlify.app',
    origin+'.evil.example',origin+':8443','https://kanto-account-check--kanto-online-preview.netlify.app'])
    assert.equal(privateBattleOrigin(new Request(url),deployment),undefined);
  assert.equal(privateBattleOrigin(new Request(origin),{...deployment,context:'production'}),undefined);
  assert.equal(privateBattleOrigin(new Request(origin),{...deployment,siteId:'other'}),undefined);
});
