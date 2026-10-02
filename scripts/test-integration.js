'use strict';

/*
 * 基于 pg-mem 的端到端业务流程测试（不依赖真实 PostgreSQL）：
 *   node scripts/test-integration.js
 * 覆盖：登记额度、提交/批准、重叠拒绝、超限按年超额量、并发批准不超配、
 *       实测替代估算、重叠实测拒绝、迟到实测转待复核与复核重新校验、
 *       计划调整申请的提交/撤回/驳回/批准、待审占用、原值拟改值、冲突计划/实测/超额年份核对、
 *       成对核准（互换档期、组成性拒绝、试算/提交、失败原子性、各计划贡献超额）、
 *       联合核准（2~10 条待批准计划：组内重叠/外部重叠、年度残余合并超额、未登记上限、
 *                 状态与实时占用重核、失败整组不变、逐条+汇总审计、跨展品组）、
 *       下调年度上限的预演/凭证提交、占用变化拒绝并返回新结果、旧接口同事务即时重算、
 *       未开始计划转待复核（写明原因）、已开始计划保留且超额如实显示、
 *       实测纠错（替代仍属原计划、越窗/相交/非法数值拒绝、旧记录作废保留+替代确认+双向关联、
 *                 自然年重算、纠错超额转待复核、占用下降不恢复待复核、链式纠错、取消计划后纠错）、
 *       计划外照明事故（登记校验/三类相交冲突一次性指出且不保存、窗内替代估算/窗外单独计量/不释放排期、
 *                 跨年拆分、后续实测/停灯/纠错互斥、超额仍生效转待复核、已开始计划不转、
 *                 下调预演指纹含事故、已封存账册不回写与新增来源对照、调整口径、不可改删/越权）。
 */

process.env.SEED_DEMO = 'false';
process.env.PGHOST = 'memory';

const http = require('http');
const { newDb } = require('pg-mem');
const dbModule = require('../src/db');

// ---- 用 pg-mem 替换 pg 连接池 ----
const mem = newDb({ autoCreateForeignKeyIndices: true });
const { Pool: MemPool } = mem.adapters.createPg();
const fakePool = new MemPool();

// db.js 的 withTransaction 使用 pool.connect() 取得 client；其余处使用 pool.query。
dbModule.pool.connect = (...args) => fakePool.connect(...args);
dbModule.pool.query = (...args) => fakePool.query(...args);

const { createApp } = require('../src/app');
const { initializeDatabase } = require('../src/init');
const config = require('../src/config');
const dosing = require('../src/dosing');

let server;
let base;
const cookies = new Map();
let assertCount = 0;

function assert(cond, msg) {
  assertCount++;
  if (!cond) throw new Error('断言失败: ' + msg);
}

// pg-mem 的 DATE 可能返回 Date 对象，真实 pg 经类型解析返回 'YYYY-MM-DD'；统一取前 10 位
function ymd(v) {
  return typeof v === 'string' ? v.slice(0, 10)
    : `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
}

function call(method, urlPath, body, role) {
  const cookie = role ? cookies.get(role) : null;
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      `${base}${urlPath}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(cookie ? { Cookie: `lqsession=${cookie}` } : {}),
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          if (role && res.headers['set-cookie']) {
            const m = res.headers['set-cookie'][0].match(/lqsession=([a-f0-9]+)/);
            if (m) cookies.set(role, m[1]);
          }
          let json = null;
          try {
            json = JSON.parse(chunks);
          } catch (_) {
            /* ignore */
          }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  await initializeDatabase();

  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  await runFlow();

  server.close();
  console.log(`\n集成测试全部通过（${assertCount} 条断言）`);
  process.exit(0);
}

