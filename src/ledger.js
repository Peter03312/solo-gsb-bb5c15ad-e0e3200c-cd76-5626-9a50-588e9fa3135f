'use strict';

/*
 * 年度用光账册封存（规则 16）。
 *
 * 保管员可按展品 + 已结束自然年封存一份“用光账册”。封存时：
 *   - 沿用现有固定时区（config.tzOffsetMs）与统一剂量口径
 *     （已确认实测剂量 + 各已批准/待复核计划“开灯窗 − 已确认实测覆盖 − 本计划停灯”的估算残余）；
 *   - 在展品锁事务内原子记录：当年上限、已确认实测合计、各计划估算残余、合计及逐项来源。
 * 账册永久不可改、不可覆盖；封存后任何既有流程（实测纠错、计划状态/调整、上限变化）照常生效，
 * 本表绝不被改写。展品详情可对照“封存值”与“按当前数据重算的同年值”，包括合计差额与
 * 按来源编号对齐的逐项差额；已消失来源仍列出，零差额明确标示。
 */

const { ValidationError, ConflictError } = require('./validation');
const { computeOccupancy, dateYmd } = require('./service');
const { round3, yearOfTs, tsToWallString } = require('./dosing');
const config = require('./config');

/** JSONB 开灯时段兼容（真实 pg 给数组，内存驱动可能给字符串），与 service 内同名函数同构。 */
function normalizePeriods(value) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (_) {
      throw new ValidationError('开灯时段数据格式无效');
    }
  }
  return value;
}

/**
 * 构造某展品某自然年的账册快照（须在已持有展品行锁的事务内调用，与批准/确认互斥）。
 * 只取该年剂量非零的来源：
 *   - 已确认实测（kind='measurement'）：该年剂量（停灯不减实测）
 *   - 计划外照明事故（kind='incident'）：该年事故实际用光（始终全额计入；
 *     附窗内/窗外拆分，窗内部分替代计划估算、窗外部分单独计量）
 *   - 已批准/待复核计划估算残余（kind='plan'）：开灯窗 − 已确认实测覆盖 − 本计划停灯 − 事故窗内部分
 * 合计 total = confirmedTotal + incidentTotal + residueTotal。
 * 返回：
 *   { year, limit, confirmedTotal, incidentTotal, residueTotal, total, items, sealedAtWall, tzOffsetMinutes }
 * items 元素稳定结构（供封存与重算共用、逐项对齐）：
 *   { sourceKey, kind, id, label, planId?, title?, status?, startDate?, endDate?,
 *     periods?, lux?, start?, end?, yearDose }
 */
async function buildYearSnapshot(client, exhibitId, year) {
  const yearStr = String(year);
  const occupancy = await computeOccupancy(client, exhibitId);
  const limit = occupancy.limits[yearStr] !== undefined && occupancy.limits[yearStr] !== null
    ? round3(occupancy.limits[yearStr])
    : null;

  const items = [];
  let confirmedTotal = 0;
  let incidentTotal = 0;
  let residueTotal = 0;

  // 占用来源的顺序即 computeOccupancy 的顺序：先实测，再事故，后计划（各自按 id 升序）。
  for (const s of occupancy.sources) {
    const yearDose = round3(s.yearly[yearStr] || 0);
    if (yearDose === 0) continue;
    if (s.kind === 'measurement') {
      confirmedTotal = round3(confirmedTotal + yearDose);
      items.push({
        sourceKey: `measurement:${s.id}`,
        kind: 'measurement',
        id: s.id,
        label: `实测 #${s.id}（计划 #${s.planId}）`,
        planId: s.planId,
        start: s.start,
        end: s.end,
        lux: s.lux,
        yearDose,
      });
    } else if (s.kind === 'incident') {
      incidentTotal = round3(incidentTotal + yearDose);
      items.push({
        sourceKey: `incident:${s.id}`,
        kind: 'incident',
        id: s.id,
        label: `计划外照明事故 #${s.id}`,
        start: s.start,
        end: s.end,
        lux: s.lux,
        reason: s.reason,
        insidePlanIds: s.insidePlanIds || [],
        yearInside: round3((s.yearlyInside || {})[yearStr] || 0),
        yearOutside: round3((s.yearlyOutside || {})[yearStr] || 0),
        yearDose,
      });
    } else {
      residueTotal = round3(residueTotal + yearDose);
      items.push({
        sourceKey: `plan:${s.id}`,
        kind: 'plan',
        id: s.id,
        label: `估算残余 · 计划 #${s.id}「${s.title}」`,
        title: s.title,
        status: s.status,
        startDate: dateYmd(s.startDate),
        endDate: dateYmd(s.endDate),
        periods: normalizePeriods(s.periods),
        lux: s.lux,
        yearDose,
      });
    }
  }

  return {
    year,
    limit,
    confirmedTotal,
    incidentTotal,
    residueTotal,
    total: round3(confirmedTotal + incidentTotal + residueTotal),
    items,
  };
}

