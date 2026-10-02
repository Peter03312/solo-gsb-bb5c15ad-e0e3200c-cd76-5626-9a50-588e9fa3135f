'use strict';

/*
 * 计划外照明事故（规则 17）路由：
 *   GET  /api/incidents?exhibitId=          登录用户：列出展品事故（逐条附实际按年剂量与对估算的替代）
 *   POST /api/incidents                     保管员：登记已发生的计划外照明事故
 * 事故记录一经保存永久保留：PUT/DELETE /api/incidents/:id 返回 400。
 */

const express = require('express');
const { withExhibitTransaction, query } = require('../db');
const { requireRole } = require('../auth');
const { recordAudit } = require('../audit');
const {
  ValidationError,
  assertDate,
  parseTimeToMinutes,
} = require('../validation');
const {
  lockExhibit,
  getOccupyingPlans,
  loadIncidentView,
  registerIncident,
  plansToFlag,
  computeOccupancy,
  planWindows,
} = require('../service');
const {
  wallToTs,
  tsToWallString,
  doseByYear,
  yearMapToObject,
  clipIntervalToWindows,
} = require('../dosing');
const { exhibitDetail } = require('./exhibits');

const router = express.Router();

router.use(require('../auth').requireAuth);

/** 事故记录对外字段（驼峰）。 */
function serializeIncident(x) {
  return {
    id: x.id,
    exhibitId: Number(x.exhibitId != null ? x.exhibitId : x.exhibit_id),
    start: x.start,
    end: x.end,
    actualLux: Number(x.actualLux != null ? x.actualLux : x.actual_lux),
    reason: x.reason,
    createdBy: x.createdBy != null ? x.createdBy : x.created_by,
    creatorName: x.creatorName != null ? x.creatorName : (x.creator_name || null),
    createdAt: x.createdAt != null ? x.createdAt : x.created_at,
    // 事故实际用光按年剂量（lx·h，跨年按墙上自然年拆分；始终计入实际用光）
    yearly: x.yearly || {},
    // 落在各已批准/待复核计划开灯窗内、按计划预计照度替代的估算剂量；窗外部分单独计量
    replacements: x.replacements || [],
  };
}

/**
 * 事故列表（只读，任何登录用户均可查；布展员只读）。
 * 过滤参数：exhibitId（必填）。返回逐条事故及全展品事故实际用光按年合计 incidentYearlyByExhibit。
 */
router.get('/', async (req, res, next) => {
  try {
    const exhibitId = req.query.exhibitId ? Number(req.query.exhibitId) : null;
    if (!Number.isInteger(exhibitId)) {
      throw new ValidationError('展品 ID 无效');
    }
    const exist = await query('SELECT id FROM exhibits WHERE id = $1', [exhibitId]);
    if (exist.rows.length === 0) throw new ValidationError('展品不存在');

    const view = await loadIncidentView({ query }, exhibitId);
    const items = view.items
      .map(serializeIncident)
      .sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : b.id - a.id));
    res.json({
      incidents: items,
      incidentYearlyByExhibit: { [String(exhibitId)]: view.totalYearly },
    });
  } catch (err) {
    next(err);
  }
});

/** 解析事故时段请求体：{ exhibitId, startDate, startTime, endDate, endTime, actualLux, reason }。 */
function parseIncidentBody(body) {
  const exhibitId = Number(body.exhibitId);
  if (!Number.isInteger(exhibitId)) throw new ValidationError('展品 ID 无效');
  const startDate = assertDate(body.startDate, '事故开始日期');
  const endDate = body.endDate ? assertDate(body.endDate, '事故结束日期') : startDate;
  const startMinute = parseTimeToMinutes(body.startTime);
  const endMinute = parseTimeToMinutes(body.endTime);
  if (endDate < startDate) throw new ValidationError('事故结束日期不能早于开始日期');
  return {
    exhibitId,
    startMs: wallToTs(startDate, startMinute),
    endMs: wallToTs(endDate, endMinute),
    actualLux: body.actualLux,
    reason: body.reason,
  };
}

/**
 * 保管员登记计划外照明事故：
 *  - 起点早于终点；结束不晚于当前时间；实际照度为正；原因必填
 *  - 不要求落在计划开灯窗内；不得与同展品未作废实测（含草稿）、停灯、其他事故相交
 * 失败一次性指出全部冲突（409），不保存；事故一经保存不可修改/删除。
 * 在展品锁事务内按统一口径重算：事故始终计入实际用光；与已批准/待复核计划开灯窗相交部分
 * 替代相应估算（窗外部分单独计量，不释放计划排期）。
 * 超额仍生效：返回 409 报告超额年份，并把相关年度仍有估算残余且尚未开始的已批准计划转待复核。
 */
