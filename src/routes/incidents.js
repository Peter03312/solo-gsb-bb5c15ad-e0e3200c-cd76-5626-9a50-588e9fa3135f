'use strict';

/*
 * 计划外照明事故路由（规则 17）。
 *   GET  /api/incidents          登录用户：事故列表（可按 exhibitId / planId 过滤），附按年剂量
 *   POST /api/incidents          保管员：登记已发生的计划外照明事故（成功响应 = 展品详情 + incident）
 * 事故永久保留、不可修改/删除：PUT/DELETE/:id 一律 400。
 */

const express = require('express');
const { query, withExhibitTransaction } = require('../db');
const { requireRole } = require('../auth');
const { recordAudit } = require('../audit');
const {
  ValidationError,
  assertDate,
  positiveNumber,
  parseTimeToMinutes,
} = require('../validation');
const {
  lockExhibit,
  loadIncidentView,
  registerIncident,
  getOccupyingPlans,
  plansToFlag,
  computeOccupancy,
} = require('../service');
const { wallToTs, tsToWallString, doseByYear, yearMapToObject } = require('../dosing');

const router = express.Router();

router.use(require('../auth').requireAuth);

/** loadIncidentView 条目对外字段（驼峰）。 */
function serializeIncident(x) {
  return {
    id: x.id,
    exhibitId: x.exhibitId,
    start: x.start,
    end: x.end,
    actualLux: x.actualLux,
    reason: x.reason,
    createdBy: x.createdBy,
    creatorName: x.creatorName || null,
    createdAt: x.createdAt,
    // 事故实际用光按年剂量（始终全额计入）
    yearly: x.yearly || {},
    // 与已批准/待复核计划开灯窗相交部分（替代计划估算）/ 窗外部分（单独计量）
    yearlyInside: x.yearlyInside || {},
    yearlyOutside: x.yearlyOutside || {},
    insidePlanIds: x.insidePlanIds || [],
  };
}

/**
 * 事故列表（只读，任何登录用户均可查）。
 * 过滤参数（均可空）：exhibitId / planId（planId 取与该计划当前开灯窗相交的事故）。
 */
router.get('/', async (req, res, next) => {
  try {
    const exhibitId = req.query.exhibitId ? Number(req.query.exhibitId) : null;
    const planId = req.query.planId ? Number(req.query.planId) : null;
    if (exhibitId !== null && !Number.isInteger(exhibitId)) {
      throw new ValidationError('展品 ID 无效');
    }
    if (planId !== null && !Number.isInteger(planId)) {
      throw new ValidationError('计划 ID 无效');
    }

    let targetExhibitIds;
    if (exhibitId !== null) {
      targetExhibitIds = [exhibitId];
    } else if (planId !== null) {
      const pre = await query('SELECT exhibit_id FROM plans WHERE id = $1', [planId]);
      if (pre.rows.length === 0) throw new ValidationError('计划不存在');
      targetExhibitIds = [pre.rows[0].exhibit_id];
    } else {
      const { rows } = await query('SELECT id FROM exhibits ORDER BY id');
      targetExhibitIds = rows.map((r) => r.id);
    }

    const items = [];
    for (const exId of targetExhibitIds) {
      const view = await loadIncidentView({ query }, exId);
      let list = view.items;
      if (planId !== null) list = list.filter((x) => x.insidePlanIds.includes(planId));
      items.push(...list.map(serializeIncident));
    }
    items.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : b.id - a.id));

    res.json({ incidents: items });
  } catch (err) {
    next(err);
  }
});

/** 解析事故请求体：{ exhibitId, startDate, startTime, endDate, endTime, actualLux, reason }。 */
function parseIncidentBody(body) {
  const exhibitId = Number(body.exhibitId);
  if (!Number.isInteger(exhibitId)) throw new ValidationError('展品 ID 无效');
  const startDate = assertDate(body.startDate, '事故开始日期');
  const endDate = body.endDate ? assertDate(body.endDate, '事故结束日期') : startDate;
  const startMinute = parseTimeToMinutes(body.startTime);
  const endMinute = parseTimeToMinutes(body.endTime);
  if (endDate < startDate) throw new ValidationError('事故结束日期不能早于开始日期');
  const actualLux = positiveNumber(body.actualLux, '事故实际照度（lx）', { max: 1000000 });
  return {
    exhibitId,
    startMs: wallToTs(startDate, startMinute),
    endMs: wallToTs(endDate, endMinute),
    actualLux,
    reason: body.reason,
  };
}

/**
 * 保管员登记计划外照明事故：
 *  - 起点早于终点、结束不晚于当前时间、实际照度为正、原因必填（400）；
 *  - 不与同展品未作废实测（含草稿）、停灯、其他事故相交（409，一次性列出全部冲突，不保存）。
 * 通过后在展品锁事务内重算年度占用：事故始终计入实际用光，窗内部分替代计划估算、
 * 窗外部分单独计量，均不释放计划排期。
 * 超额仍生效：201 正常返回；造成超限则 409（事故已生效），报告超额年份并把相关年度
 * 仍有估算残余且尚未开始的已批准计划转待复核（写明由计划外照明事故触发），保留审计。
 * 成功响应为展品详情（兼容字段位于顶层），另附 incident。
 */
