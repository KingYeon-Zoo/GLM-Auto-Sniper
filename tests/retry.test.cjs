const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const code = fs.readFileSync('GLM自动抢购.js', 'utf8');
function setup(fetch) {
  // 执行真实重试函数和状态，跳过页面 UI 初始化，不接触真实购买服务。
  const start = code.indexOf('    // ======================== 应用配置');
  const end = code.indexOf('    // ======================== (三)');
  const stop = code.slice(code.indexOf('    function requestStopOperation()'), code.indexOf('    // ======================== (七)'));
  const ctx = { window: { fetch }, location: { origin: 'https://example.test' }, Headers, AbortController, DOMException, setTimeout: fn => { queueMicrotask(fn); return 1; }, console: { log() {} }, updateLogsUI() {}, updateStatusUI() {}, initiateAutoRecovery() {} };
  vm.createContext(ctx);
  vm.runInContext(code.slice(start,end) + stop + '\nglobalThis.api={executeRetryStrategy,requestStopOperation,appState};',ctx);
  return ctx.api;
}
const reply = (data,status=200) => new Response(JSON.stringify(data),{status});
test('中止挂起请求后可立即更换套餐重新发起',async()=>{
  const api=setup((_url,options)=> {
    if(options.body==='旧套餐') return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('停止','AbortError'))));
    return Promise.resolve(options.body ? reply({code:200,data:{bizId:'新套餐'}}) : reply({code:200,data:'OK'}));
  });
  const old=api.executeRetryStrategy('/preview',{body:'旧套餐'});
  api.requestStopOperation();
  const fresh=api.executeRetryStrategy('/preview',{body:'新套餐'});
  assert.equal((await old).isSuccess,false);
  assert.equal((await fresh).isSuccess,true);
  assert.equal(api.appState.successfulBizId,'新套餐');
});
test('check 的 HTTP 500 不会被当作成功',async()=>{
  let checks=0;
  const api=setup((_url,options)=>Promise.resolve(options.body ? reply({code:200,data:{bizId:'id'}}) : (++checks===1 ? reply({code:500},500) : reply({code:200,data:'OK'}))));
  assert.equal((await api.executeRetryStrategy('/preview',{body:'套餐'})).isSuccess,true);
  assert.equal(checks,2);
});