async function runFlow() {
  // ---- 登录 / 角色 ----
  let r = await call('POST', '/api/auth/login',
    { username: config.seed.conservatorUsername, password: config.seed.conservatorPassword }, 'c');
  assert(r.status === 200, '保管员登录');
  r = await call('POST', '/api/auth/login',
    { username: config.seed.installerUsername, password: config.seed.installerPassword }, 'i');
  assert(r.status === 200, '布展员登录');

  r = await call('POST', '/api/exhibits', { name: 'X' }, 'i');
  assert(r.status === 403, '布展员不能登记展品');

  // ---- 登记展品与额度 ----
  r = await call('POST', '/api/exhibits',
    { name: '宋拓本', accessionNo: 'A-1', medium: '纸本' }, 'c');
  assert(r.status === 201, '登记展品');
  const exhibitId = r.body.exhibit.id;

  r = await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2026, limitLxh: 1600 }, 'c');
  assert(r.status === 200, '登记 2026 上限 1600');

  // ---- 输入校验 ----
  r = await call('POST', '/api/plans', {
    exhibitId, title: '坏计划', startDate: '2026-03-01', endDate: '2026-03-01',
    periods: ['09:00-17:00'], estimatedLux: 0,
  }, 'i');
  assert(r.status === 400 && /正数/.test(r.body.error), '非正照度报错');

  r = await call('POST', '/api/plans', {
    exhibitId, title: '坏时段', startDate: '2026-03-01', endDate: '2026-03-02',
    periods: ['09:00-09:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 400, '零时长时段报错');

  r = await call('POST', '/api/plans', {
    exhibitId, title: '坏日期', startDate: '2026-02-30', endDate: '2026-03-02',
    periods: ['09:00-10:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 400, '非法日期报错');

  // ---- 计划1：3/1-3/2 每天 09-17，100lx = 1600 ----
  r = await call('POST', '/api/plans', {
    exhibitId, title: '三月展', startDate: '2026-03-01', endDate: '2026-03-02',
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '提交计划1');
  const plan1 = r.body.plan.id;

  r = await call('GET', `/api/plans/${plan1}`, null, 'i');
  assert(r.body.estimatedYearly['2026'] === 1600, '按年拆分 2026=1600');

  r = await call('POST', `/api/plans/${plan1}/approve`, {}, 'i');
  assert(r.status === 403, '布展员不能批准');

  r = await call('POST', `/api/plans/${plan1}/approve`, {}, 'c');
  assert(r.status === 200, '保管员批准计划1');

  // ---- 夜场：同日但不重叠；额度不足 ----
  r = await call('POST', '/api/plans', {
    exhibitId, title: '夜场（不重叠）', startDate: '2026-03-01', endDate: '2026-03-01',
    periods: ['18:00-22:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '非重叠时段可提交');
  const plan2 = r.body.plan.id;
  r = await call('POST', `/api/plans/${plan2}/approve`, {}, 'c');
  assert(r.status === 409 && r.body.details.overflows[0].year === 2026,
    '夜场批准因 2026 超限被拒');
  const ov = r.body.details.overflows[0];
  assert(ov.excess === 400 && ov.limit === 1600 && ov.projected === 2000,
    `超额量 400 正确，实际=${JSON.stringify(ov)}`);

  // ---- 时间重叠计划：提交即被拒 ----
  r = await call('POST', '/api/plans', {
    exhibitId, title: '撞车计划', startDate: '2026-03-02', endDate: '2026-03-02',
    periods: ['10:00-11:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 409, '重叠计划提交即被拒');

  // 提额到 3000 后夜场可批（1600+400=2000）
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2026, limitLxh: 3000 }, 'c');
  r = await call('POST', `/api/plans/${plan2}/approve`, {}, 'c');
  assert(r.status === 200, '提额后夜场批准成功');

  // ---- 实测：3/1 实测 150lx 替代当天 100lx 估算 ----
  r = await call('POST', '/api/measurements', {
    planId: plan1, startDate: '2026-03-01', startTime: '09:00',
    endDate: '2026-03-01', endTime: '17:00', actualLux: 150,
  }, 'c');
  assert(r.status === 201, '录入实测草稿');
  const meas1 = r.body.measurement.id;

  r = await call('POST', '/api/measurements', {
    planId: plan1, startDate: '2026-03-01', startTime: '17:30',
    endDate: '2026-03-01', endTime: '18:30', actualLux: 100,
  }, 'c');
  assert(r.status === 400, '计划开灯窗外的实测被拒绝');

  r = await call('POST', '/api/measurements', {
    planId: plan1, startDate: '2026-03-01', startTime: '10:00',
    endDate: '2026-03-01', endTime: '11:00', actualLux: 100,
  }, 'c');
  assert(r.status === 409, '重叠实测被拒绝');

  r = await call('POST', `/api/measurements/${meas1}/confirm`, {}, 'c');
  assert(r.status === 200, '确认实测（不超限）');
  // 1200(实测) + 800(plan1 次日残余) + 400(夜场) = 2400
  assert(r.body.years['2026'].used === 2400,
    `实测替代估算后 2026 已用应为 2400，实际 ${r.body.years['2026'].used}`);
  assert(r.body.years['2026'].remaining === 600, '剩余 600');

  // ---- 迟到实测导致超限 + 转待复核 ----
  // 另一年份（约 400 天后）的已批准计划，用于验证“别的年份超额不会牵连它”
  const future = new Date(Date.now() + 400 * 86400000);
  const fy = future.getUTCFullYear();
  const fm = String(future.getUTCMonth() + 1).padStart(2, '0');
  const fd = String(future.getUTCDate()).padStart(2, '0');
  const futureYmd = `${fy}-${fm}-${fd}`;
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: fy, limitLxh: 2000 }, 'c');

  r = await call('POST', '/api/plans', {
    exhibitId, title: '未来展（另一年份）', startDate: futureYmd, endDate: futureYmd,
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '提交另一年份未来计划');
  const futurePlan = r.body.plan.id;
  r = await call('POST', `/api/plans/${futurePlan}/approve`, {}, 'c');
  assert(r.status === 200, '另一年份未来计划批准');

  // 2026 年内、确定尚未开始的计划（必须在迟到实测确认前批准）
  const in30 = new Date(Date.now() + 30 * 86400000);
  let pendingPlan = null;
  if (in30.getUTCFullYear() === 2026) {
    const m2 = String(in30.getUTCMonth() + 1).padStart(2, '0');
    const d2 = String(in30.getUTCDate()).padStart(2, '0');
    const ymd2 = `2026-${m2}-${d2}`;
    const cr = await call('POST', '/api/plans', {
      exhibitId, title: '2026未开始计划', startDate: ymd2, endDate: ymd2,
      periods: ['09:00-17:00'], estimatedLux: 50, // 8h*50 = 400
    }, 'i');
    assert(cr.status === 201, '提交 2026 未开始计划');
    pendingPlan = cr.body.plan.id;
    // 当前 used=2400，+400=2800 ≤ 3000
    const ar = await call('POST', `/api/plans/${pendingPlan}/approve`, {}, 'c');
    assert(ar.status === 200, `2026 未开始计划批准（实际 ${ar.status} ${JSON.stringify(ar.body)}）`);
  }

  // 迟到实测：plan1 第二天 3/2 实测 500lx => 4000 替代 800
  // 2026 used = 1200 + 4000 + 400(夜场) [+ 400 待复核计划] = 6000，超额 3000
  r = await call('POST', '/api/measurements', {
    planId: plan1, startDate: '2026-03-02', startTime: '09:00',
    endDate: '2026-03-02', endTime: '17:00', actualLux: 500,
  }, 'c');
  assert(r.status === 201, '录入迟到实测草稿');
  const meas2 = r.body.measurement.id;
  r = await call('POST', `/api/measurements/${meas2}/confirm`, {}, 'c');
  assert(r.status === 409, '迟到实测确认后超限返回 409');
  const of2026 = r.body.overflows.find((o) => o.year === 2026);
  assert(of2026 && of2026.excess === 3000 && of2026.projected === 6000,
    `2026 超额 3000、合计 6000，实际=${JSON.stringify(r.body.overflows)}`);
  // 另一年份的计划不受牵连
  assert(!r.body.flaggedPlans.some((p) => p.id === futurePlan),
    '另一年份的计划不因 2026 超额而转待复核');
  // 已开始（3 月）的 plan1/plan2 不转待复核
  assert(!r.body.flaggedPlans.some((p) => p.id === plan1 || p.id === plan2),
    '已开始的计划不转待复核');
  if (pendingPlan) {
    assert(r.body.flaggedPlans.some((p) => p.id === pendingPlan),
      '2026 年未开始计划转为待复核');
  }

  // 与已确认实测重叠的录入被拒绝
  const mr = await call('POST', '/api/measurements', {
    planId: plan1, startDate: '2026-03-02', startTime: '09:00',
    endDate: '2026-03-02', endTime: '10:00', actualLux: 600,
  }, 'c');
  assert(mr.status === 409, '与已确认实测重叠的录入被拒绝');

  // 超限未解除时，待复核计划复核仍被拒（原审批与测量记录保留）
  if (pendingPlan) {
    const rr = await call('POST', `/api/plans/${pendingPlan}/approve`, {}, 'c');
    assert(rr.status === 409, '超限状态下复核通过仍被拒绝');
  }

  // 超限状态下，新的计划批准必然 409
  r = await call('POST', '/api/plans', {
    exhibitId, title: '超额后的新计划', startDate: '2026-06-01', endDate: '2026-06-01',
    periods: ['09:00-10:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '提交新计划');
  const blockedPlan = r.body.plan.id;
  r = await call('POST', `/api/plans/${blockedPlan}/approve`, {}, 'c');
  assert(r.status === 409, '超限状态下新计划批准被拒');

  // 已确认实测不可删除
  r = await call('DELETE', `/api/measurements/${meas2}`, null, 'c');
  assert(r.status === 400, '已确认实测不可删除（保留测量记录）');

  // 提额解除 2026 超限：待复核计划复核通过，新计划也可批
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2026, limitLxh: 100000 }, 'c');
  if (pendingPlan) {
    const rr = await call('POST', `/api/plans/${pendingPlan}/approve`, {}, 'c');
    assert(rr.status === 200, '提额后待复核计划复核通过');
  }
  r = await call('POST', `/api/plans/${blockedPlan}/approve`, {}, 'c');
  assert(r.status === 200, '提额后新计划可批准');

  // ---- 跨年拆分：未登记年份额度 ----
  r = await call('POST', '/api/plans', {
    exhibitId, title: '跨年展', startDate: '2027-12-31', endDate: '2028-01-01',
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '跨年计划可提交');
  const crossPlan = r.body.plan.id;
  r = await call('GET', `/api/plans/${crossPlan}`, null, 'i');
  assert(r.body.estimatedYearly['2027'] === 800 && r.body.estimatedYearly['2028'] === 800,
    '跨年剂量按自然年拆分');
  r = await call('POST', `/api/plans/${crossPlan}/approve`, {}, 'c');
  assert(r.status === 409, '跨年计划批准被拒');
  // fy 年（约一年后，通常是 2027）可能已登记额度；2028 一定未登记，错误必须指出缺失年份
  assert(/2028/.test(r.body.error), `错误指出 2028 年未登记额度，实际：${r.body.error}`);

  // ---- 并发批准不超配（额度恰好只够一个）----
  // 2027 已被 futurePlan 占用 800（上限 2000），提到 4000 以容纳跨年计划的 800
  if (fy === 2027) {
    await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2027, limitLxh: 4000 }, 'c');
  } else {
    await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2027, limitLxh: 800 }, 'c');
  }
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2028, limitLxh: 900 }, 'c');
  r = await call('POST', `/api/plans/${crossPlan}/approve`, {}, 'c');
  assert(r.status === 200, `跨年计划批准：2027/2028 各占 800（实际 ${r.status} ${r.body && r.body.error}）`);

  const pairIds = [];
  for (let i = 0; i < 2; i++) {
    const cr = await call('POST', '/api/plans', {
      exhibitId, title: `并发二选一-${i}`, startDate: '2028-03-01', endDate: '2028-03-01',
      periods: ['09:00-10:00'], // 两计划开灯时刻相同 => 互斥
      estimatedLux: 100,
    }, 'i');
    pairIds.push(cr.body.plan.id);
  }
  const rs = await Promise.all(pairIds.map((id) => call('POST', `/api/plans/${id}/approve`, {}, 'c')));
  const oks = rs.filter((x) => x.status === 200).length;
  const rejects = rs.filter((x) => x.status === 409).length;
  assert(oks === 1 && rejects === 1,
    `并发批准相同开灯时段：恰好一个成功（ok=${oks}, reject=${rejects}），不发生超配`);

  // 纯额度并发：2028 剩余 0；提额 +100，两条互不重叠的 100 分钟计划并发批准，只能过一个
  await call('POST', `/api/exhibits/${exhibitId}/limits`, { year: 2028, limitLxh: 1000 }, 'c');
  const quotaIds = [];
  for (let i = 0; i < 2; i++) {
    const cr = await call('POST', '/api/plans', {
      exhibitId, title: `并发额度-${i}`, startDate: '2028-04-01', endDate: '2028-04-01',
      periods: [`0${6 + i}:00-0${7 + i}:00`], // 06-07 / 07-08，时间相接不重叠，各 100 lx·h
      estimatedLux: 100,
    }, 'i');
    assert(cr.status === 201, `并发额度计划 ${i} 创建成功（${cr.status} ${cr.body && cr.body.error}）`);
    quotaIds.push(cr.body.plan.id);
  }
  const qr = await Promise.all(quotaIds.map((qid) => call('POST', `/api/plans/${qid}/approve`, {}, 'c')));
  const qok = qr.filter((x) => x.status === 200).length;
  const qrej = qr.filter((x) => x.status === 409).length;
  assert(qok === 1 && qrej === 1,
    `额度仅够一个的并发批准：恰好一个成功（ok=${qok}, reject=${qrej}），不超配`);
  assert(qr.some((x) => x.status === 409 && x.body.details && x.body.details.overflows),
    '被拒响应包含按年超额明细');

  // =======================================================================
  // 计划调整申请（布展员提交 / 撤回，保管员批准 / 驳回）
  // 使用遥远的固定日期（2030/2031），保证“尚未开始”确定成立
  // =======================================================================
  // 第二个布展员，用于越权校验
  r = await call('POST', '/api/users', {
    username: 'installer2', password: 'setup123', role: 'installer', displayName: '布展员乙',
  }, 'c');
  assert(r.status === 201, '创建第二个布展员');
  await call('POST', '/api/auth/login',
    { username: 'installer2', password: 'setup123' }, 'i2');

  const createExhibit = async (name) => {
    const cr = await call('POST', '/api/exhibits', { name }, 'c');
    assert(cr.status === 201, `登记展品 ${name}`);
    return cr.body.exhibit.id;
  };
  const submitPlan = async (exId, title, startDate, endDate, periods, lux) => {
    const cr = await call('POST', '/api/plans',
      { exhibitId: exId, title, startDate, endDate, periods, estimatedLux: lux }, 'i');
    assert(cr.status === 201, `提交计划 ${title}`);
    return cr.body.plan.id;
  };
  const approvePlan = async (id) => {
    const cr = await call('POST', `/api/plans/${id}/approve`, {}, 'c');
    assert(cr.status === 200, `批准计划 #${id}（${cr.status} ${cr.body && cr.body.error}）`);
  };

  const ex2 = await createExhibit('调整流程展品');
  await call('POST', `/api/exhibits/${ex2}/limits`, { year: 2030, limitLxh: 10000 }, 'c');
  await call('POST', `/api/exhibits/${ex2}/limits`, { year: 2031, limitLxh: 10000 }, 'c');

  // 计划 A：2030-06-01 单日 09-17，100lx = 800；计划 B：2030-06-02 夜场 18-22，100lx = 400
  const planA = await submitPlan(ex2, '调整目标A', '2030-06-01', '2030-06-01', ['09:00-17:00'], 100);
  const planB = await submitPlan(ex2, '相邻计划B', '2030-06-02', '2030-06-02', ['18:00-22:00'], 100);
  await approvePlan(planA);
  await approvePlan(planB);
  // 一份尚未批准的计划（submitted），不能提交调整
  const planSubmitted = await submitPlan(ex2, '未批准计划', '2030-07-01', '2030-07-01',
    ['09:00-10:00'], 100);

  // ---- 越权 / 状态 / 输入校验 ----
  r = await call('POST', '/api/adjustments', { planId: planA,
    startDate: '2030-06-01', endDate: '2030-06-01', periods: ['09:00-12:00'], estimatedLux: 100 }, 'c');
  assert(r.status === 403, '保管员不能提交调整申请（越权）');

  r = await call('POST', '/api/adjustments', { planId: planSubmitted,
    startDate: '2030-07-01', endDate: '2030-07-01', periods: ['09:00-12:00'], estimatedLux: 100 }, 'i');
  assert(r.status === 400 && /已批准/.test(r.body.error), '未批准计划的调整申请被拒绝');

  // 已开始的已批准计划（plan1 在 2026-03，早已开始）
  r = await call('POST', '/api/adjustments', { planId: plan1,
    startDate: '2031-01-01', endDate: '2031-01-01', periods: ['09:00-12:00'], estimatedLux: 100 }, 'i');
  assert(r.status === 400 && /已开始/.test(r.body.error), '已开始计划的调整申请被拒绝');

  r = await call('POST', '/api/adjustments', { planId: planA,
    startDate: '2030-06-01', endDate: '2030-06-01', periods: ['09:00-09:00'], estimatedLux: 100 }, 'i');
  assert(r.status === 400, '零时长时段的调整申请被拒绝');

  r = await call('POST', '/api/adjustments', { planId: planA,
    startDate: '2030-06-10', endDate: '2030-06-01', periods: ['09:00-12:00'], estimatedLux: 100 }, 'i');
  assert(r.status === 400, '展期倒置的调整申请被拒绝');

  r = await call('POST', '/api/adjustments', { planId: planA,
    startDate: '2030-06-01', endDate: '2030-06-01', periods: ['09:00-12:00'], estimatedLux: -5 }, 'i');
  assert(r.status === 400, '非正照度的调整申请被拒绝');

  // ---- 正常提交 + 重复申请拒绝 + 待审占用 ----
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2030-12-31', endDate: '2031-01-01',
    periods: ['09:00-17:00'], estimatedLux: 100, reason: '配合跨年活动改期',
  }, 'i');
  assert(r.status === 201, '提交调整申请 adj1');
  const adj1 = r.body.adjustment.id;
  assert(r.body.adjustment.preview.ok === true, '拟改窗口试算通过（无冲突）');
  assert(r.body.adjustment.preview.newResidueYearly['2030'] === 800 &&
    r.body.adjustment.preview.newResidueYearly['2031'] === 800,
    '拟改残余按年各 800');

  // 重复提交被拒
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2031-02-01', endDate: '2031-02-01',
    periods: ['09:00-12:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 409 && r.body.details.existingAdjustmentId === adj1,
    '同一计划重复待审申请被拒绝（409，指明既有申请）');

  // 待审期间原计划继续占用额度：展品 2030 已用仍为 A(800)+B(400)=1200
  r = await call('GET', `/api/exhibits/${ex2}`, null, 'i');
  assert(r.body.years['2030'].used === 1200, '待审期间原计划继续占用额度（2030=1200）');
  // 计划行带有待审申请与原值/拟改值
  const planARow = r.body.plans.find((p) => p.id === planA);
  assert(planARow.pendingAdjustment && planARow.pendingAdjustment.id === adj1,
    '展品详情计划行展示待审调整申请');

  // 另一布展员不能撤回
  r = await call('POST', `/api/adjustments/${adj1}/withdraw`, {}, 'i2');
  assert(r.status === 403, '非申请人撤回被拒绝（403）');
  // 保管员也不能批准尚未……（先测试驳回不改计划，随后撤回重提）
  r = await call('POST', `/api/adjustments/${adj1}/reject`, { reason: '改期材料不全' }, 'c');
  assert(r.status === 200, '保管员驳回 adj1');
  r = await call('GET', `/api/plans/${planA}`, null, 'i');
  assert(ymd(r.body.plan.start_date) === '2030-06-01' && !r.body.plan.pendingAdjustment,
    '驳回不改变计划原值，且不再有待审申请');

  // ---- 撤回后可重提 ----
  // 先提交再撤回
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2030-12-31', endDate: '2031-01-01',
    periods: ['09:00-12:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '驳回后可重新提交 adj2');
  const adj2 = r.body.adjustment.id;
  r = await call('POST', `/api/adjustments/${adj2}/withdraw`, {}, 'i');
  assert(r.status === 200, '申请人撤回 adj2');
  r = await call('POST', `/api/adjustments/${adj2}/approve`, {}, 'c');
  assert(r.status === 400, '已撤回申请不能再批准');
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2030-12-31', endDate: '2031-01-01',
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '撤回后可再次提交 adj3');
  const adj3 = r.body.adjustment.id;

  // ---- 批准冲突：与其他已批准计划开灯重叠（申请保持待审）----
  // 把拟改窗口改成与计划 B（2030-06-02 18-22）重叠
  await call('POST', `/api/adjustments/${adj3}/withdraw`, {}, 'i');
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2030-06-02', endDate: '2030-06-02',
    periods: ['20:00-21:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '提交与 B 重叠的 adj4（提交时不拦截，批准时核对）');
  const adj4 = r.body.adjustment.id;
  assert(r.body.adjustment.preview.ok === false, '试算标记不通过');
  assert(r.body.adjustment.preview.conflicts.overlappingPlans.some((p) => p.id === planB),
    '试算指出冲突计划 B');
  r = await call('POST', `/api/adjustments/${adj4}/approve`, {}, 'c');
  assert(r.status === 409, '重叠调整申请批准被拒（409）');
  assert(/相邻计划B/.test(r.body.error), '错误信息指出冲突计划');
  assert(r.body.details.conflicts.overlappingPlans[0].id === planB,
    '结构化冲突明细包含冲突计划');
  // 申请保持待审，可撤回
  r = await call('GET', `/api/adjustments/${adj4}`, null, 'i');
  assert(r.body.adjustment.status === 'pending', '核对失败后申请保持待审');
  await call('POST', `/api/adjustments/${adj4}/withdraw`, {}, 'i');

  // ---- 批准冲突：未作废实测落在新开灯窗外（draft 也算未作废）----
  // 先批准合规调整，随后在新窗口内录入实测；再用一个排除该实测的新窗口申请
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2030-12-31', endDate: '2031-01-01',
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  const adj5 = r.body.adjustment.id;
  r = await call('POST', `/api/adjustments/${adj5}/approve`, {}, 'c');
  assert(r.status === 200, '批准合规调整 adj5，原子更新计划');
  r = await call('GET', `/api/plans/${planA}`, null, 'i');
  assert(ymd(r.body.plan.start_date) === '2030-12-31' && ymd(r.body.plan.end_date) === '2031-01-01' &&
    r.body.plan.estimated_lux === 100, '计划展期已更新为拟改值');
  assert(!r.body.plan.pendingAdjustment, '通过后无待审申请');

  // 在新窗口内录入一条实测（draft，未作废）
  r = await call('POST', '/api/measurements', {
    planId: planA, startDate: '2030-12-31', startTime: '09:00',
    endDate: '2030-12-31', endTime: '12:00', actualLux: 120,
  }, 'c');
  assert(r.status === 201, '在更新后窗口内录入实测草稿');
  const adjMeasId = r.body.measurement.id;
  // 再次调整到不含该实测的窗口（2031-06-01 09-12）
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2031-06-01', endDate: '2031-06-01',
    periods: ['09:00-12:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '提交排除既有实测窗口的 adj6');
  const adj6 = r.body.adjustment.id;
  r = await call('POST', `/api/adjustments/${adj6}/approve`, {}, 'c');
  assert(r.status === 409, '含窗外未作废实测的调整批准被拒');
  assert(new RegExp(`实测 #${adjMeasId}`).test(r.body.error), '错误信息指出冲突实测');
  assert(r.body.details.conflicts.outsideMeasurements[0].id === adjMeasId,
    '结构化冲突明细包含冲突实测');
  await call('POST', `/api/adjustments/${adj6}/withdraw`, {}, 'i');

  // ---- 批准冲突：按年超额 ----
  const ex3 = await createExhibit('调整超额展品');
  await call('POST', `/api/exhibits/${ex3}/limits`, { year: 2030, limitLxh: 800 }, 'c');
  const planC = await submitPlan(ex3, '小额计划C', '2030-08-01', '2030-08-01',
    ['09:00-17:00'], 50); // 400
  await approvePlan(planC);
  // 申请把照度改为 200lx（仍 8h）=> 1600，超 2030 上限 800，超额 800
  r = await call('POST', '/api/adjustments', {
    planId: planC, startDate: '2030-08-01', endDate: '2030-08-01',
    periods: ['09:00-17:00'], estimatedLux: 200,
  }, 'i');
  assert(r.status === 201, '提交超额调整 adj7');
  const inAdjId = r.body.adjustment.id;
  assert(r.body.adjustment.preview.ok === false &&
    r.body.adjustment.preview.conflicts.overflows[0].year === 2030,
    '试算指出超额年份 2030');
  r = await call('POST', `/api/adjustments/${inAdjId}/approve`, {}, 'c');
  assert(r.status === 409, '超额调整批准被拒（409）');
  const o = r.body.details.conflicts.overflows.find((x) => x.year === 2030);
  assert(o && o.limit === 800 && o.newResidue === 1600 && o.projected === 1600 &&
    o.excess === 800, `超额明细数值正确：${JSON.stringify(o)}`);
  r = await call('GET', `/api/plans/${planC}`, null, 'i');
  assert(r.body.plan.estimated_lux === 50, '核对失败不改变计划（照度仍 50）');
  assert(r.body.plan.pendingAdjustment && r.body.plan.pendingAdjustment.id === inAdjId,
    '超额申请保持待审');
  // 提额后重新核对通过（同一份申请无需撤回重提）
  await call('POST', `/api/exhibits/${ex3}/limits`, { year: 2030, limitLxh: 2000 }, 'c');
  r = await call('POST', `/api/adjustments/${inAdjId}/approve`, {}, 'c');
  assert(r.status === 200, '提额后同一待审申请批准通过');
  r = await call('GET', `/api/plans/${planC}`, null, 'i');
  assert(r.body.plan.estimated_lux === 200, '计划照度更新为拟改值 200');

  // ---- 实测覆盖部分新窗口：以新窗口未被实测覆盖部分估算 ----
  // 删除上面的 draft 实测（草稿可删），改用已确认实测落在 A 当前窗口（2030-12-31~2031-01-01）
  await call('DELETE', `/api/measurements/${adjMeasId}`, null, 'c');
  // 2030-12-31 09:00-17:00 整段实测 100lx（确认，覆盖 2030 那天 8h）
  r = await call('POST', '/api/measurements', {
    planId: planA, startDate: '2030-12-31', startTime: '09:00',
    endDate: '2030-12-31', endTime: '17:00', actualLux: 100,
  }, 'c');
  assert(r.status === 201, '录入覆盖 2030 当天的实测草稿');
  const measFull = r.body.measurement.id;
  r = await call('POST', `/api/measurements/${measFull}/confirm`, {}, 'c');
  assert(r.status === 200, '确认实测（2030 占用改为实测 800）');
  // 拟改窗口不变（同窗口），批准一个“仅照度变化”的调整：新残余 2030=0（被覆盖），2031=800
  r = await call('POST', '/api/adjustments', {
    planId: planA, startDate: '2030-12-31', endDate: '2031-01-01',
    periods: ['09:00-17:00'], estimatedLux: 300,
  }, 'i');
  assert(r.status === 201, '提交照度调整 adj8');
  const adj8 = r.body.adjustment.id;
  const pv = r.body.adjustment.preview;
  assert((pv.newResidueYearly['2030'] || 0) === 0 && pv.newResidueYearly['2031'] === 2400,
    `新窗口已确认实测覆盖部分不估算：2030=0,2031=2400，实际 ${JSON.stringify(pv.newResidueYearly)}`);
  r = await call('POST', `/api/adjustments/${adj8}/approve`, {}, 'c');
  assert(r.status === 200, '含已确认实测覆盖的调整批准通过');
  // 2030 占用：实测 800 + B(400) = 1200（原 A 残余被实测替代，调整后仍为 0 残余）
  r = await call('GET', `/api/exhibits/${ex2}`, null, 'c');
  assert(r.body.years['2030'].used === 1200,
    `调整后 2030 占用=实测800+B400=1200，实际 ${r.body.years['2030'].used}`);
  assert(r.body.years['2031'].used === 2400, `2031 占用=新残余 2400，实际 ${r.body.years['2031'].used}`);

  // ---- 调整申请列表接口 ----
  r = await call('GET', '/api/adjustments?exhibitId=' + ex2 + '&status=approved', null, 'i');
  assert(r.status === 200 && r.body.adjustments.some((a) => a.id === adj5),
    '可按展品/状态查询已通过调整申请');
  r = await call('GET', '/api/adjustments?planId=' + planC, null, 'i');
  assert(r.body.adjustments.every((a) => a.planId === planC) &&
    r.body.adjustments.some((a) => a.status === 'approved'),
    '按计划查询调整历史');

  // =======================================================================
  // 下调年度上限：预演 → 携凭证提交；旧接口直接修改；占用变化拒绝
  // =======================================================================
  const exL = await createExhibit('下调额度展品');
  await call('POST', `/api/exhibits/${exL}/limits`, { year: 2026, limitLxh: 10000 }, 'c');
  await call('POST', `/api/exhibits/${exL}/limits`, { year: 2032, limitLxh: 10000 }, 'c');

  // 已开始的已批准计划（2026 墙上时间 3 月，当前 2026-10，必已开始）：8h*100=800
  const pStarted = await submitPlan(exL, '已开始计划', '2026-03-01', '2026-03-01',
    ['09:00-17:00'], 100);
  await approvePlan(pStarted);
  // 2032 年尚未开始的计划两条，各 800
  const pFut1 = await submitPlan(exL, '未来计划1', '2032-06-01', '2032-06-01',
    ['09:00-17:00'], 100);
  const pFut2 = await submitPlan(exL, '未来计划2', '2032-07-01', '2032-07-01',
    ['09:00-17:00'], 100);
  await approvePlan(pFut1);
  await approvePlan(pFut2);

  // ---- 预演：越权 / 输入 / 非下调 / 未登记年份 ----
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2032, limitLxh: 800 }, 'i');
  assert(r.status === 403, '布展员不能预演下调（越权）');
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2032, limitLxh: -5 }, 'c');
  assert(r.status === 400 && /正数/.test(r.body.error), '非正上限预演报错');
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2032, limitLxh: 12000 }, 'c');
  assert(r.status === 400 && /不属于下调/.test(r.body.error), '拟定上限不低于现行上限被拒');
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2099, limitLxh: 100 }, 'c');
  assert(r.status === 400 && /尚未登记/.test(r.body.error), '未登记上限的年份不能下调预演');

  // ---- 预演不改状态：2032 降到 800，used=1600，超额 800 ----
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2032, limitLxh: 800 }, 'c');
  assert(r.status === 200, '预演成功');
  let lpv = r.body.preview;
  assert(lpv.currentLimit === 10000 && lpv.proposedLimit === 800 && lpv.used === 1600 &&
    lpv.excess === 800 && lpv.over === true,
    `预演数值正确：${JSON.stringify({ c: lpv.currentLimit, u: lpv.used, e: lpv.excess })}`);
  assert(lpv.confirmedMeasurements.length === 0, '该年无已确认实测');
  assert(lpv.planResidues.length === 2 &&
    lpv.planResidues.every((p) => p.yearResidue === 800 && p.notStarted),
    '列出两条未开始计划各 800 残余');
  assert(lpv.flagCandidates.length === 2 &&
    lpv.flagCandidates.map((p) => p.id).sort().join(',') === [pFut1, pFut2].sort().join(','),
    '两条未开始计划都在转待复核候选中');
  assert(typeof lpv.token === 'string' && lpv.token.length >= 32, '返回预演凭证');
  // 预演后状态不变
  r = await call('GET', `/api/exhibits/${exL}`, null, 'i');
  assert(r.body.years['2032'].limit === 10000, '预演不修改上限');
  assert(r.body.plans.find((p) => p.id === pFut1).status === 'approved',
    '预演不修改计划状态');

  // ---- 无凭证 / 错字段提交被拒（字段类 400 不消耗凭证，可改正后重试）----
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2032, limitLxh: 800 }, 'c');
  assert(r.status === 400 && /预演/.test(r.body.error), '缺少凭证拒绝提交');
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2032, limitLxh: 900, token: lpv.token }, 'c');
  assert(r.status === 400 && /不一致/.test(r.body.error), '凭证与拟定上限不一致被拒');
  // 字段不符不消耗凭证：原凭证按正确字段仍可通过状态校验（这里直接用于成功提交验证一次性语义）
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2032, limitLxh: 800, token: lpv.token }, 'c');
  assert(r.status === 200, '字段类错误不消耗凭证，原凭证仍可成功提交');
  // 成功提交后凭证已被消耗，重放被拒
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2032, limitLxh: 800, token: lpv.token }, 'c');
  assert(r.status === 400 && /已使用或不存在/.test(r.body.error), '凭证一次性：成功后重放被拒');

  // 提交后两计划已转待复核，先恢复现场以便后续场景：提额并复核回 approved
  await call('POST', `/api/exhibits/${exL}/limits`, { year: 2032, limitLxh: 10000 }, 'c');
  await call('POST', `/api/plans/${pFut1}/approve`, {}, 'c');
  await call('POST', `/api/plans/${pFut2}/approve`, {}, 'c');

  // ---- 再次预演 + 提交下调：覆盖上面未走的成功路径断言 ----
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2032, limitLxh: 800 }, 'c');
  lpv = r.body.preview;
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2032, limitLxh: 800, token: lpv.token }, 'c');
  assert(r.status === 200, '携凭证下调成功');
  assert(r.body.years['2032'].limit === 800 && r.body.years['2032'].used === 1600 &&
    r.body.years['2032'].over === true, '下调后上限 800、已用 1600、显示超限');
  assert(r.body.overflows[0].excess === 800 && r.body.overflows[0].previousLimit === 10000,
    '成功响应附带超额与旧上限');
  const st1 = r.body.plans.find((p) => p.id === pFut1);
  const st2 = r.body.plans.find((p) => p.id === pFut2);
  assert(st1.status === 'pending_review' && st2.status === 'pending_review',
    '两条未开始计划转为待复核');
  assert(/上限下调/.test(st1.review_reason || '') && /超额/.test(st1.review_reason || ''),
    '待复核原因写明上限下调与超额：' + st1.review_reason);
  // 原审批保留：approved_by/approved_at 仍在（详情接口带 approver_name）
  assert(st1.approved_by != null, '原审批人保留');

  // ---- 超额未解除时复核沿用现有额度校验，仍被拒；不删除占用/不自动取消 ----
  r = await call('POST', `/api/plans/${pFut1}/approve`, {}, 'c');
  assert(r.status === 409, '超额状态下待复核计划复核通过被拒');
  r = await call('GET', `/api/exhibits/${exL}`, null, 'i');
  assert(r.body.plans.find((p) => p.id === pFut1).status === 'pending_review' &&
    r.body.years['2032'].used === 1600,
    '复核被拒不删除占用、计划仍待复核');

  // ---- 占用已变化则携旧凭证拒绝并返回最新结果（含新凭证）----
  // 先提额回 10000，复核通过 pFut1（占用/状态变化），再预演降到 800，
  // 随后又批准 pFut2 复核，使占用变化（本例占用数值不变但状态/指纹变化）；
  // 更直接的变化：预演后登记一条已确认实测会改变占用。先准备一条新计划以便录实测。
  await call('POST', `/api/exhibits/${exL}/limits`, { year: 2032, limitLxh: 100000 }, 'c');
  await call('POST', `/api/plans/${pFut1}/approve`, {}, 'c'); // pFut1 -> approved
  await call('POST', `/api/plans/${pFut2}/approve`, {}, 'c'); // pFut2 -> approved

  // 新的已批准未开始计划（2032-09-01 09-17，100lx = 800），用于录入实测改变占用
  const pMeas = await submitPlan(exL, '实测承载计划', '2032-09-01', '2032-09-01',
    ['09:00-17:00'], 100);
  await approvePlan(pMeas);

  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2032, limitLxh: 2000 }, 'c');
  assert(r.status === 200, '再次预演（used=2400，超额 400）');
  const staleToken = r.body.preview.token;
  assert(r.body.preview.used === 2400 && r.body.preview.excess === 400,
    `预演 used=2400/excess=400，实际 ${r.body.preview.used}/${r.body.preview.excess}`);

  // 预演后插入一条已确认实测：2032-09-01 09-17 实测 200lx = 1600，替代该计划 800 估算
  r = await call('POST', '/api/measurements', {
    planId: pMeas, startDate: '2032-09-01', startTime: '09:00',
    endDate: '2032-09-01', endTime: '17:00', actualLux: 200,
  }, 'c');
  assert(r.status === 201, '预演后录入实测草稿');
  const mNew = r.body.measurement.id;
  r = await call('POST', `/api/measurements/${mNew}/confirm`, {}, 'c');
  assert(r.status === 200, '确认实测（占用变化，且 100000 上限下不触发转复核）');

  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2032, limitLxh: 2000, token: staleToken }, 'c');
  assert(r.status === 409 && /已变化/.test(r.body.error), '占用变化后旧凭证提交被拒（409）');
  const freshPv = r.body.details.preview;
  assert(freshPv && freshPv.token && freshPv.token !== staleToken,
    '拒绝时返回最新预演结果与新凭证');
  assert(freshPv.used === 3200 && freshPv.excess === 1200,
    `最新结果 used=3200（1600 实测 + 两条 800），实际 ${freshPv.used}`);
  assert(freshPv.confirmedMeasurements.some((m) => m.id === mNew && m.yearDose === 1600),
    '最新结果列出新增已确认实测');
  // 上限未被修改
  r = await call('GET', `/api/exhibits/${exL}`, null, 'i');
  assert(r.body.years['2032'].limit === 100000, '拒绝后上限保持不变');

  // 用返回的新凭证可直接提交
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2032, limitLxh: 2000, token: freshPv.token }, 'c');
  assert(r.status === 200, '最新结果携带的新凭证可成功提交');
  assert(r.body.years['2032'].limit === 2000, '新上限 2000 生效');
  // 已确认实测与审批保留
  assert(r.body.measurements.some((m) => m.id === mNew && m.status === 'confirmed'),
    '已确认实测保留');

  // ---- 预演后“额度本身”被他人改动（占用未变），同样拒绝 ----
  const exQ = await createExhibit('额度被改展品');
  await call('POST', `/api/exhibits/${exQ}/limits`, { year: 2033, limitLxh: 5000 }, 'c');
  const pQ = await submitPlan(exQ, 'Q计划', '2033-01-01', '2033-01-01',
    ['09:00-17:00'], 100); // 800
  await approvePlan(pQ);
  r = await call('POST', `/api/exhibits/${exQ}/limits/preview`,
    { year: 2033, limitLxh: 500 }, 'c');
  const qToken = r.body.preview.token;
  assert(r.body.preview.used === 800 && r.body.preview.excess === 300, '预演超额 300');
  // 他人经旧接口把上限改为 4000（占用未变，额度变了）
  await call('POST', `/api/exhibits/${exQ}/limits`, { year: 2033, limitLxh: 4000 }, 'c');
  r = await call('POST', `/api/exhibits/${exQ}/limits/lower`,
    { year: 2033, limitLxh: 500, token: qToken }, 'c');
  assert(r.status === 409 && /已变化/.test(r.body.error), '额度被改后旧凭证被拒');
  assert(r.body.details.preview.currentLimit === 4000,
    '新结果反映最新现行上限 4000');

  // ---- 已开始计划不转状态，剩余超额如实显示 ----
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2026, limitLxh: 100 }, 'c');
  assert(r.status === 200, '2026 下调预演');
  lpv = r.body.preview;
  assert(lpv.used === 800 && lpv.excess === 700, '2026 已用 800，超额 700');
  assert(lpv.flagCandidates.length === 0, '已开始计划不在转待复核候选中');
  assert(lpv.startedResiduePlans.length === 1 && lpv.startedResiduePlans[0].id === pStarted,
    '已开始但仍占残余的计划单独列出');
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2026, limitLxh: 100, token: lpv.token }, 'c');
  assert(r.status === 200, '2026 下调成功');
  assert(r.body.overflows[0].excess === 700, '剩余超额如实返回');
  assert(!r.body.flaggedPlans.some((p) => p.id === pStarted), '已开始计划不转状态');
  assert(r.body.plans.find((p) => p.id === pStarted).status === 'approved',
    '已开始计划仍为已批准');
  assert(r.body.years['2026'].over === true && r.body.years['2026'].used === 800,
    '页面数据如实显示 2026 超限 700');

  // ---- 不超额的下调：直接成功，不产生转待复核 ----
  await call('POST', `/api/exhibits/${exL}/limits`, { year: 2026, limitLxh: 5000 }, 'c'); // 先提额
  r = await call('POST', `/api/exhibits/${exL}/limits/preview`,
    { year: 2026, limitLxh: 1000 }, 'c');
  assert(r.body.preview.over === false && r.body.preview.remaining === 200,
    '下调到 1000（used=800）不超额，剩余 200');
  r = await call('POST', `/api/exhibits/${exL}/limits/lower`,
    { year: 2026, limitLxh: 1000, token: r.body.preview.token }, 'c');
  assert(r.status === 200 && r.body.overflows.length === 0, '不超额下调成功且无超额明细');
  assert(r.body.plans.find((p) => p.id === pStarted).status === 'approved',
    '不超额时计划状态不变');

  // ---- 旧接口沿用旧字段直接修改：同事务即时重算，成功响应兼容（仍为展品详情）----
  r = await call('POST', `/api/exhibits/${exL}/limits`,
    { year: 2026, limitLxh: 500 }, 'c');
  assert(r.status === 200 && r.body.exhibit && r.body.years && r.body.plans,
    '旧接口成功响应仍是展品详情（兼容）');
  assert(r.body.years['2026'].limit === 500 && r.body.overflows[0].excess === 300,
    '旧接口同事务重算：上限 500，超额 300');
  assert(r.body.flaggedPlans.length === 0, '旧接口下调时已开始计划同样不转状态');
  // 旧接口上调/登记不产生下调核算字段
  r = await call('POST', `/api/exhibits/${exL}/limits`,
    { year: 2026, limitLxh: 9000 }, 'c');
  assert(r.status === 200 && r.body.limitLowered === null &&
    r.body.overflows.length === 0 && r.body.flaggedPlans.length === 0,
    '旧接口上调不附带下调结果');
  r = await call('GET', `/api/exhibits`, null, 'i');
  assert(r.body.exhibits.some((e) => e.id === exL && e.years['2026']),
    '额度列表查询响应保持兼容');

  // =======================================================================
  // 成对核准调整申请（保管员）：两份待审申请同时替换原窗（互换/协同挪动档期）
  // =======================================================================
  const exP = await createExhibit('成对核准展品');
  await call('POST', `/api/exhibits/${exP}/limits`, { year: 2030, limitLxh: 5000 }, 'c');
  await call('POST', `/api/exhibits/${exP}/limits`, { year: 2031, limitLxh: 5000 }, 'c');

  // 三条已批准未开始计划：D 2030-03-01 / E 2030-04-01 / F 2030-05-01，各 09-17 100lx = 800
  const planD = await submitPlan(exP, '成对计划D', '2030-03-01', '2030-03-01', ['09:00-17:00'], 100);
  const planE = await submitPlan(exP, '成对计划E', '2030-04-01', '2030-04-01', ['09:00-17:00'], 100);
  const planF = await submitPlan(exP, '成对计划F', '2030-05-01', '2030-05-01', ['09:00-17:00'], 100);
  await approvePlan(planD);
  await approvePlan(planE);
  await approvePlan(planF);

  const submitAdj = async (planId, startDate, endDate, periods, lux) => {
    const rr = await call('POST', '/api/adjustments',
      { planId, startDate, endDate, periods, estimatedLux: lux }, 'i');
    assert(rr.status === 201, `提交调整申请（计划 #${planId}）：${rr.status} ${rr.body && rr.body.error}`);
    return rr.body.adjustment.id;
  };

  // 互换档期：D → 04-01（E 的档期），E → 03-01（D 的档期）
  const adjD = await submitAdj(planD, '2030-04-01', '2030-04-01', ['09:00-17:00'], 100);
  const adjE = await submitAdj(planE, '2030-03-01', '2030-03-01', ['09:00-17:00'], 100);

  // 单份批准无法完成互换（D 的拟改窗撞上 E 的当前窗口），成对核准才能同时替换
  r = await call('POST', `/api/adjustments/${adjD}/approve`, {}, 'c');
  assert(r.status === 409 &&
    r.body.details.conflicts.overlappingPlans.some((p) => p.id === planE),
    '单份批准互换申请因撞上对方当前窗口被拒（409）');
  r = await call('GET', `/api/adjustments/${adjD}`, null, 'i');
  assert(r.body.adjustment.status === 'pending', '单份核对失败后申请保持待审');

  // ---- 组成性拒绝：编号无效 / 同一计划 / 跨展品 / 已结案 ----
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjD, adjE] }, 'i');
  assert(r.status === 403, '布展员不能成对试算（越权）');
  r = await call('POST', '/api/adjustments/pair/approve', { adjustmentIds: [adjD, adjE] }, 'i');
  assert(r.status === 403, '布展员不能成对核准（越权）');
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjD, adjD] }, 'c');
  assert(r.status === 400 && /必须不同/.test(r.body.error), '两个相同申请编号被拒绝');
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjD] }, 'c');
  assert(r.status === 400, '只给一个申请编号被拒绝');
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjD, 999999] }, 'c');
  assert(r.status === 400 && /不存在/.test(r.body.error), '不存在的申请编号被拒绝');

  // 跨展品：planB（ex2）提交一份待审申请 adjX
  const adjX = await submitAdj(planB, '2030-06-03', '2030-06-03', ['18:00-22:00'], 100);
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjD, adjX] }, 'c');
  assert(r.status === 400 && /跨展品/.test(r.body.error), '跨展品的两份申请被拒绝');
  await call('POST', `/api/adjustments/${adjX}/withdraw`, {}, 'i');

  // 同一计划：planF 先提交 adjF1 并驳回，再提交 adjF2（待审）
  const adjF1 = await submitAdj(planF, '2030-05-02', '2030-05-02', ['09:00-17:00'], 100);
  r = await call('POST', `/api/adjustments/${adjF1}/reject`, { reason: '档期再议' }, 'c');
  assert(r.status === 200, '驳回 adjF1');
  const adjF2 = await submitAdj(planF, '2030-05-03', '2030-05-03', ['09:00-17:00'], 100);
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjF1, adjF2] }, 'c');
  assert(r.status === 400 && /同一计划/.test(r.body.error), '关联同一计划的两份申请被拒绝');
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjD, adjF1] }, 'c');
  assert(r.status === 400 && /已结案/.test(r.body.error), '已结案的申请被拒绝');
  await call('POST', `/api/adjustments/${adjF2}/withdraw`, {}, 'i');

  // ---- 成对试算通过：两份拟改窗同时替换原窗 ----
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjD, adjE] }, 'c');
  assert(r.status === 200 && r.body.pairPreview, '成对试算返回结果');
  let pp = r.body.pairPreview;
  assert(pp.ok === true, '互换试算通过');
  assert(pp.adjustments.length === 2 && pp.adjustments[0].original && pp.adjustments[1].original,
    '试算结果带两份申请的原值');
  const y2030 = pp.yearlyReport['2030'];
  assert(y2030 && y2030.usedByOthers === 800 && y2030.oldResidueTotal === 1600 &&
    y2030.newResidueTotal === 1600 && y2030.projected === 2400,
    `2030 年报告：其他占用 800、旧残余合计 1600、拟改合计 1600、合计 2400，实际 ${JSON.stringify(y2030)}`);
  assert(y2030.contributions.length === 2 &&
    y2030.contributions.every((ct) => ct.newResidue === 800),
    '按年列出两计划各自贡献');

  // ---- 成对核准成功：原子更新两条计划、结案两份申请 ----
  r = await call('POST', '/api/adjustments/pair/approve', { adjustmentIds: [adjD, adjE] }, 'c');
  assert(r.status === 200, `成对核准成功（实际 ${r.status} ${r.body && r.body.error}）`);
  assert(r.body.exhibit && r.body.years && r.body.plans, '成功响应仍为展品详情（兼容）');
  assert(r.body.pairApproval &&
    r.body.pairApproval.adjustmentIds.join(',') === `${adjD},${adjE}`,
    '成功响应附带成对核准信息');
  r = await call('GET', `/api/plans/${planD}`, null, 'i');
  assert(ymd(r.body.plan.start_date) === '2030-04-01' && !r.body.plan.pendingAdjustment,
    '计划D 已换到 04-01 且无待审申请');
  r = await call('GET', `/api/plans/${planE}`, null, 'i');
  assert(ymd(r.body.plan.start_date) === '2030-03-01', '计划E 已换到 03-01');
  r = await call('GET', `/api/adjustments/${adjD}`, null, 'i');
  assert(r.body.adjustment.status === 'approved', '申请 adjD 已结案为通过');
  r = await call('GET', `/api/adjustments/${adjE}`, null, 'i');
  assert(r.body.adjustment.status === 'approved', '申请 adjE 已结案为通过');
  r = await call('GET', `/api/exhibits/${exP}`, null, 'i');
  assert(r.body.years['2030'].used === 2400, '互换后 2030 占用不变（2400）');

  // ---- 失败原子性：任一核对不通过，两份申请仍待审、计划与额度不变 ----
  const planH = await submitPlan(exP, '成对计划H', '2030-06-01', '2030-06-01', ['09:00-17:00'], 100);
  const planI = await submitPlan(exP, '成对计划I', '2030-07-01', '2030-07-01', ['09:00-17:00'], 100);
  await approvePlan(planH);
  await approvePlan(planI);
  // 2030 used = 2400 + 1600 = 4000
  const adjH = await submitAdj(planH, '2030-05-01', '2030-05-01', ['09:00-17:00'], 100); // 撞 F
  const adjI = await submitAdj(planI, '2030-07-02', '2030-07-02', ['09:00-17:00'], 100); // 合规
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjH, adjI] }, 'c');
  pp = r.body.pairPreview;
  assert(pp.ok === false && pp.conflicts.overlappingPlans.some(
    (x) => x.adjustmentId === adjH && x.other.id === planF),
    '试算指出拟改窗与其他已批准计划 F 重叠');
  r = await call('POST', '/api/adjustments/pair/approve', { adjustmentIds: [adjH, adjI] }, 'c');
  assert(r.status === 409 && /成对计划F/.test(r.body.error), '成对核准因重叠被拒并指出冲突计划');
  r = await call('GET', `/api/adjustments/${adjH}`, null, 'i');
  assert(r.body.adjustment.status === 'pending', '失败后申请 adjH 仍待审');
  r = await call('GET', `/api/adjustments/${adjI}`, null, 'i');
  assert(r.body.adjustment.status === 'pending', '失败后申请 adjI 仍待审');
  r = await call('GET', `/api/plans/${planH}`, null, 'i');
  assert(ymd(r.body.plan.start_date) === '2030-06-01', '失败后计划H 不变');
  r = await call('GET', `/api/exhibits/${exP}`, null, 'i');
  assert(r.body.years['2030'].used === 4000, '失败后 2030 占用不变（4000）');

  // ---- 两份拟改窗彼此重叠 ----
  await call('POST', `/api/adjustments/${adjH}/withdraw`, {}, 'i');
  await call('POST', `/api/adjustments/${adjI}/withdraw`, {}, 'i');
  const adjH2 = await submitAdj(planH, '2030-08-01', '2030-08-01', ['09:00-17:00'], 100);
  const adjI2 = await submitAdj(planI, '2030-08-01', '2030-08-01', ['12:00-18:00'], 100);
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjH2, adjI2] }, 'c');
  assert(r.body.pairPreview.conflicts.pairOverlap === true, '试算标记两份拟改窗彼此重叠');
  r = await call('POST', '/api/adjustments/pair/approve', { adjustmentIds: [adjH2, adjI2] }, 'c');
  assert(r.status === 409 && r.body.details.conflicts.pairOverlap === true,
    '彼此重叠的成对核准被拒（409）');

  // ---- 计划已开始（直接用 service 以未来时刻评估；HTTP 层无法让待审申请关联的计划已开始）----
  const svc = require('../src/service');
  await dbModule.withTransaction(async (client) => {
    const { rows: adjs } = await client.query(
      'SELECT * FROM plan_adjustments WHERE id IN ($1, $2) ORDER BY id', [adjH2, adjI2]);
    const { rows: pls } = await client.query(
      'SELECT * FROM plans WHERE id IN ($1, $2) ORDER BY id', [planH, planI]);
    const evalR = await svc.evaluateAdjustmentPair(
      client, pls[0], adjs[0], pls[1], adjs[1], Date.UTC(2031, 0, 1));
    assert(!evalR.ok && evalR.conflicts.notStarted.length === 2,
      '评估时刻晚于开灯时刻时两条计划都标记为已开始');
  });
  await call('POST', `/api/adjustments/${adjH2}/withdraw`, {}, 'i');
  await call('POST', `/api/adjustments/${adjI2}/withdraw`, {}, 'i');

  // ---- 按年超额：列出年份、各计划贡献与超额量 ----
  const exR = await createExhibit('成对超额展品');
  await call('POST', `/api/exhibits/${exR}/limits`, { year: 2030, limitLxh: 2000 }, 'c');
  const planJ = await submitPlan(exR, '成对计划J', '2030-01-05', '2030-01-05', ['09:00-17:00'], 100);
  const planK = await submitPlan(exR, '成对计划K', '2030-02-05', '2030-02-05', ['09:00-17:00'], 100);
  await approvePlan(planJ);
  await approvePlan(planK);
  // J 照度 100→200（残余 800→1600），K 不变（800）：合计 2400 超 2000，超额 400
  const adjJ = await submitAdj(planJ, '2030-01-05', '2030-01-05', ['09:00-17:00'], 200);
  const adjK = await submitAdj(planK, '2030-02-05', '2030-02-05', ['09:00-17:00'], 100);
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjJ, adjK] }, 'c');
  pp = r.body.pairPreview;
  assert(pp.ok === false && pp.conflicts.overflows.length === 1, '试算指出 2030 超额');
  const ofr = pp.conflicts.overflows[0];
  assert(ofr.year === 2030 && ofr.limit === 2000 && ofr.projected === 2400 && ofr.excess === 400,
    `超额明细数值正确：${JSON.stringify(ofr)}`);
  const cJ = ofr.contributions.find((ct) => ct.planId === planJ);
  const cK = ofr.contributions.find((ct) => ct.planId === planK);
  assert(cJ && cJ.oldResidue === 800 && cJ.newResidue === 1600 &&
    cK && cK.oldResidue === 800 && cK.newResidue === 800,
    '超额明细列出各计划贡献（J 800→1600，K 800→800）');
  r = await call('POST', '/api/adjustments/pair/approve', { adjustmentIds: [adjJ, adjK] }, 'c');
  assert(r.status === 409 && r.body.details.conflicts.overflows[0].excess === 400,
    '超额成对核准被拒（409），明细含超额量');
  r = await call('GET', `/api/plans/${planJ}`, null, 'i');
  assert(r.body.plan.estimated_lux === 100 && r.body.plan.pendingAdjustment,
    '失败后计划J 照度不变且申请仍待审');
  // 提额后同一对申请直接通过
  await call('POST', `/api/exhibits/${exR}/limits`, { year: 2030, limitLxh: 3000 }, 'c');
  r = await call('POST', '/api/adjustments/pair/approve', { adjustmentIds: [adjJ, adjK] }, 'c');
  assert(r.status === 200, '提额后成对核准通过');
  r = await call('GET', `/api/exhibits/${exR}`, null, 'i');
  assert(r.body.years['2030'].used === 2400,
    `2030 占用=J1600+K800=2400，实际 ${r.body.years['2030'].used}`);

  // ---- 未登记上限的年份 ----
  const adjJ2 = await submitAdj(planJ, '2032-01-05', '2032-01-05', ['09:00-17:00'], 200);
  const adjK2 = await submitAdj(planK, '2030-02-06', '2030-02-06', ['09:00-17:00'], 100);
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjJ2, adjK2] }, 'c');
  assert(r.body.pairPreview.conflicts.missingLimits.includes(2032),
    '试算指出 2032 年未登记额度');
  r = await call('POST', '/api/adjustments/pair/approve', { adjustmentIds: [adjJ2, adjK2] }, 'c');
  assert(r.status === 409 && r.body.details.conflicts.missingLimits.includes(2032),
    '未登记年份的成对核准被拒（409）');
  await call('POST', `/api/adjustments/${adjJ2}/withdraw`, {}, 'i');
  await call('POST', `/api/adjustments/${adjK2}/withdraw`, {}, 'i');

  // ---- 未作废实测须仍落在各自新窗内 ----
  const exS = await createExhibit('成对实测展品');
  await call('POST', `/api/exhibits/${exS}/limits`, { year: 2030, limitLxh: 5000 }, 'c');
  const planM = await submitPlan(exS, '成对计划M', '2030-09-01', '2030-09-01', ['09:00-17:00'], 100);
  const planN = await submitPlan(exS, '成对计划N', '2030-10-01', '2030-10-01', ['09:00-17:00'], 100);
  await approvePlan(planM);
  await approvePlan(planN);
  r = await call('POST', '/api/measurements', {
    planId: planM, startDate: '2030-09-01', startTime: '09:00',
    endDate: '2030-09-01', endTime: '12:00', actualLux: 100,
  }, 'c');
  assert(r.status === 201, '录入计划M 窗口内实测');
  const measM = r.body.measurement.id;
  r = await call('POST', `/api/measurements/${measM}/confirm`, {}, 'c');
  assert(r.status === 200, '确认实测');
  // M 改到 09-02（不含该实测），N 改到 10-02（合规）
  const adjM = await submitAdj(planM, '2030-09-02', '2030-09-02', ['09:00-17:00'], 100);
  const adjN = await submitAdj(planN, '2030-10-02', '2030-10-02', ['09:00-17:00'], 100);
  r = await call('POST', '/api/adjustments/pair/preview', { adjustmentIds: [adjM, adjN] }, 'c');
  assert(r.body.pairPreview.conflicts.outsideMeasurements.some(
    (m) => m.id === measM && Number(m.planId) === planM),
    '试算指出计划M 的实测不在其新窗内');
  r = await call('POST', '/api/adjustments/pair/approve', { adjustmentIds: [adjM, adjN] }, 'c');
  assert(r.status === 409 && new RegExp(`实测 #${measM}`).test(r.body.error),
    '含窗外实测的成对核准被拒并指出实测');
  r = await call('GET', `/api/adjustments/${adjN}`, null, 'i');
  assert(r.body.adjustment.status === 'pending', '失败后合规一方的申请也仍待审');

  // =======================================================================
  // 联合核准（布展员/保管员试算，保管员一次批准 2~10 条待批准计划）
  // =======================================================================
  const exBatch = await createExhibit('联合核准展品');
  await call('POST', `/api/exhibits/${exBatch}/limits`, { year: 2040, limitLxh: 5000 }, 'c');
  await call('POST', `/api/exhibits/${exBatch}/limits`, { year: 2041, limitLxh: 5000 }, 'c');

  // b1: 2040-01-10 09-17 100lx = 800；b2: 2040-01-11 夜场 18-22 = 400
  // b3: 2040-01-12 09-17 = 800；b4: 2040-01-13（将与 b1 同窗的外部已批准计划冲突）
  const b1 = await submitPlan(exBatch, '联合计划1', '2040-01-10', '2040-01-10',
    ['09:00-17:00'], 100);
  const b2 = await submitPlan(exBatch, '联合计划2', '2040-01-11', '2040-01-11',
    ['18:00-22:00'], 100);
  const b3 = await submitPlan(exBatch, '联合计划3（跨年）', '2040-12-31', '2041-01-01',
    ['09:00-17:00'], 100); // 800 + 800
  const b4 = await submitPlan(exBatch, '联合计划4', '2040-01-13', '2040-01-13',
    ['09:00-17:00'], 100);

  // ---- 组成性校验：数量 / 重复 / 非整数 / 不存在 ----
  r = await call('POST', '/api/plans/batch/preview', { planIds: [b1] }, 'i');
  assert(r.status === 400 && /2 至 10/.test(r.body.error), '少于 2 条被拒绝');
  r = await call('POST', '/api/plans/batch/preview', { planIds: [b1, b1] }, 'i');
  assert(r.status === 400 && /互不相同/.test(r.body.error), '重复编号被拒绝');
  r = await call('POST', '/api/plans/batch/preview', { planIds: [b1, 'x'] }, 'i');
  assert(r.status === 400 && /正整数/.test(r.body.error), '非整数编号被拒绝');
  r = await call('POST', '/api/plans/batch/preview', { planIds: [b1, 999999] }, 'i');
  assert(r.status === 400 && /不存在/.test(r.body.error), '不存在的计划被拒绝');
  r = await call('POST', '/api/plans/batch/preview',
    { planIds: [b1, b2, b3, b4, b1, b2, b3, b4, b1, b2, b3] }, 'i');
  assert(r.status === 400, '超过 10 条被拒绝');

  // ---- 试算通过：逐条计划 + 各年原占用/新增/上限/合并 ----
  r = await call('POST', '/api/plans/batch/preview', { planIds: [b1, b2, b3, b4] }, 'i');
  assert(r.status === 200 && r.body.batchPreview, '布展员可联合试算');
  let bp = r.body.batchPreview;
  assert(bp.ok === true, '四条互不重叠计划试算通过');
  assert(bp.plans.length === 4, '列出每条计划');
  const item1 = bp.plans.find((p) => p.id === b1);
  assert(item1.batch.residueYearly['2040'] === 800,
    '计划1 2040 新增残余 800');
  const item3 = bp.plans.find((p) => p.id === b3);
  assert(item3.batch.residueYearly['2040'] === 800 && item3.batch.residueYearly['2041'] === 800,
    '跨年计划按年列出新增残余');
  assert(item1.batch.yearly['2040'].limit === 5000 &&
    item1.batch.yearly['2040'].usedByOthers === 0,
    '逐条年度行含上限与原占用');
  const bRep = bp.exhibits.find((e) => e.exhibitId === exBatch).yearlyReport;
  assert(bRep['2040'].groupResidue === 2800 && bRep['2040'].projected === 2800 &&
    bRep['2041'].groupResidue === 800,
    `按展品合并年度残余：2040=2800（800+400+800+800），2041=800，实际 ${JSON.stringify(bRep)}`);
  assert(bRep['2040'].contributions.length === 4, '超额/合并行列出各计划贡献');

  // 保管员同样可以试算
  r = await call('POST', '/api/plans/batch/preview', { planIds: [b1, b2] }, 'c');
  assert(r.status === 200 && r.body.batchPreview.ok === true, '保管员可联合试算');

  // ---- 组内同展品开灯窗彼此重叠 ----
  // b5 与 b1 同日同时段（提交允许，因为组外的 b1 仍为 submitted 不占用排期）
  const b5 = await submitPlan(exBatch, '联合计划5（撞1）', '2040-01-10', '2040-01-10',
    ['10:00-11:00'], 100);
  r = await call('POST', '/api/plans/batch/preview', { planIds: [b1, b5] }, 'i');
  assert(r.status === 200 && r.body.batchPreview.ok === false, '组内重叠试算标记不通过');
  assert(r.body.batchPreview.conflicts.internalOverlaps.some(
    (x) => x.planId === b1 && x.otherPlanId === b5),
    '结构化冲突指出组内重叠的一对计划');
  const f1 = r.body.batchPreview.plans.find((p) => p.id === b1);
  assert(f1.batch.conflicts.internalOverlaps.some((x) => x.otherPlanId === b5),
    '逐条计划带组内冲突标记');
  r = await call('POST', '/api/plans/batch/approve', { planIds: [b1, b5] }, 'c');
  assert(r.status === 409 && /彼此重叠/.test(r.body.error), '组内重叠联合核准被拒（409）');

  // ---- 与其他已批准/待复核计划重叠：b6 先与 b4 同窗提交（均 submitted 不拦截），再批准 b4 后组批 ----
  const b6 = await submitPlan(exBatch, '联合计划6（撞已批准）', '2040-01-13', '2040-01-13',
    ['12:00-13:00'], 100);
  await approvePlan(b4);
  r = await call('POST', '/api/plans/batch/preview', { planIds: [b1, b6] }, 'i');
  assert(r.body.batchPreview.conflicts.overlappingPlans.some(
    (x) => x.planId === b6 && x.other.id === b4),
    '试算指出与已批准计划 b4 重叠');
  r = await call('POST', '/api/plans/batch/approve', { planIds: [b1, b6] }, 'c');
  assert(r.status === 409 && /联合计划4/.test(r.body.error), '外部重叠联合核准被拒并指出冲突计划');

  // ---- 上限超额：2040 合并残余超限时整组拒绝 ----
  await call('POST', `/api/exhibits/${exBatch}/limits`, { year: 2040, limitLxh: 2000 }, 'c');
  r = await call('POST', '/api/plans/batch/preview', { planIds: [b1, b2, b3] }, 'c');
  assert(r.status === 200 && r.body.batchPreview.ok === false, '超额试算不通过');
  const bo = r.body.batchPreview.conflicts.overflows.find((o) => o.year === 2040);
  assert(bo && bo.limit === 2000 && bo.groupResidue === 2000 && bo.projected === 2800 &&
    bo.excess === 800, `2040 超额 800：${JSON.stringify(bo)}`);
  assert(bo.contributions.some((ct) => ct.planId === b1 && ct.residue === 800) &&
    bo.contributions.some((ct) => ct.planId === b3 && ct.residue === 800),
    '超额行列出各计划按年贡献');
  r = await call('POST', '/api/plans/batch/approve', { planIds: [b1, b2, b3] }, 'c');
  assert(r.status === 409 && /2040 年/.test(r.body.error) && /超额 800/.test(r.body.error),
    '超额联合核准被拒并指出年份与超额量');
  // 提额后可批
  await call('POST', `/api/exhibits/${exBatch}/limits`, { year: 2040, limitLxh: 5000 }, 'c');

  // ---- 未登记上限的年份：只登记 2042 上限的展品，跨年计划组批报缺失年份 ----
  const exBatch2 = await createExhibit('联合核准展品2');
  await call('POST', `/api/exhibits/${exBatch2}/limits`, { year: 2042, limitLxh: 5000 }, 'c');
  const c1 = await submitPlan(exBatch2, '缺额跨年计划', '2042-12-31', '2043-01-01',
    ['09:00-17:00'], 100);
  const c2 = await submitPlan(exBatch2, '缺额同年计划', '2042-06-01', '2042-06-01',
    ['09:00-17:00'], 100);
  r = await call('POST', '/api/plans/batch/preview', { planIds: [c1, c2] }, 'i');
  assert(r.body.batchPreview.conflicts.missingLimits.some(
    (x) => x.planId === c1 && x.year === 2043),
    '试算指出 2043 年未登记额度');
  r = await call('POST', '/api/plans/batch/approve', { planIds: [c1, c2] }, 'c');
  assert(r.status === 409 && /2043/.test(r.body.error), '未登记年份联合核准被拒');

  // ---- 失败不变：被拒后组内计划仍为 submitted，占用不含它们，审计无联合核准记录 ----
  r = await call('GET', `/api/exhibits/${exBatch}`, null, 'i');
  assert([b1, b2, b3].every((pid) =>
    r.body.plans.find((p) => p.id === pid).status === 'submitted'),
    '核对失败后组内计划仍待批准');
  assert(!r.body.sources.some((s) => s.kind === 'plan' && [b1, b2, b3].includes(s.id)),
    '失败后待批准计划不占额度');

  // ---- 状态重核：试算后其中一条被单条批准/驳回/取消，提交时整组拒绝 ----
  await call('POST', `/api/plans/${b2}/reject`, {}, 'c');
  r = await call('POST', '/api/plans/batch/approve', { planIds: [b1, b2, b3] }, 'c');
  assert(r.status === 409 && r.body.details.conflicts.notSubmitted.some(
    (x) => x.planId === b2 && x.status === 'rejected'),
    '提交时重新核对计划状态：已驳回的导致整组 409');
  // 重新提交一条待批准计划替代 b2
  const b2b = await submitPlan(exBatch, '联合计划2b', '2040-01-11', '2040-01-11',
    ['18:00-22:00'], 100);

  // ---- 布展员不能提交联合核准 ----
  r = await call('POST', '/api/plans/batch/approve', { planIds: [b1, b2b, b3] }, 'i');
  assert(r.status === 403, '布展员不能提交联合核准');

  // ---- 成功：一次批准三条；成功响应为展品详情（兼容），另附 batchApproval ----
  r = await call('POST', '/api/plans/batch/approve', { planIds: [b1, b2b, b3] }, 'c');
  assert(r.status === 200, `联合核准成功（实际 ${r.status} ${r.body && r.body.error}）`);
  assert(r.body.exhibit && r.body.years && r.body.plans,
    '单展品成功响应仍为展品详情（兼容）');
  assert(r.body.batchApproval && r.body.batchApproval.planIds.join(',') === [b1, b2b, b3].join(','),
    '成功响应附带 batchApproval');
  assert(r.body.years['2040'].used === 2800 && r.body.years['2041'].used === 800,
    `批准后 2040 占用 2800（b4 800 + b1 800 + b2b 400 + b3 800）、2041=800，实际 ${r.body.years['2040'].used}`);
  for (const pid of [b1, b2b, b3]) {
    const row = r.body.plans.find((p) => p.id === pid);
    assert(row.status === 'approved' && row.approved_by != null,
      `计划 #${pid} 已一次批准且保留审批人`);
  }

  // 审计：逐条 + 汇总
  r = await call('GET', '/api/audit?limit=1000', null, 'c');
  assert(r.body.events.some((e) => e.action === 'plan.batch_approve'),
    '审计记录联合核准汇总事件');
  const itemAudits = r.body.events.filter((e) => e.action === 'plan.batch_approve_item');
  assert(itemAudits.map((e) => Number(e.target_id)).sort((a, b) => a - b)
    .join(',') === [b1, b2b, b3].sort((a, b) => a - b).join(','),
    '审计逐条记录组内每条计划的批准');

  // 已批准计划再次组批 -> notSubmitted
  r = await call('POST', '/api/plans/batch/approve', { planIds: [b1, b4] }, 'c');
  assert(r.status === 409 && r.body.details.conflicts.notSubmitted.length === 2,
    '已批准计划不能再次参与联合核准');

  // ---- 实时占用重核：试算通过后并发改动额度/占用，提交返回最新冲突（整组不变）----
  const bd1 = await submitPlan(exBatch2, '重核计划1', '2042-02-01', '2042-02-01',
    ['09:00-17:00'], 100); // 800
  const bd2 = await submitPlan(exBatch2, '重核计划2', '2042-03-01', '2042-03-01',
    ['09:00-17:00'], 100); // 800
  await call('POST', `/api/exhibits/${exBatch2}/limits`, { year: 2043, limitLxh: 5000 }, 'c');
  r = await call('POST', '/api/plans/batch/preview', { planIds: [c1, c2, bd1, bd2] }, 'c');
  assert(r.status === 200 && r.body.batchPreview.ok === true, '补登记额度后试算通过');
  // 试算后把 2042 上限下调到仅 800（无未开始计划转复核影响本批，因本批仍 submitted）
  await call('POST', `/api/exhibits/${exBatch2}/limits`, { year: 2042, limitLxh: 800 }, 'c');
  r = await call('POST', '/api/plans/batch/approve', { planIds: [c1, c2, bd1, bd2] }, 'c');
  assert(r.status === 409, '提交时实时重算占用：额度已下调，整组被拒');
  // 此时 c2 仍待批准：原占用 0，组内 4 条 2042 残余各 800 = 3200，超额 2400
  const do2042 = r.body.details.conflicts.overflows.find((o) => o.year === 2042);
  assert(do2042 && do2042.limit === 800 && do2042.groupResidue === 3200 && do2042.excess === 2400,
    `409 明细为最新额度下的核算（800/3200）：${JSON.stringify(do2042)}`);

  // ---- 停灯扣减口径进入合并校验：先恢复额度并批准两条，再预置停灯后组批 ----
  await call('POST', `/api/exhibits/${exBatch2}/limits`, { year: 2042, limitLxh: 5000 }, 'c');
  // 批准 c2（2042-06-01 09-17，800）作为已占用基线
  r = await call('POST', `/api/plans/${c2}/approve`, {}, 'c');
  assert(r.status === 200, '单条批准 c2 作为占用基线');
  // 给 c2 预置停灯 2042-06-01 10:00-12:00（2h×100=200），其残余变 600
  await dbModule.withTransaction(async (client) => {
    const exRow = await client.query('SELECT exhibit_id FROM plans WHERE id = $1', [c2]);
    await client.query(
      `INSERT INTO blackouts (plan_id, exhibit_id, start_ts, end_ts, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [c2, exRow.rows[0].exhibit_id,
        new Date(dosing.wallToTs('2042-06-01', 600)),
        new Date(dosing.wallToTs('2042-06-01', 720)),
        '联合核准前停灯']
    );
  });
  // 上限 1400：原占用 c2 残余 600 + 组内 c1(2042 部分 800)+bd1(800)+bd2(800)=2400 → 超 1600；
  // 若漏扣停灯（原占用按 800）超额会是 1800
  await call('POST', `/api/exhibits/${exBatch2}/limits`, { year: 2042, limitLxh: 1400 }, 'c');
  r = await call('POST', '/api/plans/batch/preview', { planIds: [c1, bd1, bd2] }, 'c');
  const bkOverflow = r.body.batchPreview.conflicts.overflows.find((o) => o.year === 2042);
  assert(bkOverflow && bkOverflow.usedByOthers === 600 && bkOverflow.excess === 1600,
    `合并校验原占用含停灯扣减（600），超额 1600：${JSON.stringify(bkOverflow)}`);

  // ---- 跨展品联合核准：一次锁多件展品，全部通过才一起批准 ----
  const exCross = await createExhibit('联合核准跨展品');
  await call('POST', `/api/exhibits/${exCross}/limits`, { year: 2044, limitLxh: 5000 }, 'c');
  const x1 = await submitPlan(exCross, '跨展品计划X', '2044-05-01', '2044-05-01',
    ['09:00-17:00'], 100);
  await call('POST', `/api/exhibits/${exBatch2}/limits`, { year: 2042, limitLxh: 5000 }, 'c');
  r = await call('POST', '/api/plans/batch/approve', { planIds: [c1, bd1, bd2, x1] }, 'c');
  assert(r.status === 200, `跨展品联合核准成功（实际 ${r.status} ${r.body && r.body.error}）`);
  assert(r.body.exhibitDetails && r.body.exhibitDetails.length === 2,
    '跨展品成功响应返回各展品详情');
  assert(r.body.batchApproval.exhibitIds.sort((a, b) => a - b)
    .join(',') === [exBatch2, exCross].sort((a, b) => a - b).join(','),
    'batchApproval 标注涉及展品');
  r = await call('GET', `/api/exhibits/${exCross}`, null, 'i');
  assert(r.body.years['2044'].used === 800 &&
    r.body.plans.find((p) => p.id === x1).status === 'approved',
    '跨展品组内计划同时批准');
  r = await call('GET', `/api/exhibits/${exBatch2}`, null, 'i');
  assert([c1, bd1, bd2].every((pid) =>
    r.body.plans.find((p) => p.id === pid).status === 'approved'),
    '跨展品组另一展品的计划也已批准');

  // ---- 跨展品组中一件展品冲突：整组（含另一件展品）不变 ----
  const y1 = await submitPlan(exCross, '跨展品冲突Y', '2044-06-01', '2044-06-01',
    ['09:00-17:00'], 100);
  const y2 = await submitPlan(exBatch2, '缺额年计划Y2', '2050-01-01', '2050-01-01',
    ['09:00-17:00'], 100); // 2050 无上限
  r = await call('POST', '/api/plans/batch/approve', { planIds: [y1, y2] }, 'c');
  assert(r.status === 409 && /2050/.test(r.body.error), '跨展品组一件冲突整组被拒');
  r = await call('GET', `/api/exhibits/${exCross}`, null, 'i');
  assert(r.body.plans.find((p) => p.id === y1).status === 'submitted',
    '跨展品失败后无冲突展品的计划也保持待批准');

  // =======================================================================
  // 停灯（blackout）登记：保管员登记已发生停灯时段，仅扣估算、不动实测/排期
  // 使用动态日期（基于当前墙上时间），保证“结束不晚于当前时间”可测
  // =======================================================================
  const config2 = require('../src/config');
  const dosing2 = require('../src/dosing');
  // 当前墙上时间的 {ymd,minute}
  const wallNow = dosing2.tsToWall(Date.now());
  const wallDaysAgo = (n) => dosing2.tsToWall(Date.now() - n * 86400000);
  const wallDaysAhead = (n) => dosing2.tsToWall(Date.now() + n * 86400000);
  const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  void config2;

  const exBk = await createExhibit('停灯展品');
  const yNow = Number(wallNow.ymd.slice(0, 4));
  await call('POST', `/api/exhibits/${exBk}/limits`, { year: yNow - 1, limitLxh: 100000 }, 'c');
  await call('POST', `/api/exhibits/${exBk}/limits`, { year: yNow, limitLxh: 100000 }, 'c');
  await call('POST', `/api/exhibits/${exBk}/limits`, { year: yNow + 1, limitLxh: 100000 }, 'c');

  // 承载计划：覆盖昨天/今天/明天，每天 09:00-17:00，100lx（计划已开始）
  const d0 = wallDaysAgo(1).ymd;
  const d1 = wallNow.ymd;
  const d2 = wallDaysAhead(1).ymd;
  const bkPlan = await submitPlan(exBk, '停灯承载计划', d0, d2, ['09:00-17:00'], 100);
  await approvePlan(bkPlan);
  // 另一条已批准计划（不同日期），用于跨计划停灯互斥
  const d3 = wallDaysAhead(3).ymd;
  const bkOther = await submitPlan(exBk, '停灯另一计划', d3, d3, ['09:00-17:00'], 100);
  await approvePlan(bkOther);
  // 待批准计划不能登记停灯
  const bkSubmitted = await submitPlan(exBk, '待批准不停灯', wallDaysAhead(10).ymd,
    wallDaysAhead(10).ymd, ['09:00-12:00'], 100);

  // ---- 权限与输入校验 ----
  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '10:00',
    endDate: d0, endTime: '12:00', reason: '设备检修',
  }, 'i');
  assert(r.status === 403, '布展员不能登记停灯（只读）');

  r = await call('POST', '/api/blackouts', {
    planId: bkSubmitted, startDate: wallDaysAhead(10).ymd, startTime: '10:00',
    endDate: wallDaysAhead(10).ymd, endTime: '11:00', reason: 'x',
  }, 'c');
  assert(r.status === 400 && /已批准或待复核/.test(r.body.error), '待批准计划登记停灯被拒');

  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '12:00',
    endDate: d0, endTime: '12:00', reason: '设备检修',
  }, 'c');
  assert(r.status === 400 && /起点须早于终点/.test(r.body.error), '零时长停灯被拒');

  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '12:00',
    endDate: d0, endTime: '11:00', reason: '设备检修',
  }, 'c');
  assert(r.status === 400 && /起点须早于终点/.test(r.body.error), '起点晚于终点被拒');

  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d2, startTime: '09:00',
    endDate: d2, endTime: '17:00', reason: '设备检修',
  }, 'c');
  assert(r.status === 400 && /晚于当前时间/.test(r.body.error), '结束晚于当前时间被拒（只能登记已发生）');

  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '08:00',
    endDate: d0, endTime: '10:00', reason: '设备检修',
  }, 'c');
  assert(r.status === 400 && /开灯窗/.test(r.body.error), '停灯超出开灯窗（起点在窗外）被拒');

  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '16:00',
    endDate: d0, endTime: '17:30', reason: '设备检修',
  }, 'c');
  assert(r.status === 400 && /开灯窗/.test(r.body.error), '停灯超出开灯窗（终点在窗外）被拒');

  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '10:00',
    endDate: d0, endTime: '12:00',
  }, 'c');
  assert(r.status === 400 && /停灯原因/.test(r.body.error), '停灯原因必填');

  // ---- 正常登记：昨天 10:00-12:00，100lx 估算扣减 200 ----
  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '10:00',
    endDate: d0, endTime: '12:00', reason: '灯具故障检修',
  }, 'c');
  assert(r.status === 201, '停灯登记成功');
  const bk1 = r.body.blackout.id;
  assert(r.body.blackout.yearly[d0.slice(0, 4)] === 200,
    '停灯记录带按年扣减量（200）：' + JSON.stringify(r.body.blackout.yearly));
  assert(r.body.blackouts.some((b) => b.id === bk1 && b.reason === '灯具故障检修'),
    '展品详情列出停灯记录');
  assert((r.body.blackoutDeductionYearly[d0.slice(0, 4)] || 0) === 200,
    `展品详情各年停灯扣减量：${d0.slice(0, 4)} 年=200，实际=${JSON.stringify(r.body.blackoutDeductionYearly)}`);

  // 计划估算残余：该计划 3 天共 2400，扣停灯 200 后残余 2200（此时无实测）
  const planSrc = r.body.sources.find((s) => s.kind === 'plan' && s.id === bkPlan);
  assert(Object.values(planSrc.yearly).reduce((a, b) => a + b, 0) === 2200,
    `停灯从所属计划估算中扣除：总残余 2200，实际 ${JSON.stringify(planSrc.yearly)}`);

  // ---- 停灯不释放排期：开灯窗仍与另一同窗计划互斥 ----
  r = await call('POST', '/api/plans', {
    exhibitId: exBk, title: '撞停灯承载计划窗', startDate: d0, endDate: d0,
    periods: ['10:30-11:30'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 409, '停灯不释放原计划排期占用：同窗新计划提交仍被拒');

  // ---- 与其他停灯相交被拒（同计划）----
  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '11:00',
    endDate: d0, endTime: '13:00', reason: '重复检修',
  }, 'c');
  assert(r.status === 409 && r.body.details.overlappingBlackouts.some((b) => b.id === bk1),
    '与其他停灯记录相交被拒并指出冲突记录');

  // 相接不相交：12:00-13:00 可登记
  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '12:00',
    endDate: d0, endTime: '13:00', reason: '继续检修',
  }, 'c');
  assert(r.status === 201, '端点相接的停灯时段可登记');
  const bk2 = r.body.blackout.id;

  // ---- 未作废实测碰到停灯被拒（录入路径，停灯在先）----
  r = await call('POST', '/api/measurements', {
    planId: bkPlan, startDate: d0, startTime: '11:00',
    endDate: d0, endTime: '12:30', actualLux: 100,
  }, 'c');
  assert(r.status === 409 && /停灯/.test(r.body.error), '实测录入碰到停灯时段被拒');

  // ---- 未作废实测在先，停灯登记碰到实测（含待确认草稿）被拒 ----
  // 昨天 14:00-16:00 录一条草稿实测
  r = await call('POST', '/api/measurements', {
    planId: bkPlan, startDate: d0, startTime: '14:00',
    endDate: d0, endTime: '16:00', actualLux: 80,
  }, 'c');
  assert(r.status === 201, '停灯窗外录入草稿实测');
  const bkMeasDraft = r.body.measurement.id;
  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '15:00',
    endDate: d0, endTime: '15:30', reason: '撞上草稿实测',
  }, 'c');
  assert(r.status === 409 && r.body.details.overlappingMeasurements.some((m) => m.id === bkMeasDraft),
    '停灯碰到待确认实测也被拒，并指出冲突实测');

  // ---- 停灯只扣估算，不减已确认实测（实测与停灯互斥，用相邻时段验证）----
  // 昨天 09:00-10:00 录入并确认实测 200lx = 200（与 10-12 停灯相接，不相交）
  r = await call('POST', '/api/measurements', {
    planId: bkPlan, startDate: d0, startTime: '09:00',
    endDate: d0, endTime: '10:00', actualLux: 200,
  }, 'c');
  assert(r.status === 201, '录入昨天上午实测（与停灯相接）');
  const bkMeasToday = r.body.measurement.id;
  // 停灯登记与实测时段互斥：09:30-10:30 同时覆盖实测与停灯
  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '09:30',
    endDate: d0, endTime: '10:30', reason: '撞实测与停灯',
  }, 'c');
  assert(r.status === 409 &&
    r.body.details.overlappingMeasurements.some((m) => m.id === bkMeasToday) &&
    r.body.details.overlappingBlackouts.some((b) => b.id === bk1),
    '停灯登记同时撞上实测与既有停灯时，一次性指出两类冲突');
  await call('POST', `/api/measurements/${bkMeasToday}/confirm`, {}, 'c');

  // 与已确认实测相接的停灯可登记：16:00-16:30（14-16 草稿实测相接于 16:00）
  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '16:00',
    endDate: d0, endTime: '16:30', reason: '补登傍晚停灯',
  }, 'c');
  assert(r.status === 201, `与草稿实测相接的停灯可登记（实际 ${r.status} ${r.body && r.body.error}）`);
  const bk3 = r.body.blackout.id;

  // 该年剂量核对（全部落在 d0 一天）：
  //   总窗 8h；已确认实测 200lx*1h=200 计量；草稿 80lx*2h=160 仍由估算占位；
  //   停灯 10-12(200) + 12-13(100) + 16-16:30(50) = 350
  //   估算残余 = 800 − 已确认实测 1h*100=100 − 停灯 350 = 350
  //   （草稿实测时段仍按估算 100lx 计 200，且与停灯不重叠）
  r = await call('GET', `/api/exhibits/${exBk}`, null, 'i');
  const bkYearKey = d0.slice(0, 4);
  const bkSrc = r.body.sources.find((s) => s.kind === 'plan' && s.id === bkPlan);
  // 计划跨 3 天可能跨年，用总残余求和验证
  const residueSum = Object.values(bkSrc.yearly).reduce((a, b) => a + b, 0);
  assert(residueSum === 350 + 1600, `停灯+实测统一扣减后计划总残余 1950，实际 ${residueSum}`);
  assert(Object.values(r.body.blackoutDeductionYearly).reduce((a, b) => a + b, 0) === 350,
    `各年停灯扣减合计 350，实际 ${JSON.stringify(r.body.blackoutDeductionYearly)}`);
  // 已确认实测剂量不被停灯削减：仍为 200
  const measSrc = r.body.sources.find((s) => s.kind === 'measurement' && s.id === bkMeasToday);
  assert(Object.values(measSrc.yearly).reduce((a, b) => a + b, 0) === 200,
    '已确认实测剂量不受停灯影响（200）');
  void bkYearKey;
  void bk3;

  // ---- 跨年停灯按自然年拆分：另建覆盖去年末/今年初的已批准计划 ----
  const crossStart = wallDaysAgo(2).ymd;
  // 找一个去年12/31至今年1/1 的窗口：动态取“当前日期前推到年末边界”过于复杂，
  // 直接用 wallDaysAgo(2) 与 wallDaysAgo(1)，若两者跨年则验证拆分；否则跳过 API 拆分，
  // 由下面固定 2030→2031 的 service 层场景保证。
  if (crossStart.slice(0, 4) !== d0.slice(0, 4)) {
    const cp = await submitPlan(exBk, '跨年停灯计划', crossStart, d0, ['09:00-17:00'], 100);
    await approvePlan(cp);
    r = await call('POST', '/api/blackouts', {
      planId: cp, startDate: crossStart, startTime: '09:00',
      endDate: d0, endTime: '17:00', reason: '跨年连续停灯',
    }, 'c');
    assert(r.status === 201, '跨年停灯登记成功');
    const yKeys = Object.keys(r.body.blackout.yearly);
    assert(yKeys.length === 2, '跨年停灯扣减量按两个自然年拆分：' + JSON.stringify(r.body.blackout.yearly));
  }

  // ---- 停灯记录不可改删；布展员只读 ----
  r = await call('DELETE', `/api/blackouts/${bk1}`, {}, 'c');
  assert(r.status === 400 && /不可删除/.test(r.body.error), '停灯记录不可删除');
  r = await call('PUT', `/api/blackouts/${bk1}`, { reason: '改' }, 'c');
  assert(r.status === 400 && /不可修改/.test(r.body.error), '停灯记录不可修改');
  r = await call('GET', `/api/blackouts?exhibitId=${exBk}`, null, 'i');
  assert(r.status === 200 && r.body.blackouts.some((b) => b.id === bk1),
    '布展员可只读查询停灯记录');
  assert(r.body.blackouts.every((b) => b.yearly), '停灯列表逐条带按年扣减量');
  r = await call('GET', `/api/blackouts?planId=${bkPlan}`, null, 'c');
  assert(r.body.blackouts.every((b) => b.planId === bkPlan), '可按计划过滤停灯记录');

  // ---- 计划取消后停灯保留、不再扣占用 ----
  await call('POST', `/api/plans/${bkOther}/cancel`, { reason: '停灯保留验证' }, 'c');
  r = await call('POST', '/api/blackouts', {
    planId: bkPlan, startDate: d0, startTime: '13:00',
    endDate: d0, endTime: '14:00', reason: '与12-13相接',
  }, 'c');
  assert(r.status === 201, '再登记一条停灯（13-14）用于后续核对');
  // bkOther 没有停灯；改为取消 bkPlan 会连带其停灯不再计入占用（记录仍列出）
  await call('POST', `/api/plans/${bkPlan}/cancel`, {}, 'c');
  r = await call('GET', `/api/exhibits/${exBk}`, null, 'i');
  assert(r.body.blackouts.length >= 4, '计划取消后停灯记录仍保留在展品详情');
  assert(!r.body.sources.some((s) => s.kind === 'plan' && s.id === bkPlan),
    '取消计划不再列估算残余占用');
  assert(Object.values(r.body.blackoutDeductionYearly).reduce((a, b) => a + b, 0) === 0,
    '取消后停灯不再扣减年度占用');
  const keptBk = r.body.blackouts.find((b) => b.id === bk1);
  assert(keptBk && keptBk.deductionActive === false &&
    Object.values(keptBk.yearly).reduce((a, b) => a + b, 0) === 200,
    '保留记录仍展示名义扣减量，deductionActive=false');

  // ---- 调整核对：未开始计划的停灯必须落在拟改新窗内；新残余继续扣停灯 ----
  const exAdjBk = await createExhibit('停灯调整展品');
  await call('POST', `/api/exhibits/${exAdjBk}/limits`, { year: 2035, limitLxh: 100000 }, 'c');
  await call('POST', `/api/exhibits/${exAdjBk}/limits`, { year: 2036, limitLxh: 100000 }, 'c');
  const abPlan = await submitPlan(exAdjBk, '调整停灯计划', '2035-06-01', '2035-06-01',
    ['09:00-17:00'], 100); // 800
  await approvePlan(abPlan);
  // 直接在库中写入一条停灯（2035-06-01 10:00-12:00，已批准未开始计划）
  await dbModule.withTransaction(async (client) => {
    const exRow = await client.query('SELECT exhibit_id FROM plans WHERE id = $1', [abPlan]);
    await client.query(
      `INSERT INTO blackouts (plan_id, exhibit_id, start_ts, end_ts, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [abPlan, exRow.rows[0].exhibit_id,
        new Date(dosing2.wallToTs('2035-06-01', 600)),
        new Date(dosing2.wallToTs('2035-06-01', 720)),
        'SQL 预置停灯']
    );
  });
  r = await call('GET', `/api/exhibits/${exAdjBk}`, null, 'c');
  const adjBkSrc = r.body.sources.find((s) => s.kind === 'plan' && s.id === abPlan);
  assert(adjBkSrc.yearly['2035'] === 600, '未开始计划停灯 200 已从估算残余扣除（800→600）');

  // 同窗口调整（照度改为 200）：新残余 = (8-2)h*200 = 1200
  r = await call('POST', '/api/adjustments', {
    planId: abPlan, startDate: '2035-06-01', endDate: '2035-06-01',
    periods: ['09:00-17:00'], estimatedLux: 200,
  }, 'i');
  assert(r.status === 201, '提交同窗口照度调整');
  const abAdj = r.body.adjustment.id;
  assert(r.body.adjustment.preview.newResidueYearly['2035'] === 1200,
    '调整试算新残余继续扣除停灯（6h*200=1200）');
  assert(r.body.adjustment.preview.oldResidueYearly['2035'] === 600,
    '调整试算原残余口径含停灯扣减（600）');

  // 拟改新窗不覆盖该停灯（2035-06-02）：outsideBlackouts 冲突
  await call('POST', `/api/adjustments/${abAdj}/withdraw`, {}, 'i');
  r = await call('POST', '/api/adjustments', {
    planId: abPlan, startDate: '2035-06-02', endDate: '2035-06-02',
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201, '提交排除停灯窗口的调整申请');
  const abAdj2 = r.body.adjustment.id;
  assert(r.body.adjustment.preview.conflicts.outsideBlackouts.some((x) => /SQL 预置停灯/.test(x.reason)),
    '试算指出停灯落在新开灯窗外');
  r = await call('POST', `/api/adjustments/${abAdj2}/approve`, {}, 'c');
  assert(r.status === 409 && /停灯记录/.test(r.body.error), '窗外停灯的调整批准被拒（409）');
  assert(r.body.details.conflicts.outsideBlackouts.length === 1,
    '结构化明细给出窗外停灯');
  await call('POST', `/api/adjustments/${abAdj2}/withdraw`, {}, 'i');

  // ---- 上限下调预演指纹包含停灯：预演后新增停灯，旧凭证提交被拒 ----
  const exBkLim = await createExhibit('停灯预演展品');
  await call('POST', `/api/exhibits/${exBkLim}/limits`, { year: 2036, limitLxh: 10000 }, 'c');
  const lbPlan = await submitPlan(exBkLim, '预演停灯计划', '2036-05-01', '2036-05-01',
    ['09:00-17:00'], 100); // 800
  await approvePlan(lbPlan);
  // 预置停灯 2h（200），used=600
  await dbModule.withTransaction(async (client) => {
    const exRow = await client.query('SELECT exhibit_id FROM plans WHERE id = $1', [lbPlan]);
    await client.query(
      `INSERT INTO blackouts (plan_id, exhibit_id, start_ts, end_ts, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [lbPlan, exRow.rows[0].exhibit_id,
        new Date(dosing2.wallToTs('2036-05-01', 540)),
        new Date(dosing2.wallToTs('2036-05-01', 660)),
        '预演前停灯']
    );
  });
  r = await call('POST', `/api/exhibits/${exBkLim}/limits/preview`,
    { year: 2036, limitLxh: 700 }, 'c');
  assert(r.status === 200, '停灯预演成功');
  assert(r.body.preview.used === 600, '预演占用含停灯扣减（估算残余 600）');
  assert(r.body.preview.blackoutDeductions.some((x) => x.yearDeduction === 200 && x.planId === lbPlan),
    '预演列出该年停灯扣减量 200');
  const staleBkToken = r.body.preview.token;
  // 预演后再插入一条停灯（13:00-14:00，100），used 降到 500
  await dbModule.withTransaction(async (client) => {
    const exRow = await client.query('SELECT exhibit_id FROM plans WHERE id = $1', [lbPlan]);
    await client.query(
      `INSERT INTO blackouts (plan_id, exhibit_id, start_ts, end_ts, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [lbPlan, exRow.rows[0].exhibit_id,
        new Date(dosing2.wallToTs('2036-05-01', 780)),
        new Date(dosing2.wallToTs('2036-05-01', 840)),
        '预演后停灯']
    );
  });
  r = await call('POST', `/api/exhibits/${exBkLim}/limits/lower`,
    { year: 2036, limitLxh: 700, token: staleBkToken }, 'c');
  assert(r.status === 409 && /已变化/.test(r.body.error), '新增停灯后旧预演凭证被拒（占用已变化）');
  assert(r.body.details.preview.used === 500,
    `最新预演反映停灯扣减后 used=500，实际 ${r.body.details.preview.used}`);

  // =======================================================================
  // 实测纠错（保管员）：原记录编号 + 替代时段/照度 + 必填原因
  // 旧记录保留作废、替代记录确认、双向关联与审计；按自然年重算；
  // 非法数值/越窗/冲突指出原因；超额转待复核；占用下降不恢复待复核。
  // =======================================================================
  const exCo = await createExhibit('实测纠错展品');
  await call('POST', `/api/exhibits/${exCo}/limits`, { year: 2035, limitLxh: 100000 }, 'c');

  // 承载计划：2035-06-01 全天 09-17，100lx（确定尚未开始）
  const coPlan = await submitPlan(exCo, '纠错承载计划', '2035-06-01', '2035-06-01',
    ['09:00-17:00'], 100);
  await approvePlan(coPlan);
  // 同展品另一条已批准未开始计划（超额时应一起被转待复核）
  const coOther = await submitPlan(exCo, '纠错相邻计划', '2035-07-01', '2035-07-01',
    ['09:00-17:00'], 100);
  await approvePlan(coOther);

  // 原始已确认实测：2035-06-01 09:00-12:00，100lx = 300
  r = await call('POST', '/api/measurements', {
    planId: coPlan, startDate: '2035-06-01', startTime: '09:00',
    endDate: '2035-06-01', endTime: '12:00', actualLux: 100,
  }, 'c');
  assert(r.status === 201, '录入原实测草稿');
  const coMeas1 = r.body.measurement.id;
  await call('POST', `/api/measurements/${coMeas1}/confirm`, {}, 'c');

  // 另一条已确认实测：14:00-15:00，100lx = 100（用于冲突测试）
  r = await call('POST', '/api/measurements', {
    planId: coPlan, startDate: '2035-06-01', startTime: '14:00',
    endDate: '2035-06-01', endTime: '15:00', actualLux: 100,
  }, 'c');
  const coMeasBlock = r.body.measurement.id;
  await call('POST', `/api/measurements/${coMeasBlock}/confirm`, {}, 'c');

  // ---- 权限 / 组成性校验 ----
  r = await call('POST', `/api/measurements/${coMeas1}/correct`, {
    startDate: '2035-06-01', startTime: '09:00',
    endDate: '2035-06-01', endTime: '12:00', actualLux: 110, reason: '照度录错',
  }, 'i');
  assert(r.status === 403, '布展员不能发起实测纠错');

  r = await call('POST', `/api/measurements/${coMeas1}/correct`, {
    startDate: '2035-06-01', startTime: '09:00',
    endDate: '2035-06-01', endTime: '12:00', actualLux: 110,
  }, 'c');
  assert(r.status === 400 && /纠错原因/.test(r.body.error), '纠错原因必填');

  r = await call('POST', `/api/measurements/${coMeas1}/correct`, {
    startDate: '2035-06-01', startTime: '11:00',
    endDate: '2035-06-01', endTime: '10:00', actualLux: 110, reason: '时段录错',
  }, 'c');
  assert(r.status === 400 && /晚于开始/.test(r.body.error), '替代时段非正时长被拒');

  r = await call('POST', `/api/measurements/${coMeas1}/correct`, {
    startDate: '2035-06-01', startTime: '09:00',
    endDate: '2035-06-01', endTime: '12:00', actualLux: 0, reason: '照度录错',
  }, 'c');
  assert(r.status === 400 && /正数/.test(r.body.error), '非法（非正）替代照度被拒');

  r = await call('POST', `/api/measurements/999999/correct`, {
    startDate: '2035-06-01', startTime: '09:00',
    endDate: '2035-06-01', endTime: '12:00', actualLux: 110, reason: '照度录错',
  }, 'c');
  assert(r.status === 400 && /不存在/.test(r.body.error), '原记录不存在被拒');

  // ---- 越窗：替代时段必须完整处于原计划开灯窗 ----
  r = await call('POST', `/api/measurements/${coMeas1}/correct`, {
    startDate: '2035-06-01', startTime: '08:00',
    endDate: '2035-06-01', endTime: '12:00', actualLux: 110, reason: '时段录错',
  }, 'c');
  assert(r.status === 400 && /开灯窗/.test(r.body.error), '替代时段越出开灯窗（起点在窗外）被拒');
  r = await call('POST', `/api/measurements/${coMeas1}/correct`, {
    planId: coOther, startDate: '2035-07-01', startTime: '09:00',
    endDate: '2035-07-01', endTime: '12:00', actualLux: 110, reason: '挪到别的计划',
  }, 'c');
  assert(r.status === 400 && /原计划/.test(r.body.error),
    '替代记录仍属原计划：写到其他计划窗口被拒（按原计划窗校验）');

  // ---- 冲突：与其他未作废实测 / 停灯相交（原记录自身排除）----
  // 与 14:00-15:00 已确认实测相交
  r = await call('POST', `/api/measurements/${coMeas1}/correct`, {
    startDate: '2035-06-01', startTime: '13:30',
    endDate: '2035-06-01', endTime: '15:30', actualLux: 110, reason: '时段录错',
  }, 'c');
  assert(r.status === 409, '替代时段与其他实测相交被拒（409）');
  assert(r.body.details.overlappingMeasurements.some((m) => m.id === coMeasBlock),
    '冲突明细指出相交实测');
  // 失败后原记录与额度不变
  r = await call('GET', `/api/exhibits/${exCo}`, null, 'i');
  const mStill = r.body.measurements.find((m) => m.id === coMeas1);
  assert(mStill.status === 'confirmed' && mStill.replacedById === null,
    '纠错失败：原记录仍已确认、未被作废');
  // 当时占用：已确认实测 300+100=400；承载计划残余 (8−3−1)h*100=400；相邻计划 800
  assert(r.body.years['2035'].used === 1600,
    `纠错失败：2035 占用不变（实测400+承载残余400+相邻800=1600），实际=${r.body.years['2035'].used}`);

  // ---- 成功纠错：09:00-12:00（3h,100lx=300）→ 09:00-13:00（4h,150lx=600）----
  r = await call('POST', `/api/measurements/${coMeas1}/correct`, {
    startDate: '2035-06-01', startTime: '09:00',
    endDate: '2035-06-01', endTime: '13:00', actualLux: 150, reason: '照度与结束时刻均录错',
  }, 'c');
  assert(r.status === 200, `纠错成功（实际 ${r.status} ${r.body && r.body.error}）`);
  const coMeas2 = r.body.correction.replacementMeasurementId;
  assert(coMeas2 !== coMeas1 && r.body.correction.originalMeasurementId === coMeas1,
    '成功响应附纠错摘要（原/替代记录编号）');
  assert(r.body.correction.replacement.yearly['2035'] === 600 &&
    r.body.correction.original.yearly['2035'] === 300,
    '纠错摘要列出替代 600 / 原 300 的按年剂量');

  // 展品详情可追溯前后记录与原因
  r = await call('GET', `/api/exhibits/${exCo}`, null, 'i');
  const oldRow = r.body.measurements.find((m) => m.id === coMeas1);
  const newRow = r.body.measurements.find((m) => m.id === coMeas2);
  assert(oldRow.status === 'annulled' && oldRow.replacedById === coMeas2 &&
    oldRow.correctionReason === '照度与结束时刻均录错',
    '旧记录保留、标记作废并指向替代记录与原因');
  assert(newRow.status === 'confirmed' && newRow.replacesMeasurementId === coMeas1 &&
    newRow.correctionReason === '照度与结束时刻均录错',
    '替代记录为已确认并指向原记录与原因');

  // 重算：2035 已确认实测 600+100=700；承载计划残余 = (8h − 4h新实测 − 1h另一实测)*100 = 300；
  //       相邻计划残余 800；合计 1800
  assert(r.body.years['2035'].used === 1800,
    `纠错成功后 2035 占用=实测700 + 承载残余300 + 相邻800 = 1800，实际 ${r.body.years['2035'].used}`);
  // 已作废记录不再出现在占用来源（只由替代记录计量）
  assert(!r.body.sources.some((s) => s.kind === 'measurement' && s.id === coMeas1),
    '已作废原记录不再计入已确认实测占用');
  assert(r.body.sources.some((s) => s.kind === 'measurement' && s.id === coMeas2 &&
    s.yearly['2035'] === 600), '替代记录计入已确认实测占用');

  // 审计：纠错事件
  r = await call('GET', '/api/audit?limit=1000', null, 'c');
  assert(r.body.events.some((e) => e.action === 'measurement.correct' &&
    Number(e.target_id) === coMeas2), '操作流水记录了实测纠错（target 为替代记录）');

  // ---- 已作废记录不能再次纠错；替代记录可以继续纠错（纠错链）----
  r = await call('POST', `/api/measurements/${coMeas1}/correct`, {
    startDate: '2035-06-01', startTime: '09:00',
    endDate: '2035-06-01', endTime: '10:00', actualLux: 120, reason: '再改',
  }, 'c');
  assert(r.status === 400 && /已作废/.test(r.body.error), '已作废记录不能再次纠错');

  // ---- 纠错使年度超额：另建一件展品验证“纠错前不超、纠错后超 → 转待复核”----
  const exCo2 = await createExhibit('纠错超额展品');
  await call('POST', `/api/exhibits/${exCo2}/limits`, { year: 2035, limitLxh: 100000 }, 'c');
  const cp1 = await submitPlan(exCo2, '超额承载计划', '2035-06-01', '2035-06-01',
    ['09:00-17:00'], 100); // 800
  const cp2 = await submitPlan(exCo2, '超额未开始计划', '2035-08-01', '2035-08-01',
    ['09:00-17:00'], 100); // 800
  await approvePlan(cp1);
  await approvePlan(cp2);
  // 原实测：09:00-12:00 100lx = 300；占用 = 300 + 承载残余 500 + cp2 800 = 1600
  // 确认后再收紧上限到“纠错前不超、纠错后超”：
  r = await call('POST', '/api/measurements', {
    planId: cp1, startDate: '2035-06-01', startTime: '09:00',
    endDate: '2035-06-01', endTime: '12:00', actualLux: 100,
  }, 'c');
  const cm1 = r.body.measurement.id;
  await call('POST', `/api/measurements/${cm1}/confirm`, {}, 'c');
  // used = 300 + 承载残余 500 + 800 = 1600；收紧上限到 1600（纠错前恰好不超），
  // 纠错为 09-17 全天 200lx=1600 后超额
  await call('POST', `/api/exhibits/${exCo2}/limits`, { year: 2035, limitLxh: 1600 }, 'c');
  r = await call('GET', `/api/exhibits/${exCo2}`, null, 'i');
  assert(r.body.years['2035'].used === 1600 && r.body.years['2035'].over === false,
    `纠错前 2035 占用 1600、上限 1600 不超限，实际=${r.body.years['2035'].used}/${r.body.years['2035'].limit}`);
  // 纠错：1600 实测 + cp2 残余 800 = 2400（承载计划被全天覆盖，残余 0），超额 900
  r = await call('POST', `/api/measurements/${cm1}/correct`, {
    startDate: '2035-06-01', startTime: '09:00',
    endDate: '2035-06-01', endTime: '17:00', actualLux: 200, reason: '照度与时段均录错（全天）',
  }, 'c');
  assert(r.status === 409, '纠错导致年度超额：纠错生效并返回 409');
  const cof = r.body.overflows.find((o) => o.year === 2035);
  assert(cof && cof.excess === 800 && cof.projected === 2400,
    `纠错超额 800、合计 2400（上限 1600），实际=${JSON.stringify(r.body.overflows)}`);
  assert(r.body.flaggedPlans.some((p) => p.id === cp2),
    '超额年仍有估算残余且尚未开始的已批准计划转为待复核');
  assert(!r.body.flaggedPlans.some((p) => p.id === cp1),
    '承载计划该年估算残余为 0（被替代实测全天覆盖），不转待复核');
  // 409 下纠错已生效（与确认实测口径一致）
  assert(r.body.detail.measurements.some((m) => m.id === cm1 && m.status === 'annulled'),
    '409 响应详情中原记录已作废（纠错已生效）');
  const cm2 = r.body.correction.replacementMeasurementId;
  assert(r.body.detail.measurements.some((m) => m.id === cm2 && m.status === 'confirmed'),
    '409 响应详情中替代记录已确认');
  const flaggedReason = r.body.detail.plans.find((p) => p.id === cp2).review_reason;
  assert(/纠错/.test(flaggedReason || '') && /超限/.test(flaggedReason || ''),
    '待复核原因写明实测纠错与超限：' + flaggedReason);

  // ---- 占用下降不自动恢复既有待复核计划 ----
  // 把替代记录纠错回更小剂量（09-10 100lx = 100），2035 占用降到上限以下
  r = await call('POST', `/api/measurements/${cm2}/correct`, {
    startDate: '2035-06-01', startTime: '09:00',
    endDate: '2035-06-01', endTime: '10:00', actualLux: 100, reason: '复测核对后改回小剂量',
  }, 'c');
  assert(r.status === 200, '纠错为更小剂量成功（占用下降）');
  r = await call('GET', `/api/exhibits/${exCo2}`, null, 'i');
  assert(r.body.years['2035'].over === false, '占用下降后不再超限');
  assert(r.body.plans.find((p) => p.id === cp2).status === 'pending_review',
    '占用下降不自动恢复既有待复核计划（仍为待复核，需保管员复核）');

  // ---- 纠错替代时段与停灯相交被拒（停灯与实测互斥）----
  const exCo3 = await createExhibit('纠错停灯展品');
  const wallNow2 = dosing.tsToWall(Date.now());
  const coYmd = wallNow2.ymd;
  await call('POST', `/api/exhibits/${exCo3}/limits`,
    { year: Number(coYmd.slice(0, 4)), limitLxh: 100000 }, 'c');
  // 承载计划覆盖今天（已开始，仍可纠错），09-17
  const bcp = await submitPlan(exCo3, '纠错停灯承载计划', coYmd, coYmd,
    ['09:00-17:00'], 100);
  await approvePlan(bcp);
  // 已确认实测 09:00-10:00 = 100
  r = await call('POST', '/api/measurements', {
    planId: bcp, startDate: coYmd, startTime: '09:00',
    endDate: coYmd, endTime: '10:00', actualLux: 100,
  }, 'c');
  const cm3 = r.body.measurement.id;
  await call('POST', `/api/measurements/${cm3}/confirm`, {}, 'c');
  // 一条停灯 11:00-12:00（直接 SQL 预置，保证确定性，不依赖当前时刻）
  await dbModule.withTransaction(async (client) => {
    const exRow = await client.query('SELECT exhibit_id FROM plans WHERE id = $1', [bcp]);
    await client.query(
      `INSERT INTO blackouts (plan_id, exhibit_id, start_ts, end_ts, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [bcp, exRow.rows[0].exhibit_id,
        new Date(dosing.wallToTs(coYmd, 660)),
        new Date(dosing.wallToTs(coYmd, 720)),
        '纠错测试停灯']
    );
  });
  r = await call('POST', `/api/measurements/${cm3}/correct`, {
    startDate: coYmd, startTime: '10:30',
    endDate: coYmd, endTime: '12:30', actualLux: 100, reason: '时段录错撞上停灯',
  }, 'c');
  assert(r.status === 409 && r.body.details.overlappingBlackouts.length === 1,
    '替代时段与停灯相交：纠错被拒并指出停灯冲突');
  r = await call('GET', `/api/exhibits/${exCo3}`, null, 'i');
  assert(r.body.measurements.find((m) => m.id === cm3).status === 'confirmed',
    '停灯冲突下原记录不变');

  // ---- 草稿不能纠错（可删除重录）----
  r = await call('POST', '/api/measurements', {
    planId: bcp, startDate: coYmd, startTime: '13:00',
    endDate: coYmd, endTime: '14:00', actualLux: 100,
  }, 'c');
  const cmDraft = r.body.measurement.id;
  r = await call('POST', `/api/measurements/${cmDraft}/correct`, {
    startDate: coYmd, startTime: '13:00',
    endDate: coYmd, endTime: '14:30', actualLux: 110, reason: '草稿纠错',
  }, 'c');
  assert(r.status === 400 && /已确认/.test(r.body.error), '待确认草稿不能纠错（引导删除重录）');

  // ---- 待复核/取消计划的已确认实测仍可纠错（只按原计划窗校验，不校验计划状态）----
  // cp2 当前为 pending_review：其无实测；改为取消 bcp 后对其历史实测纠错验证状态放宽。
  // （取消会连带计划退出占用，但实测记录仍保留可追溯、可纠错。）
  await call('POST', `/api/plans/${bcp}/cancel`, {}, 'c');
  r = await call('POST', `/api/measurements/${cm3}/correct`, {
    startDate: coYmd, startTime: '09:00',
    endDate: coYmd, endTime: '10:30', actualLux: 120, reason: '计划取消后更正历史实测',
  }, 'c');
  assert(r.status === 200, `计划取消后仍可对其已确认实测纠错（实际 ${r.status} ${r.body && r.body.error}）`);

  // ---- 实测列表接口保持兼容并附追溯字段 ----
  r = await call('GET', `/api/measurements?exhibitId=${exCo}`, null, 'i');
  assert(r.body.measurements.some((m) => m.id === coMeas2 && m.replacesMeasurementId === coMeas1),
    '实测列表（布展员只读）可追溯替代关系');
  assert(r.body.measurements.every((m) => 'correctionReason' in m),
    '既有实测列表字段保持兼容（仅附加纠错字段）');

  // 操作流水：停灯登记
  r = await call('GET', '/api/audit?limit=1000', null, 'c');
  assert(r.body.events.some((e) => e.action === 'blackout.create'),
    '操作流水记录了停灯登记');
  r = await call('GET', '/api/audit?limit=1000', null, 'c');
  assert(r.status === 200 && r.body.events.some((e) => e.action === 'plan.approve'),
    '操作流水记录了审批事件');
  assert(r.body.events.some((e) => e.action === 'plan.adjustment.submit'),
    '操作流水记录了调整申请提交');
  assert(r.body.events.some((e) => e.action === 'plan.adjustment.approve'),
    '操作流水记录了调整申请批准');
  assert(r.body.events.some((e) => e.action === 'plan.adjustment.pair_approve'),
    '操作流水记录了成对核准');
  assert(r.body.events.some((e) => e.action === 'plan.update_via_adjustment'),
    '操作流水记录了计划经调整更新');
  assert(r.body.events.some((e) => e.action === 'plan.adjustment.withdraw'),
    '操作流水记录了调整申请撤回');
  assert(r.body.events.some((e) => e.action === 'plan.adjustment.reject'),
    '操作流水记录了调整申请驳回');
  assert(r.body.events.some((e) => e.action === 'limit.lower'),
    '操作流水记录了携凭证下调上限');
  assert(r.body.events.some((e) => e.action === 'plan.flag_review_limit_lower'),
    '操作流水记录了下调上限导致的转待复核');
  assert(r.body.events.some((e) => e.action === 'limit.upsert'),
    '操作流水记录了登记/修改上限');

  // =======================================================================
  // 年度用光账册封存（保管员，规则 16）：
  //   仅可封存已结束自然年；未登记上限/年份未结束/已封存拒绝；重复提交不覆盖旧账；
  //   封存原子记录上限、已确认实测、各计划估算残余、合计与逐项来源；
  //   封存后实测纠错/计划状态/上限变化照常生效，旧账不可改；
  //   展品详情/账册接口对照封存值与按当前数据重算值：合计差额、按来源编号逐项差额、
  //   已消失来源仍列出、零差额明确标示；封存与同展品占用变动串行、不混入前后数据。
  // =======================================================================
  const exLd = await createExhibit('账册封存展品');
  const wallYearNow = Number(dosing.tsToWall(Date.now()).ymd.slice(0, 4));
  const sealYear = wallYearNow - 2; // 确定已结束、且与“未结束/上一年”场景区分开
  // 两个已结束年份：sealYear 用于封存，sealYear+1 为未登记上限的拒绝场景兜底
  await call('POST', `/api/exhibits/${exLd}/limits`, { year: sealYear, limitLxh: 100000 }, 'c');

  // 计划 P1：sealYear-05-01 09:00-17:00（8h），100lx，毛估算 800
  const ldP1 = await submitPlan(exLd, '账册计划1', `${sealYear}-05-01`, `${sealYear}-05-01`,
    ['09:00-17:00'], 100);
  await approvePlan(ldP1);
  // 计划 P2：sealYear-06-01 18:00-22:00（4h），100lx = 400
  const ldP2 = await submitPlan(exLd, '账册计划2', `${sealYear}-06-01`, `${sealYear}-06-01`,
    ['18:00-22:00'], 100);
  await approvePlan(ldP2);

  // ---- 组成性拒绝：未登记上限 / 年份未结束 / 越权 / 非法年份 ----
  const wallY = wallYearNow; // UTC+8 墙上当前年（未结束）
  r = await call('POST', `/api/exhibits/${exLd}/ledgers`, { year: sealYear + 1 }, 'i');
  assert(r.status === 403, '布展员不能封存账册（越权）');
  r = await call('POST', `/api/exhibits/${exLd}/ledgers`, { year: sealYear + 1 }, 'c');
  assert(r.status === 400 && /尚未登记/.test(r.body.error), '未登记上限的年份拒绝封存');
  r = await call('POST', `/api/exhibits/${exLd}/ledgers`, { year: wallY }, 'c');
  assert(r.status === 400 && /尚未结束/.test(r.body.error), '当前（未结束）年份拒绝封存');
  r = await call('POST', `/api/exhibits/${exLd}/ledgers`, { year: wallY - 1 }, 'c');
  assert(r.status === 400 && /尚未登记/.test(r.body.error),
    '上一年（已结束但未登记上限）按未登记上限拒绝');
  r = await call('POST', `/api/exhibits/${exLd}/ledgers`, { year: 1800 }, 'c');
  assert(r.status === 400, '非法年份拒绝封存');
  r = await call('POST', `/api/exhibits/${exLd}/ledgers`, {}, 'c');
  assert(r.status === 400, '缺少年份拒绝封存');

  // ---- 封存前先做两项占用变动：确认实测（替代估算）+ 停灯扣减 ----
  // P1 09:00-12:00 实测 150lx = 450（替代该 3h 的 300 估算）
  r = await call('POST', '/api/measurements', {
    planId: ldP1, startDate: `${sealYear}-05-01`, startTime: '09:00',
    endDate: `${sealYear}-05-01`, endTime: '12:00', actualLux: 150,
  }, 'c');
  assert(r.status === 201, '录入账册实测草稿');
  const ldMeas = r.body.measurement.id;
  r = await call('POST', `/api/measurements/${ldMeas}/confirm`, {}, 'c');
  assert(r.status === 200, '确认账册实测');
  // P2 停灯 19:00-20:00（1h×100=100），残余 400 → 300（直接 SQL 预置，历史已发生时段）
  await dbModule.withTransaction(async (client) => {
    await client.query(
      `INSERT INTO blackouts (plan_id, exhibit_id, start_ts, end_ts, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [ldP2, exLd,
        new Date(dosing.wallToTs(`${sealYear}-06-01`, 19 * 60)),
        new Date(dosing.wallToTs(`${sealYear}-06-01`, 20 * 60)),
        '封存前停灯']
    );
  });
  // 封存前口径：实测 450；P1 残余 (8-3)h*100=500；P2 残余 (4-1)h*100=300；合计 1250
  r = await call('GET', `/api/exhibits/${exLd}`, null, 'i');
  assert(r.body.years[String(sealYear)].used === 1250,
    `封存前 ${sealYear} 占用=450+500+300=1250，实际 ${r.body.years[String(sealYear)].used}`);

  // ---- 成功封存：原子记录上限/实测/残余/合计/逐项 ----
  r = await call('POST', `/api/exhibits/${exLd}/ledgers`, { year: sealYear }, 'c');
  assert(r.status === 201, `封存成功（实际 ${r.status} ${r.body && r.body.error}）`);
  const ledgerId = r.body.ledger.id;
  const lg = r.body.ledger;
  assert(lg.limit === 100000 && lg.confirmedTotal === 450 &&
    lg.residueTotal === 800 && lg.total === 1250,
    `封存值：上限100000/实测450/残余800/合计1250，实际=${JSON.stringify({
      l: lg.limit, c: lg.confirmedTotal, r: lg.residueTotal, t: lg.total })}`);
  const itemMeas = lg.items.find((it) => it.kind === 'measurement' && it.id === ldMeas);
  const itemP1 = lg.items.find((it) => it.kind === 'plan' && it.id === ldP1);
  const itemP2 = lg.items.find((it) => it.kind === 'plan' && it.id === ldP2);
  assert(itemMeas && itemMeas.yearDose === 450, '逐项来源含已确认实测 450');
  assert(itemP1 && itemP1.yearDose === 500, '逐项来源含计划1 估算残余 500');
  assert(itemP2 && itemP2.yearDose === 300, '逐项来源含计划2 估算残余 300（已扣停灯）');
  assert(lg.sealedBy != null && lg.sealedAt, '记录封存人与封存时刻');

  // ---- 重复提交不得覆盖旧账（409，指明既有账册）----
  r = await call('POST', `/api/exhibits/${exLd}/ledgers`, { year: sealYear }, 'c');
  assert(r.status === 409 && /不可修改或覆盖/.test(r.body.error) &&
    r.body.details.existingLedgerId === ledgerId,
    '重复封存被拒（409）且不覆盖旧账');
  r = await call('GET', `/api/exhibits/${exLd}/ledgers`, null, 'i');
  assert(r.body.ledgers.length === 1 && r.body.ledgers[0].id === ledgerId,
    '重复封存未产生新账册');

  // ---- 旧账不可改删 ----
  r = await call('DELETE', `/api/exhibits/${exLd}/ledgers/${sealYear}`, {}, 'c');
  assert(r.status === 400 && /不可删除/.test(r.body.error), '账册不可删除');
  r = await call('PUT', `/api/exhibits/${exLd}/ledgers/${sealYear}`, { limitLxh: 1 }, 'c');
  assert(r.status === 400 && /不可修改/.test(r.body.error), '账册不可修改');

  // ---- 封存瞬间对照：全部零差额并明确标示 ----
  r = await call('GET', `/api/exhibits/${exLd}/ledgers/${sealYear}`, null, 'i');
  assert(r.status === 200, '查询封存账册及对照');
  const cmp = r.body.comparison;
  assert(cmp.totals.total.zeroDifference === true && cmp.totals.limit.zeroDifference === true,
    '封存瞬间合计与上限零差额并标示');
  assert(cmp.itemDiffs.length === 3 && cmp.itemDiffs.every((it) => it.zeroDifference === true),
    '封存瞬间逐项零差额且明确标示');

  // ---- 封存后：实测纠错、计划状态、上限变化仍按现有流程生效；旧账不变 ----
  // 1) 实测纠错：450 → 09:00-13:00 200lx = 800
  r = await call('POST', `/api/measurements/${ldMeas}/correct`, {
    startDate: `${sealYear}-05-01`, startTime: '09:00',
    endDate: `${sealYear}-05-01`, endTime: '13:00', actualLux: 200,
    reason: '封存后核对纠错',
  }, 'c');
  assert(r.status === 200, '封存后实测纠错照常生效');
  const ldMeas2 = r.body.correction.replacementMeasurementId;
  // 2) 计划取消：P2 退出占用（残余 300 消失）
  await call('POST', `/api/plans/${ldP2}/cancel`, {}, 'c');
  // 3) 上限变化：100000 → 90000
  await call('POST', `/api/exhibits/${exLd}/limits`, { year: sealYear, limitLxh: 90000 }, 'c');

  // 当前重算：实测 800；P1 残余 (8-4)h*100=400；P2 已取消无残余；合计 1200
  r = await call('GET', `/api/exhibits/${exLd}/ledgers/${sealYear}`, null, 'i');
  const cur = r.body.current;
  assert(cur.limit === 90000 && cur.confirmedTotal === 800 &&
    cur.residueTotal === 400 && cur.total === 1200,
    `当前重算：上限90000/实测800/残余400/合计1200，实际=${JSON.stringify(cur)}`);
  // 封存值原样不变
  const sl = r.body.ledger;
  assert(sl.limit === 100000 && sl.confirmedTotal === 450 &&
    sl.residueTotal === 800 && sl.total === 1250,
    '封存后旧账封存值始终不变');
  // 合计差额：上限 -10000；实测 +350；残余 -400；合计 -50
  const t = r.body.comparison.totals;
  assert(t.limit.delta === -10000 && t.confirmedTotal.delta === 350 &&
    t.residueTotal.delta === -400 && t.total.delta === -50,
    `合计/上限差额正确，实际=${JSON.stringify(t)}`);
  assert(t.total.zeroDifference === false && t.allZero === false, '有差额时零差额标记为 false');

  // ---- 按来源编号对齐逐项差额；已消失来源仍列出；新增来源列出 ----
  const diffs = r.body.comparison.itemDiffs;
  // 旧实测 #ldMeas 已作废（不再占用）→ 已消失来源，仍列出
  const dOldMeas = diffs.find((x) => x.sourceKey === `measurement:${ldMeas}`);
  assert(dOldMeas && dOldMeas.present === false && dOldMeas.sealedDose === 450 &&
    dOldMeas.currentDose === null && dOldMeas.delta === -450,
    '已作废旧实测作为已消失来源仍列出（封存450/当前null/差额-450）');
  // 替代实测 #ldMeas2：封存后新增来源
  const dNewMeas = diffs.find((x) => x.sourceKey === `measurement:${ldMeas2}`);
  assert(dNewMeas && dNewMeas.sealed === false && dNewMeas.sealedDose === null &&
    dNewMeas.currentDose === 800 && dNewMeas.delta === 800,
    '纠错替代实测作为新增来源列出（封存null/当前800）');
  // P1 残余 500 → 400（被更大的替代实测多覆盖 1h）
  const dP1 = diffs.find((x) => x.sourceKey === `plan:${ldP1}`);
  assert(dP1 && dP1.present === true && dP1.sealedDose === 500 &&
    dP1.currentDose === 400 && dP1.delta === -100 && dP1.zeroDifference === false,
    '计划1 残余逐项差额 500→400');
  // P2 已取消：已消失计划来源仍列出
  const dP2 = diffs.find((x) => x.sourceKey === `plan:${ldP2}`);
  assert(dP2 && dP2.present === false && dP2.sealedDose === 300 &&
    dP2.currentDose === null, '已取消计划作为已消失来源仍列出（封存300/当前null）');

  // ---- 展品详情附加 ledgers（仅附加字段，既有字段兼容）----
  r = await call('GET', `/api/exhibits/${exLd}`, null, 'i');
  assert(Array.isArray(r.body.ledgers) && r.body.ledgers.length === 1 &&
    r.body.ledgers[0].id === ledgerId, '展品详情附已封存账册列表');
  const detailCmp = r.body.ledgers[0].comparison;
  assert(detailCmp && detailCmp.totals.total.delta === -50 &&
    detailCmp.itemDiffs.some((x) => x.sourceKey === `plan:${ldP2}` && x.present === false),
    '展品详情账册对照含合计与已消失来源差额');
  assert(r.body.years && r.body.sources && r.body.plans && r.body.measurements &&
    r.body.blackouts !== undefined, '展品详情既有字段全部保持兼容');

  // 封存年份的额度表仍按当前数据展示（封存不冻结查询口径）
  assert(r.body.years[String(sealYear)].limit === 90000 &&
    r.body.years[String(sealYear)].used === 1200,
    '年度额度表继续按当前数据重算（封存只另存账册）');

  // ---- 未封存年份查询 404 ----
  r = await call('GET', `/api/exhibits/${exLd}/ledgers/${sealYear + 1}`, null, 'i');
  assert(r.status === 404 && /尚无封存账册/.test(r.body.error), '未封存年份查询返回 404');

  // ---- 零差额场景：另一件展品封存后数据不变，所有差额均明确标示为零 ----
  const exLd2 = await createExhibit('账册零差额展品');
  await call('POST', `/api/exhibits/${exLd2}/limits`, { year: sealYear, limitLxh: 5000 }, 'c');
  const ldQ = await submitPlan(exLd2, '零差额计划', `${sealYear}-02-01`, `${sealYear}-02-01`,
    ['09:00-17:00'], 100); // 800
  await approvePlan(ldQ);
  r = await call('POST', `/api/exhibits/${exLd2}/ledgers`, { year: sealYear }, 'c');
  assert(r.status === 201, '零差额展品封存成功');
  r = await call('GET', `/api/exhibits/${exLd2}/ledgers?compare=1`, null, 'i');
  const z = r.body.ledgers[0].comparison;
  assert(z.totals.allZero === true &&
    z.itemDiffs.length === 1 && z.itemDiffs[0].zeroDifference === true &&
    z.itemDiffs[0].sealedDose === 800 && z.itemDiffs[0].currentDose === 800,
    '数据未变化时合计与逐项零差额均明确标示');

  // ---- 封存与同展品占用变动并发：账册不混入变动前后的数据（应用键锁 + 行锁串行）----
  const exLd3 = await createExhibit('账册并发展品');
  await call('POST', `/api/exhibits/${exLd3}/limits`, { year: sealYear, limitLxh: 100000 }, 'c');
  const ldC1 = await submitPlan(exLd3, '并发账册计划', `${sealYear}-03-01`, `${sealYear}-03-01`,
    ['09:00-17:00'], 100);
  await approvePlan(ldC1);
  // 先录一条待确认实测草稿（不计量），并发：保管员确认实测（占用变动）+ 封存同年账册
  r = await call('POST', '/api/measurements', {
    planId: ldC1, startDate: `${sealYear}-03-01`, startTime: '09:00',
    endDate: `${sealYear}-03-01`, endTime: '12:00', actualLux: 200,
  }, 'c');
  const ldDraft = r.body.measurement.id;
  const [confirmRes, sealRes] = await Promise.all([
    call('POST', `/api/measurements/${ldDraft}/confirm`, {}, 'c'),
    call('POST', `/api/exhibits/${exLd3}/ledgers`, { year: sealYear }, 'c'),
  ]);
  assert(confirmRes.status === 200 && sealRes.status === 201,
    '并发的确认实测与封存都成功（串行执行）');
  // 两者必居其一的一致快照：要么账册不含该实测（残余800），要么完整含入（实测600+残余500=1100），
  // 绝不能出现半更新（如实测600但残余仍800）。
  const sealed3 = sealRes.body.ledger;
  const consistent =
    (sealed3.confirmedTotal === 0 && sealed3.residueTotal === 800 && sealed3.total === 800) ||
    (sealed3.confirmedTotal === 600 && sealed3.residueTotal === 500 && sealed3.total === 1100);
  assert(consistent,
    `并发封存账册为变动前或变动后的一致快照，实际=${JSON.stringify({
      c: sealed3.confirmedTotal, r: sealed3.residueTotal, t: sealed3.total })}`);

  // ---- 操作流水：封存事件 ----
  r = await call('GET', '/api/audit?limit=1000', null, 'c');
  assert(r.body.events.some((e) => e.action === 'ledger.seal' &&
    Number(e.target_id) === ledgerId), '操作流水记录了账册封存');

  // ===========================================================================
  // 规则 17：计划外照明事故
  // ===========================================================================

  // ---- 事故：窗内部分替代计划估算，窗外部分单独计量，不释放排期 ----
  const exIn = await createExhibit('计划外事故展品');
  await call('POST', `/api/exhibits/${exIn}/limits`, { year: 2024, limitLxh: 5000 }, 'c');
  const inPlan = await submitPlan(exIn, '事故窗内计划', '2024-05-10', '2024-05-10',
    ['09:00-17:00'], 100); // 毛估算 800
  await approvePlan(inPlan);

  r = await call('POST', '/api/incidents', {
    exhibitId: exIn,
    startDate: '2024-05-10', startTime: '12:00',
    endDate: '2024-05-10', endTime: '22:00',
    actualLux: 200, reason: '闭馆后展柜灯未关',
  }, 'c');
  assert(r.status === 201, '登记跨窗外的照明事故');
  const inc1 = r.body.incident;
  // 事故 12:00-22:00 = 10h × 200 = 2000；窗内 12:00-17:00 = 5h × 200 = 1000；窗外 5h = 1000
  assert(inc1.yearly[2024] === 2000 && inc1.yearlyInside[2024] === 1000 &&
    inc1.yearlyOutside[2024] === 1000 && inc1.insidePlanIds.length === 1,
    '事故按年剂量与窗内/窗外拆分正确');

  r = await call('GET', `/api/exhibits/${exIn}`, null, 'i');
  // 占用：事故 2000 + 计划残余（毛800 − 窗内5h×100=300）= 2300
  assert(r.body.years[2024].used === 2300,
    `事故窗内部分替代估算、窗外部分单独计量（实际 2300，实际=${r.body.years[2024].used}）`);
  const incSrc = r.body.sources.find((s) => s.kind === 'incident' && s.id === inc1.id);
  assert(incSrc && incSrc.yearly[2024] === 2000, '占用来源含事故条目');
  const inPlanSrc = r.body.sources.find((s) => s.kind === 'plan' && s.id === inPlan);
  assert(inPlanSrc.yearly[2024] === 300, '计划估算残余已扣除事故窗内部分（300）');
  assert(r.body.incidentDoseYearly[2024] === 2000 && r.body.incidents.length === 1,
    '展品详情附事故列表与各年事故实际用光汇总');

  r = await call('GET', `/api/incidents?exhibitId=${exIn}`, null, 'i');
  assert(r.status === 200 && r.body.incidents.length === 1 &&
    r.body.incidents[0].yearly[2024] === 2000, '登录用户可查询事故列表');
  r = await call('GET', `/api/incidents?planId=${inPlan}`, null, 'i');
  assert(r.body.incidents.length === 1, '可按计划过滤（与计划窗相交的事故）');

  // ---- 非法输入 400：起止无效 / 照度非正 / 原因缺失 / 未来结束时刻 ----
  r = await call('POST', '/api/incidents', {
    exhibitId: exIn, startDate: '2024-05-11', startTime: '12:00',
    endDate: '2024-05-11', endTime: '12:00', actualLux: 100, reason: 'x',
  }, 'c');
  assert(r.status === 400 && /起点须早于终点/.test(r.body.error), '零时长事故 400');
  r = await call('POST', '/api/incidents', {
    exhibitId: exIn, startDate: '2024-05-11', startTime: '10:00',
    endDate: '2024-05-11', endTime: '09:00', actualLux: 100, reason: 'x',
  }, 'c');
  assert(r.status === 400, '起止倒置 400');
  r = await call('POST', '/api/incidents', {
    exhibitId: exIn, startDate: '2024-05-11', startTime: '10:00',
    endDate: '2024-05-11', endTime: '11:00', actualLux: 0, reason: 'x',
  }, 'c');
  assert(r.status === 400 && /正数/.test(r.body.error), '非正照度 400');
  r = await call('POST', '/api/incidents', {
    exhibitId: exIn, startDate: '2024-05-11', startTime: '10:00',
    endDate: '2024-05-11', endTime: '11:00', actualLux: 100, reason: '   ',
  }, 'c');
  assert(r.status === 400 && /原因/.test(r.body.error), '原因缺失 400');
  r = await call('POST', '/api/incidents', {
    exhibitId: exIn, startDate: '2099-05-11', startTime: '10:00',
    endDate: '2099-05-11', endTime: '11:00', actualLux: 100, reason: 'x',
  }, 'c');
  assert(r.status === 400 && /只能登记已发生/.test(r.body.error), '未来事故 400');
  r = await call('POST', '/api/incidents', {
    exhibitId: 999999, startDate: '2024-05-11', startTime: '10:00',
    endDate: '2024-05-11', endTime: '11:00', actualLux: 100, reason: 'x',
  }, 'c');
  assert(r.status === 400 && /展品不存在/.test(r.body.error), '不存在展品 400');

  // ---- 冲突 409：与未作废实测（含草稿）/ 停灯 / 其他事故相交，一次性指出且不保存 ----
  // 先在计划窗内录一条草稿实测 09:00-10:00
  r = await call('POST', '/api/measurements', {
    planId: inPlan, startDate: '2024-05-10', startTime: '09:00',
    endDate: '2024-05-10', endTime: '10:00', actualLux: 50,
  }, 'c');
  assert(r.status === 201, '录入草稿实测（与后续事故冲突用）');
  // 登记一条停灯 2024-05-10 10:00-11:00（窗内，不与草稿/事故1相交）
  r = await call('POST', '/api/blackouts', {
    planId: inPlan, startDate: '2024-05-10', startTime: '10:00',
    endDate: '2024-05-10', endTime: '11:00', reason: '检修',
  }, 'c');
  assert(r.status === 201, '登记停灯（与后续事故冲突用）');
  r = await call('POST', '/api/incidents', {
    exhibitId: exIn,
    startDate: '2024-05-10', startTime: '09:30',
    endDate: '2024-05-10', endTime: '12:30',
    actualLux: 300, reason: '同时撞三类',
  }, 'c');
  assert(r.status === 409, '事故与草稿实测/停灯/既有事故相交 -> 409');
  assert(r.body.details.overlappingMeasurements.length === 1, 'details 指出冲突实测（含草稿）');
  assert(r.body.details.overlappingBlackouts.length === 1, 'details 指出冲突停灯');
  assert(r.body.details.overlappingIncidents.length === 1, 'details 指出冲突事故');
  r = await call('GET', `/api/incidents?exhibitId=${exIn}`, null, 'i');
  assert(r.body.incidents.length === 1, '冲突事故未保存');

  // ---- 后续实测录入/确认、停灯登记、实测纠错均不得与事故相交 ----
  r = await call('POST', '/api/measurements', {
    planId: inPlan, startDate: '2024-05-10', startTime: '16:00',
    endDate: '2024-05-10', endTime: '16:30', actualLux: 90,
  }, 'c');
  assert(r.status === 409 && r.body.details.overlappingIncidentId === inc1.id,
    '录入与事故相交的实测 -> 409');
  r = await call('POST', '/api/blackouts', {
    planId: inPlan, startDate: '2024-05-10', startTime: '16:00',
    endDate: '2024-05-10', endTime: '16:30', reason: '撞事故',
  }, 'c');
  assert(r.status === 409 && r.body.details.overlappingIncidents.length === 1,
    '登记与事故相交的停灯 -> 409');

  // ---- 事故不可改删；布展员不能登记 ----
  r = await call('DELETE', `/api/incidents/${inc1.id}`, {}, 'c');
  assert(r.status === 400 && /不可删除/.test(r.body.error), '事故不可删除');
  r = await call('POST', '/api/incidents', {
    exhibitId: exIn, startDate: '2024-05-11', startTime: '10:00',
    endDate: '2024-05-11', endTime: '11:00', actualLux: 100, reason: 'x',
  }, 'i');
  assert(r.status === 403, '布展员不能登记事故');

  // ---- 事故不释放排期：事故替代估算但不改变计划间开灯窗重叠判定 ----
  const exRel = await createExhibit('事故不释放排期展品');
  await call('POST', `/api/exhibits/${exRel}/limits`, { year: 2024, limitLxh: 50000 }, 'c');
  const relA = await submitPlan(exRel, '排期计划A', '2024-07-01', '2024-07-01',
    ['09:00-17:00'], 100);
  await approvePlan(relA);
  // 已发生事故完整覆盖 A 的窗（事故不释放 A 的排期）
  r = await call('POST', '/api/incidents', {
    exhibitId: exRel, startDate: '2024-07-01', startTime: '09:00',
    endDate: '2024-07-01', endTime: '17:00', actualLux: 100, reason: '事故覆盖A',
  }, 'c');
  assert(r.status === 201, '事故完整覆盖计划 A（A 的估算残余变为 0，但排期仍占用）');
  r = await call('GET', `/api/exhibits/${exRel}`, null, 'i');
  const relASrc = r.body.sources.find((x) => x.kind === 'plan' && x.id === relA);
  assert((relASrc.yearly[2024] || 0) === 0, 'A 的估算残余为 0（被事故完全替代）');
  // 事故后新建一条撞 A 开灯窗的计划：提交即被拒（A 残余为 0 但排期不释放）
  r = await call('POST', '/api/plans', {
    exhibitId: exRel, title: '排期计划C', startDate: '2024-07-01', endDate: '2024-07-01',
    periods: ['14:00-15:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 409 && /开灯时间重叠/.test(r.body.error) &&
    r.body.details.overlappingPlanId === relA,
    '事故不释放计划排期：撞 A 窗的新计划提交即拒绝（即使 A 残余为 0）');

  // ---- 批准口径含事故实际用光：事故占用额度基数，窗内部分替代本计划估算 ----
  const exIn2 = await createExhibit('事故替代估算展品');
  await call('POST', `/api/exhibits/${exIn2}/limits`, { year: 2024, limitLxh: 1000 }, 'c');
  // 事故 09:00-12:00（200 lx = 600），提交计划 09:00-17:00 100lx（毛800）：
  // 窗内 3h 被事故替代，本计划残余 = 5h×100 = 500；事故 600 作为其他占用基数
  r = await call('POST', '/api/incidents', {
    exhibitId: exIn2, startDate: '2024-06-01', startTime: '09:00',
    endDate: '2024-06-01', endTime: '12:00', actualLux: 200, reason: '白天意外补光',
  }, 'c');
  assert(r.status === 201, '登记事故 600（未超额）');
  const pInside = await submitPlan(exIn2, '与事故窗相交的计划', '2024-06-01', '2024-06-01',
    ['09:00-17:00'], 100);
  r = await call('POST', `/api/plans/${pInside}/approve`, {}, 'c');
  assert(r.status === 409,
    '事故 600 作为占用基数 + 本计划残余 500 = 1100 > 1000，批准拒绝');
  assert(r.body.details.overflows[0].year === 2024 &&
    r.body.details.overflows[0].usedBefore === 600 &&
    r.body.details.overflows[0].addedByThisPlan === 500,
    '超额明细：其他占用（事故）600、本计划残余 500（窗内 3h 已被事故替代，不重复计）');
  // 把上限提高到 1100 后可批准
  await call('POST', `/api/exhibits/${exIn2}/limits`, { year: 2024, limitLxh: 1100 }, 'c');
  r = await call('POST', `/api/plans/${pInside}/approve`, {}, 'c');
  assert(r.status === 200, '事故窗内部分替代估算：上限提到 1100 后可批准');
  r = await call('GET', `/api/exhibits/${exIn2}`, null, 'i');
  assert(r.body.years[2024].used === 1100,
    `批准后占用 = 事故 600 + 计划残余 500 = 1100（实际=${r.body.years[2024].used}）`);

  // ---- 事故跨年：按墙上自然年拆分 ----
  const exIn3 = await createExhibit('事故跨年展品');
  await call('POST', `/api/exhibits/${exIn3}/limits`, { year: 2024, limitLxh: 50000 }, 'c');
  await call('POST', `/api/exhibits/${exIn3}/limits`, { year: 2025, limitLxh: 50000 }, 'c');
  r = await call('POST', '/api/incidents', {
    exhibitId: exIn3, startDate: '2024-12-31', startTime: '20:00',
    endDate: '2025-01-01', endTime: '04:00', actualLux: 100, reason: '跨年通宵意外照明',
  }, 'c');
  assert(r.status === 201, '登记跨年事故');
  const incY = r.body.incident;
  assert(incY.yearly[2024] === 400 && incY.yearly[2025] === 400,
    `事故按墙上自然年拆分（2024=400,2025=400，实际=${JSON.stringify(incY.yearly)}）`);

  // ---- 登记事故超额仍生效：报告超额年份，未开始且仍有残余的已批准计划转待复核 ----
  // 当前墙上时间为 2026-10：用 2026 年内“已发生”的事故 + 同年“尚未开始”的已批准计划。
  const exIn4 = await createExhibit('事故超额转复核展品');
  await call('POST', `/api/exhibits/${exIn4}/limits`, { year: 2026, limitLxh: 1000 }, 'c');
  const inFuturePlan = await submitPlan(exIn4, '事故后待转复核计划', '2026-12-20', '2026-12-20',
    ['09:00-17:00'], 100); // 800，尚未开始
  await approvePlan(inFuturePlan);
  // 已发生事故：2026-10-01 09:00-12:00（窗外，与 12 月计划不相交），3h×400 = 1200
  r = await call('POST', '/api/incidents', {
    exhibitId: exIn4, startDate: '2026-10-01', startTime: '09:00',
    endDate: '2026-10-01', endTime: '12:00', actualLux: 400, reason: '事故致超额',
  }, 'c');
  // 2026：事故 1200 + 计划残余 800 = 2000 > 1000，超额 1000；计划尚未开始 -> 转待复核
  assert(r.status === 409, '事故登记后超额返回 409（事故仍生效）');
  assert(r.body.overflows.some((o) => o.year === 2026 && o.excess === 1000),
    `超额年份与超额量正确（实际=${JSON.stringify(r.body.overflows)}）`);
  assert(r.body.flaggedPlans.length === 1 && r.body.flaggedPlans[0].id === inFuturePlan,
    '相关年度仍有估算残余且尚未开始的已批准计划转待复核');
  r = await call('GET', `/api/plans/${inFuturePlan}`, null, 'i');
  assert(r.body.plan.status === 'pending_review' && /照明事故/.test(r.body.plan.review_reason),
    '计划状态已转待复核且原因注明事故触发');
  // 已开始的已批准计划不转状态：事故超额时只转未开始计划
  const exIn4b = await createExhibit('事故超额已开始计划展品');
  await call('POST', `/api/exhibits/${exIn4b}/limits`, { year: 2024, limitLxh: 50000 }, 'c');
  await call('POST', `/api/exhibits/${exIn4b}/limits`, { year: 2026, limitLxh: 100 }, 'c');
  const startedPlan = await submitPlan(exIn4b, '已开始计划', '2024-08-01', '2024-08-01',
    ['09:00-10:00'], 100);
  await approvePlan(startedPlan);
  r = await call('POST', '/api/incidents', {
    exhibitId: exIn4b, startDate: '2026-10-01', startTime: '13:00',
    endDate: '2026-10-01', endTime: '14:00', actualLux: 200, reason: '事故超额',
  }, 'c');
  assert(r.status === 409 && r.body.flaggedPlans.length === 0,
    '已开始计划不因事故超额转待复核（超额仍在年度表如实显示）');
  // 审计保留
  r = await call('GET', '/api/audit?limit=1000', null, 'c');
  assert(r.body.events.some((e) => e.action === 'incident.create'), '审计含 incident.create');
  assert(r.body.events.some((e) => e.action === 'plan.flag_review_incident'),
    '审计含 plan.flag_review_incident');

  // ---- 上限下调预演口径含事故，且事故变化使旧预演凭证失效 ----
  const exIn5 = await createExhibit('事故预演展品');
  await call('POST', `/api/exhibits/${exIn5}/limits`, { year: 2024, limitLxh: 5000 }, 'c');
  r = await call('POST', `/api/exhibits/${exIn5}/limits/preview`,
    { year: 2024, limitLxh: 400 }, 'c');
  assert(r.status === 200 && r.body.preview.used === 0, '预演初始占用 0');
  const pvToken = r.body.preview.token;
  r = await call('POST', '/api/incidents', {
    exhibitId: exIn5, startDate: '2024-03-01', startTime: '09:00',
    endDate: '2024-03-01', endTime: '10:00', actualLux: 500, reason: '预演后新增事故',
  }, 'c');
  assert(r.status === 201, '预演后登记事故');
  r = await call('POST', `/api/exhibits/${exIn5}/limits/lower`,
    { year: 2024, limitLxh: 400, token: pvToken }, 'c');
  assert(r.status === 409 && r.body.details.preview.used === 500,
    '事故变化使旧预演凭证失效：409 并返回最新核算（used=500）');

  // ---- 已封存账册不因登记事故回写；对照中事故为封存后新增来源 ----
  const exIn6 = await createExhibit('事故账册展品');
  await call('POST', `/api/exhibits/${exIn6}/limits`, { year: 2024, limitLxh: 5000 }, 'c');
  const lgPlan = await submitPlan(exIn6, '账册计划', '2024-04-01', '2024-04-01',
    ['09:00-17:00'], 100); // 800
  await approvePlan(lgPlan);
  r = await call('POST', `/api/exhibits/${exIn6}/ledgers`, { year: 2024 }, 'c');
  assert(r.status === 201, '先封存 2024 账册');
  const sealedId = r.body.ledger.id;
  const sealedBefore = r.body.ledger;
  assert(sealedBefore.incidentTotal === 0 && sealedBefore.total === 800,
    '封存时无事故：事故合计 0、总额 800');
  // 封存后登记事故（窗内 1h：09-10）
  r = await call('POST', '/api/incidents', {
    exhibitId: exIn6, startDate: '2024-04-01', startTime: '09:00',
    endDate: '2024-04-01', endTime: '10:00', actualLux: 300, reason: '封存后发现的事故',
  }, 'c');
  assert(r.status === 201, '封存后仍可登记事故（已封存账册不回写）');
  r = await call('GET', `/api/exhibits/${exIn6}/ledgers/2024`, null, 'i');
  assert(r.body.ledger.id === sealedId && r.body.ledger.total === 800 &&
    r.body.ledger.incidentTotal === 0, '已封存账册保持原样不回写');
  // 当前重算：事故 300；计划残余 800 − 1h×100 = 700；合计 1000
  assert(r.body.current.incidentTotal === 300 && r.body.current.residueTotal === 700 &&
    r.body.current.total === 1000,
    `当前重算含事故（incident=300,residue=700,total=1000，实际=${JSON.stringify({
      i: r.body.current.incidentTotal, rs: r.body.current.residueTotal, t: r.body.current.total })}）`);
  const incDiff = r.body.comparison.itemDiffs.find((d) => d.kind === 'incident');
  assert(incDiff && incDiff.sealed === false && incDiff.present === true &&
    incDiff.currentDose === 300, '事故作为封存后新增来源逐项列出');
  const planDiff = r.body.comparison.itemDiffs.find((d) => d.kind === 'plan');
  assert(planDiff.delta === -100, '被事故窗内部分替代的计划残余差额 -100');

  // ---- 调整/成对/批准口径均含事故窗内扣减（用未来计划在新展品验证）----
  const exIn7 = await createExhibit('事故调整口径展品');
  await call('POST', `/api/exhibits/${exIn7}/limits`, { year: 2024, limitLxh: 50000 }, 'c');
  await call('POST', `/api/exhibits/${exIn7}/limits`, { year: 2030, limitLxh: 50000 }, 'c');
  // 已发生事故（2024 窗外）；再登记一条 2030 不可行（未来），故窗内扣减改用以下方式：
  // 事故只能是已发生时段 -> 2030 未开始计划不可能与已发生事故同窗。
  // 因此调整路径的事故窗内扣减由“窗外事故不影响未来残余” + 占用基数含事故共同保证，
  // 这里验证：未来计划的调整试算/批准正常，且 2024 事故始终计入占用、不释放任何排期。
  const adjPlan = await submitPlan(exIn7, '待调整计划', '2030-03-01', '2030-03-01',
    ['09:00-17:00'], 100); // 800
  await approvePlan(adjPlan);
  r = await call('POST', '/api/incidents', {
    exhibitId: exIn7, startDate: '2024-09-01', startTime: '09:00',
    endDate: '2024-09-01', endTime: '10:00', actualLux: 500, reason: '过去窗外事故',
  }, 'c');
  assert(r.status === 201, '登记窗外事故（500，2024 年）');
  r = await call('POST', '/api/adjustments', {
    planId: adjPlan, startDate: '2030-03-02', endDate: '2030-03-02',
    periods: ['09:00-17:00'], estimatedLux: 100,
  }, 'i');
  assert(r.status === 201 && r.body.adjustment.preview.newResidueYearly[2030] === 800,
    '未来计划调整试算：窗外事故不影响其残余（仍 800）');
  const incAdjId = r.body.adjustment.id;
  r = await call('POST', `/api/adjustments/${incAdjId}/approve`, {}, 'c');
  assert(r.status === 200, '调整批准不受窗外事故影响');
  r = await call('GET', `/api/exhibits/${exIn7}`, null, 'i');
  assert(r.body.years[2024].used === 500 && r.body.years[2030].used === 800,
    '事故 500 始终计入 2024 实际用光，2030 计划残余不变');
}

main().catch((err) => {
  console.error('集成测试失败:', err);
  process.exit(1);
});