router.post('/', requireRole('conservator'), async (req, res, next) => {
  try {
    const input = parseIncidentBody(req.body || {});

    const out = await withExhibitTransaction(input.exhibitId, async (client) => {
      await lockExhibit(client, input.exhibitId);

      // 先校验展品存在（registerIncident 的冲突查询本身不校验展品 id）
      const exist = await client.query('SELECT id FROM exhibits WHERE id = $1', [input.exhibitId]);
      if (exist.rows.length === 0) throw new ValidationError('展品不存在');

      const row = await registerIncident(client, input, req.sessionUser);
      const incidentId = Number(row.id);

      // 登记后按统一口径重算占用（事故窗内部分已自动替代计划估算，窗外部分单独计量）
      const occupancy = await computeOccupancy(client, input.exhibitId);

      const yearly = yearMapToObject(
        doseByYear([{ start: input.startMs, end: input.endMs }], input.actualLux)
      );
      await recordAudit(client, req.sessionUser, 'incident.create', 'lighting_incident', incidentId, {
        exhibitId: input.exhibitId,
        start: tsToWallString(input.startMs),
        end: tsToWallString(input.endMs),
        actualLux: input.actualLux,
        reason: input.reason,
        actualYearly: yearly,
      });

      // 超额年份以本次事故剂量实际影响到的年份为限
      const overflows = [];
      const overflowYears = [];
      for (const yearStr of Object.keys(yearly)) {
        const info = occupancy.years[yearStr];
        if (!info || info.limit === null) continue;
        if (info.over) {
          overflowYears.push(Number(yearStr));
          overflows.push({
            year: Number(yearStr),
            limit: info.limit,
            projected: info.used,
            excess: Math.round((info.used - info.limit) * 1000) / 1000,
          });
        }
      }

      // 超额仍生效：相关年度仍有估算残余且尚未开始的已批准计划转待复核
      const flagged = [];
      if (overflowYears.length > 0) {
        const activePlans = await getOccupyingPlans(client, input.exhibitId);
        const targets = plansToFlag(activePlans, occupancy, overflowYears, Date.now());
        for (const { plan: fp, firstStart } of targets) {
          const reason =
            `计划外照明事故 #${incidentId}（${tsToWallString(input.startMs)} ~ ` +
            `${tsToWallString(input.endMs)}）登记后导致 ${overflowYears.join('、')} 年额度超限，转待复核`;
          await client.query(
            `UPDATE plans
                SET status = 'pending_review', review_reason = $2, updated_at = now()
              WHERE id = $1 AND status = 'approved'`,
            [fp.id, reason]
          );
          await recordAudit(client, req.sessionUser, 'plan.flag_review_incident', 'plan', fp.id, {
            triggerIncidentId: incidentId,
            overflowYears,
          });
          flagged.push({
            id: fp.id,
            title: fp.title,
            firstStart: tsToWallString(firstStart),
            overflowYears,
          });
        }
      }

      const { exhibitDetail } = require('./exhibits');
      const detailAfter = await exhibitDetail(client, input.exhibitId, { lock: true });
      const freshView = await loadIncidentView(client, input.exhibitId);
      const incidentItem = freshView.items.find((x) => x.id === incidentId) || null;
      return {
        detail: detailAfter,
        overflows,
        flagged,
        incident: incidentItem ? serializeIncident(incidentItem) : { id: incidentId, ...yearly },
      };
    });

    if (out.overflows.length > 0) {
      // 事故已生效但造成超限：沿用确认实测口径，用 409 报告年份、超额量及被转待复核的计划
      return res.status(409).json({
        message:
          `计划外照明事故 #${out.incident.id} 已登记并计入实际用光，但登记后超限：` +
          out.overflows.map((o) => `${o.year} 年超出 ${o.excess} lx·h`).join('；') +
          (out.flagged.length
            ? `。已将 ${out.flagged.length} 条尚未开始的计划转为待复核`
            : '；该年度没有尚未开始的已批准计划'),
        overflows: out.overflows,
        flaggedPlans: out.flagged,
        incident: out.incident,
        detail: out.detail,
      });
    }

    res.status(201).json({ ...out.detail, incident: out.incident });
  } catch (err) {
    next(err);
  }
});

// 事故记录永久保留：不提供修改/删除接口，显式拒绝并给出中文原因。
router.all('/:id', (req, _res, next) => {
  next(new ValidationError(`计划外照明事故记录保留，不可${req.method === 'DELETE' ? '删除' : '修改'}`));
});

module.exports = { router, serializeIncident };