/** 反序列化已封存账册（snapshot_json）为与 buildYearSnapshot 同构的快照对象。 */
function snapshotFromLedgerRow(row) {
  const snap = row.snapshot_json || {};
  return {
    year: Number(row.year),
    limit: row.limit_lxh !== null && row.limit_lxh !== undefined ? round3(Number(row.limit_lxh)) : null,
    confirmedTotal: round3(Number(row.confirmed_lxh)),
    // 旧账（事故功能上线前封存）没有 incidentTotal：按 0 处理，总额列保持原样
    incidentTotal: snap.incidentTotal !== undefined ? round3(Number(snap.incidentTotal)) : 0,
    residueTotal: round3(Number(row.residue_lxh)),
    total: round3(Number(row.total_lxh)),
    items: Array.isArray(snap.items) ? snap.items : [],
    sealedAtWall: snap.sealedAtWall || null,
    tzOffsetMinutes: snap.tzOffsetMinutes !== undefined ? snap.tzOffsetMinutes : null,
  };
}

/**
 * 对照封存快照与当前重算快照。
 * 逐项按 sourceKey（kind:id）对齐：
 *   - 仅封存中有：present=false（已消失来源，仍列出，currentDose=null，差额以封存值计为 -sealed）
 *   - 两者都有：present=true，列出封存值、当前值、差额；差额为 0 时 zeroDifference=true
 *   - 仅当前有：present=true 且 sealed=false（封存后新增来源），sealedDose=null
 * 合计行同样逐项标示 zeroDifference（差额绝对值小于 0.005 视为零）。
 */
function diffSnapshots(sealed, current) {
  const EPS = 0.005;
  const currentByKey = new Map((current.items || []).map((it) => [it.sourceKey, it]));
  const sealedKeys = new Set((sealed.items || []).map((it) => it.sourceKey));

  const itemDiffs = [];
  for (const sealedItem of sealed.items || []) {
    const cur = currentByKey.get(sealedItem.sourceKey);
    const sealedDose = round3(sealedItem.yearDose || 0);
    if (cur) {
      const currentDose = round3(cur.yearDose || 0);
      const delta = round3(currentDose - sealedDose);
      itemDiffs.push({
        sourceKey: sealedItem.sourceKey,
        kind: sealedItem.kind,
        id: sealedItem.id,
        label: sealedItem.label,
        sealed: true,
        present: true,
        sealedDose,
        currentDose,
        delta,
        zeroDifference: Math.abs(delta) < EPS,
        sealedItem,
        currentItem: cur,
      });
    } else {
      itemDiffs.push({
        sourceKey: sealedItem.sourceKey,
        kind: sealedItem.kind,
        id: sealedItem.id,
        label: sealedItem.label,
        sealed: true,
        present: false,
        sealedDose,
        currentDose: null,
        delta: round3(-sealedDose),
        zeroDifference: false,
        sealedItem,
        currentItem: null,
      });
    }
  }
  for (const curItem of current.items || []) {
    if (sealedKeys.has(curItem.sourceKey)) continue;
    const currentDose = round3(curItem.yearDose || 0);
    itemDiffs.push({
      sourceKey: curItem.sourceKey,
      kind: curItem.kind,
      id: curItem.id,
      label: curItem.label,
      sealed: false,
      present: true,
      sealedDose: null,
      currentDose,
      delta: currentDose,
      zeroDifference: false,
      sealedItem: null,
      currentItem: curItem,
    });
  }

  const field = (name, sealedVal, currentVal) => {
    const hasSealed = sealedVal !== null && sealedVal !== undefined;
    const hasCurrent = currentVal !== null && currentVal !== undefined;
    let delta = null;
    if (hasSealed && hasCurrent) delta = round3(currentVal - sealedVal);
    return {
      field: name,
      sealedDose: hasSealed ? round3(sealedVal) : null,
      currentDose: hasCurrent ? round3(currentVal) : null,
      delta,
      zeroDifference: delta !== null && Math.abs(delta) < EPS,
    };
  };

  const totals = {
    limit: field('limit', sealed.limit, current.limit),
    confirmedTotal: field('confirmedTotal', sealed.confirmedTotal, current.confirmedTotal),
    incidentTotal: field(
      'incidentTotal',
      sealed.incidentTotal !== undefined ? sealed.incidentTotal : 0,
      current.incidentTotal !== undefined ? current.incidentTotal : 0
    ),
    residueTotal: field('residueTotal', sealed.residueTotal, current.residueTotal),
    total: field('total', sealed.total, current.total),
  };
  totals.allZero =
    totals.limit.zeroDifference &&
    totals.confirmedTotal.zeroDifference &&
    totals.incidentTotal.zeroDifference &&
    totals.residueTotal.zeroDifference &&
    totals.total.zeroDifference;
  totals.anyItemDifference = itemDiffs.some((it) => !it.zeroDifference);

  return { year: sealed.year, sealed, current, totals, itemDiffs };
}