router.post('/', requireRole('conservator'), async (req, res, next) => {
  try {
    const input = parseIncidentBody(req.body || {});
    const exhibitId = input.exhibitId;

    const exist = await query('SELECT id FROM exhibits WHERE id = $1', [exhibitId]);
    if (exist.rows.length === 0) throw new ValidationError('展品不存在');

    const result = await withExhibitTransaction(exhibitId, async (client) => {
      await lockExhibit(client, exhibitId);
      const row = await registerIncident(client, input, req.sessionUser);

      const actualYearly = yearMapToObject(
        doseByYear([{ start: input.startMs, end: input.endMs }], Number(row.actual_lux))
      );

      // 登记后按统一口径重算（事故实际用光 + 计划残余被扣窗内部分），并收集超额年份
      const occupancy = await computeOccupancy(client, exhibitId);
      const candidateYears = Object.keys(actualYearly).map(Number);
      const overflows = [];
      const overflowYears = [];
      for (const year of candidateYears) {
        const info = occupancy.years[String(year)];
        if (!info || info.limit === null) continue;
        if (info.over) {
          overflowYears.push(Number(year));
          overflows.push({
            year: Number(year),
            limit: info.limit,
            projected: info.used,
            excess: Math.round((info.used - info.limit) * 1000) / 1000,
          });
        }
      }

      // 事故对各计划估算的替代（按年，按计划预计照度；与统一占用口径一致）
      const activePlans = await getOccupyingPlans(client, exhibitId);
      const replacements = [];
      for (const plan of activePlans) {
        const parts = clipIntervalToWindows(
          { start: input.startMs, end: input.endMs }, planWindows(plan)
        );
        if (parts.length === 0) continue;
        replacements.push({
          planId: Number(plan.id),
          title: plan.title,
          status: plan.status,
          yearly: yearMapToObject(doseByYear(parts, Number(plan.estimated_lux))),
        });
      }

      await recordAudit(client, req.sessionUser, 'incident.create', 'light_incident', row.id, {
        exhibitId,
        start: tsToWallString(input.startMs),
        end: tsToWallString(input.endMs),
        actualLux: Number(row.actual_lux),
        reason: row.reason,
        actualYearly,
        replacements,
        overflows,
      });

      // 超额仍生效：把相关年度仍有估算残余且尚未开始的已批准计划转待复核（沿用确认实测口径）
      const flagged = [];
      if (overflowYears.length > 0) {
        const flaggedTargets = plansToFlag(activePlans, occupancy, overflowYears, Date.now());
        for (const { plan: fp, firstStart } of flaggedTargets) {
          const yearResidues = overflowYears.map((y) => {
            const src = occupancy.sources.find((s) => s.kind === 'plan' && s.id === fp.id);
            return { year: y, residue: src ? (src.yearly[String(y)] || 0) : 0 };
          });
          const reason =
            `计划外照明事故 #${row.id}（${tsToWallString(input.startMs)} ~ ${tsToWallString(input.endMs)}）` +
            `登记后导致 ${overflowYears.join('、')} 年实际用光超限，本计划相关年度估算残余 ` +
            `${yearResidues.map((x) => `${x.year} 年 ${x.residue}`).join('、')} lx·h，转待复核`;
          await client.query(
            `UPDATE plans
                SET status = 'pending_review', review_reason = $2, updated_at = now()
              WHERE id = $1 AND status = 'approved'`,
            [fp.id, reason]
          );
          await recordAudit(client, req.sessionUser, 'plan.flag_review_incident', 'plan', fp.id, {
            triggerIncidentId: row.id,
            exhibitId,
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

      const detailAfter = await exhibitDetail(client, exhibitId, { lock: true });
      // 重新加载事故视图（转待复核可能已改变计划状态；不传 activePlans 以读取最新状态）
      const incidentView = await loadIncidentView(client, exhibitId);
      const fresh = incidentView.items.find((x) => Number(x.id) === Number(row.id)) || null;

      return {
        detailAfter,
        incident: fresh ? serializeIncident(fresh) : null,
        overflows,
        flagged,
      };
    });

    const payload = {
      ...result.detailAfter,
      incident: result.incident,
      overflows: result.overflows,
      flaggedPlans: result.flagged,
    };

    if (result.overflows.length > 0) {
      // 事故已生效但造成超限：沿用确认实测口径，用 409 报告年份、超额量及被转待复核的计划
      return res.status(409).json({
        message:
          `计划外照明事故已登记（#${result.incident ? result.incident.id : ''}），但登记后超限：` +
          result.overflows.map((o) => `${o.year} 年超出 ${o.excess} lx·h`).join('；') +
          (result.flagged.length
            ? `。已将 ${result.flagged.length} 条尚未开始的计划转为待复核`
            : '；该年度没有尚未开始的已批准计划'),
        ...payload,
      });
    }
    res.status(201).json(payload);
  } catch (err) {
    next(err);
  }
});

// 事故记录永久保留：不提供修改/删除接口，显式拒绝并给出中文原因。
router.all('/:id', (req, _res, next) => {
  next(new ValidationError(`计划外照明事故记录保留，不可${req.method === 'DELETE' ? '删除' : '修改'}`));
});

module.exports = { router, serializeIncident };