/** 取出某展品某年已封存账册（无则 null）。 */
async function getSealedLedger(client, exhibitId, year) {
  const { rows } = await client.query(
    'SELECT * FROM annual_ledgers WHERE exhibit_id = $1 AND year = $2',
    [exhibitId, year]
  );
  return rows[0] || null;
}

/** 列出某展品全部已封存账册（按年降序），附封存人姓名。 */
async function listSealedLedgers(client, exhibitId) {
  const { rows } = await client.query(
    `SELECT l.*, u.display_name AS creator_name
       FROM annual_ledgers l
       LEFT JOIN users u ON u.id = l.created_by
      WHERE l.exhibit_id = $1
      ORDER BY l.year DESC, l.id DESC`,
    [exhibitId]
  );
  return rows;
}

/** 账册对外形态（驼峰）；includeDiff 时附带按当前数据重算的对照。 */
function serializeLedger(row, diff = null) {
  const snap = snapshotFromLedgerRow(row);
  return {
    id: row.id,
    exhibitId: Number(row.exhibit_id),
    year: Number(row.year),
    limit: snap.limit,
    confirmedTotal: snap.confirmedTotal,
    incidentTotal: snap.incidentTotal !== undefined ? snap.incidentTotal : 0,
    residueTotal: snap.residueTotal,
    total: snap.total,
    items: snap.items,
    sealedBy: row.created_by != null ? Number(row.created_by) : null,
    sealedByName: row.creator_name != null ? row.creator_name : (row.creatorName || null),
    sealedAt: row.created_at,
    sealedAtWall: snap.sealedAtWall,
    tzOffsetMinutes: snap.tzOffsetMinutes,
    ...(diff ? { comparison: serializeDiff(diff) } : {}),
  };
}

/** 对照结果对外形态（数值与标记，剥离内部整条对象，避免冗余）。 */
function serializeDiff(diff) {
  return {
    year: diff.year,
    totals: diff.totals,
    itemDiffs: diff.itemDiffs.map((it) => ({
      sourceKey: it.sourceKey,
      kind: it.kind,
      id: it.id,
      label: it.label,
      sealed: it.sealed,
      present: it.present,
      sealedDose: it.sealedDose,
      currentDose: it.currentDose,
      delta: it.delta,
      zeroDifference: it.zeroDifference,
    })),
  };
}

/**
 * 封存校验并落账（由路由在展品锁事务内、已持有展品行锁后调用）。
 * 拒绝条件：
 *   - 年份非法（400，路由层先校验）
 *   - 该年未登记上限（400）
 *   - 年份尚未结束（墙上当前时间仍属该年或更早；400）
 *   - 已封存（409，重复提交不得覆盖旧账，details 带既有账册编号）
 * 通过则原子写入账册并返回 { ledger: 行, snapshot, diff }（diff 为封存瞬间对照，必然全零差额）。
 */
async function sealYearLedger(client, exhibitId, year, actor, { nowMs = Date.now() } = {}) {
  const wallYear = yearOfTs(nowMs);
  if (year >= wallYear) {
    throw new ValidationError(
      `${year} 自然年尚未结束（当前墙上时间为 ${wallYear} 年），只能封存已结束自然年的用光账册`
    );
  }

  const existing = await getSealedLedger(client, exhibitId, year);
  if (existing) {
    throw new ConflictError(
      `展品 #${exhibitId} ${year} 年的用光账册已封存（账册 #${existing.id}），旧账不可修改或覆盖`,
      { existingLedgerId: existing.id, year }
    );
  }

  const snapshot = await buildYearSnapshot(client, exhibitId, year);
  if (snapshot.limit === null) {
    throw new ValidationError(`${year} 年尚未登记年度上限，不能封存用光账册；请先登记该年度上限`);
  }

  const inserted = await client.query(
    `INSERT INTO annual_ledgers
       (exhibit_id, year, limit_lxh, confirmed_lxh, residue_lxh, total_lxh,
        snapshot_json, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     RETURNING *`,
    [
      exhibitId,
      year,
      snapshot.limit,
      snapshot.confirmedTotal,
      snapshot.residueTotal,
      snapshot.total,
      JSON.stringify({
        items: snapshot.items,
        incidentTotal: snapshot.incidentTotal,
        sealedAtWall: tsToWallString(nowMs),
        sealedAtMs: nowMs,
        tzOffsetMinutes: config.tzOffsetMinutes,
      }),
      actor.userId,
    ]
  );

  // 封存瞬间按当前数据重算即等于快照本身：逐项/合计差额全部为 0（明确标示）。
  const sealedSnap = snapshotFromLedgerRow(inserted.rows[0]);
  const diff = diffSnapshots(sealedSnap, snapshot);
  return { ledger: inserted.rows[0], snapshot, diff };
}

module.exports = {
  buildYearSnapshot,
  snapshotFromLedgerRow,
  diffSnapshots,
  getSealedLedger,
  listSealedLedgers,
  serializeLedger,
  serializeDiff,
  sealYearLedger,
};
