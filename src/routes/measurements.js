'use strict';

const express = require('express');
const { query, withTransaction, withExhibitTransaction } = require('../db');
const { requireRole, requireAuth } = require('../auth');
const { recordAudit } = require('../audit');
const {
  ValidationError,
  ConflictError,
  assertDate,
  positiveNumber,
  parseTimeToMinutes,
} = require('../validation');
const {
  lockExhibit,
  getPlan,
  getOccupyingPlans,
  validateMeasurementWindow,
  correctMeasurement,
  computeOccupancy,
  plansToFlag,
} = require('../service');
const { doseByYear, yearMapToObject, tsToWallString } = require('../dosing');
const { exhibitDetail, serializeMeasurement } = require('./exhibits');

const router = express.Router();

router.use(requireAuth);

/** 解析实测时段请求体：{ date, startTime, endTime } 或跨日起止对。 */
function parseMeasurementBody(body) {
  const startDate = assertDate(body.startDate, '实测开始日期');
  const endDate = body.endDate ? assertDate(body.endDate, '实测结束日期') : startDate;
  const startMinute = parseTimeToMinutes(body.startTime);
  const endMinute = parseTimeToMinutes(body.endTime);
  if (endDate < startDate) throw new ValidationError('实测结束日期不能早于开始日期');
  return { startDate, endDate, startMinute, endMinute };
}

/**
 * 按「确认实测生效后的占用」找出超额自然年（沿用确认实测口径）。
 * occupancy 必须是按 extraMeasurement 预演得到的占用结果；
 * candidateYears 限定为本次剂量实际影响到的年份（新/旧实测按年剂量年份的并集），
 * 避免把与本次操作无关、本已超限的年份也列入响应。
 */
function overflowInfoFromOccupancy(occupancy, candidateYears) {
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
  return { overflows, overflowYears };
}

/**
 * 把超额年份对应的「同展品、已批准、该年仍有估算残余且尚未开始」的计划转待复核，
 * 逐条写审计；返回被转计划的概要（与确认实测响应同构）。
 */
async function flagPlansForOverflow(client, actor, { exhibitId, occupancy, overflowYears, trigger, reason }) {
  const activePlans = await getOccupyingPlans(client, exhibitId);
  const flaggedTargets = plansToFlag(activePlans, occupancy, overflowYears, Date.now());
  const flagged = flaggedTargets.map(({ plan: fp, firstStart }) => ({
    id: fp.id,
    title: fp.title,
    firstStart: tsToWallString(firstStart),
    overflowYears,
  }));
  for (const { plan: fp } of flaggedTargets) {
    await client.query(
      `UPDATE plans
          SET status = 'pending_review',
              review_reason = $2,
              updated_at = now()
        WHERE id = $1`,
      [fp.id, reason(fp.id)]
    );
    await recordAudit(client, actor, 'plan.flag_review', 'plan', fp.id, {
      ...trigger,
      overflowYears,
    });
  }
  return flagged;
}

// 实测列表（可按展品过滤）
router.get('/', async (req, res, next) => {
  try {
    const exhibitId = req.query.exhibitId ? Number(req.query.exhibitId) : null;
    const { rows } = await query(
      `SELECT m.*, p.title AS plan_title
         FROM measurements m JOIN plans p ON p.id = m.plan_id
        WHERE ($1::bigint IS NULL OR m.exhibit_id = $1)
        ORDER BY m.start_ts DESC, m.id DESC`,
      [exhibitId]
    );
    res.json({ measurements: rows.map(serializeMeasurement) });
  } catch (err) {
    next(err);
  }
});

/**
 * 保管员录入实测（draft）。
 * 校验：属于已批准计划、时段在计划开灯窗内、不与既有实测重叠、照度为正。
 */
router.post('/', requireRole('conservator'), async (req, res, next) => {
  try {
    const planId = Number(req.body.planId);
    if (!Number.isInteger(planId)) throw new ValidationError('计划 ID 无效');
    const { startDate, endDate, startMinute, endMinute } = parseMeasurementBody(req.body || {});
    const actualLux = positiveNumber(req.body.actualLux, '实测照度（lx）', { max: 1000000 });
    const note = typeof req.body.note === 'string' ? req.body.note.slice(0, 1000) : null;

    const prePlan = await getPlan({ query }, planId);
    const { measurement } = await withExhibitTransaction(prePlan.exhibit_id, async (client) => {
      await lockExhibit(client, prePlan.exhibit_id);
      const plan = await getPlan(client, planId);
      const { start, end } = await validateMeasurementWindow(
        client, plan, startDate, startMinute, endDate, endMinute
      );
      const inserted = await client.query(
        `INSERT INTO measurements
           (plan_id, exhibit_id, start_ts, end_ts, actual_lux, note, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7) RETURNING *`,
        [planId, plan.exhibit_id, new Date(start), new Date(end), actualLux, note,
          req.sessionUser.userId]
      );
      const yearly = yearMapToObject(doseByYear([{ start, end }], actualLux));
      await recordAudit(client, req.sessionUser, 'measurement.create', 'measurement',
        inserted.rows[0].id, { planId, exhibitId: plan.exhibit_id, actualLux, yearly });
      return { measurement: serializeMeasurement(inserted.rows[0]) };
    });
    res.status(201).json({ measurement });
  } catch (err) {
    next(err);
  }
});

/**
 * 保管员确认实测：以实测替代估算；若因此造成某自然年超限：
 *   返回 409 与按年超额明细，并把该展品在相应年度尚未开始的已批准计划转为待复核，
 *   原审批与测量记录全部保留。
 */
router.post('/:id/confirm', requireRole('conservator'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const preRow = await query('SELECT exhibit_id, plan_id FROM measurements WHERE id = $1', [id]);
    if (preRow.rows.length === 0) throw new ValidationError('实测记录不存在');
    const exhibitId = preRow.rows[0].exhibit_id;
    const result = await withExhibitTransaction(exhibitId, async (client) => {
      await lockExhibit(client, exhibitId);
      const mRow = await client.query('SELECT * FROM measurements WHERE id = $1 FOR UPDATE', [id]);
      const measurement = mRow.rows[0];
      if (!measurement) throw new ValidationError('实测记录不存在');
      if (measurement.status === 'annulled') throw new ValidationError('该实测已作废，不能确认');
      if (measurement.status === 'confirmed') throw new ValidationError('该实测已确认');

      const plan = await getPlan(client, measurement.plan_id);

      // 确认时再次检查重叠（可能在录入后有其他记录插入；draft 也参与重叠占用）
      const start = new Date(measurement.start_ts).getTime();
      const end = new Date(measurement.end_ts).getTime();
      const { rows: clashRows } = await client.query(
        `SELECT id FROM measurements
          WHERE exhibit_id = $1 AND id <> $2 AND status <> 'annulled'
            AND start_ts < $4 AND end_ts > $3
          LIMIT 1`,
        [plan.exhibit_id, id, new Date(start), new Date(end)]
      );
      if (clashRows.length > 0) {
        throw new ConflictError(`与已登记实测 #${clashRows[0].id} 时间重叠，确认被拒绝`, {
          overlappingMeasurementId: clashRows[0].id,
        });
      }

      // 停灯记录与实测互斥：后续录入的实测碰到既有停灯时段同样拒绝
      const { rows: blackoutClashRows } = await client.query(
        `SELECT id, plan_id FROM blackouts
          WHERE exhibit_id = $1
            AND start_ts < $3 AND end_ts > $2
          LIMIT 1`,
        [plan.exhibit_id, new Date(start), new Date(end)]
      );
      if (blackoutClashRows.length > 0) {
        throw new ConflictError(
          `实测时段与停灯记录 #${blackoutClashRows[0].id}（计划 #${blackoutClashRows[0].plan_id}）相交，确认被拒绝；停灯记录不可修改/删除`,
          { overlappingBlackoutId: blackoutClashRows[0].id }
        );
      }

      // 计划外照明事故与实测互斥：后续录入/确认的实测碰到既有事故时段同样拒绝
      const { rows: incidentClashRows } = await client.query(
        `SELECT id FROM lighting_incidents
          WHERE exhibit_id = $1
            AND start_ts < $3 AND end_ts > $2
          LIMIT 1`,
        [plan.exhibit_id, new Date(start), new Date(end)]
      );
      if (incidentClashRows.length > 0) {
        throw new ConflictError(
          `实测时段与计划外照明事故 #${incidentClashRows[0].id} 相交，确认被拒绝；事故已按实际用光计量，事故记录不可修改/删除`,
          { overlappingIncidentId: incidentClashRows[0].id }
        );
      }

      // 预演确认后的额度占用
      const occupancy = await computeOccupancy(client, plan.exhibit_id, {
        extraMeasurement: {
          planId: plan.id,
          start,
          end,
          lux: Number(measurement.actual_lux),
        },
      });

      const yearly = yearMapToObject(
        doseByYear([{ start, end }], Number(measurement.actual_lux))
      );
      const overflowYears = [];
      const overflows = [];
      for (const [yearStr, dose] of Object.entries(yearly)) {
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

      await client.query(
        `UPDATE measurements
            SET status = 'confirmed', confirmed_by = $1, confirmed_at = now()
          WHERE id = $2`,
        [req.sessionUser.userId, id]
      );
      await recordAudit(client, req.sessionUser, 'measurement.confirm', 'measurement', id, {
        planId: plan.id,
        exhibitId: plan.exhibit_id,
        actualLux: Number(measurement.actual_lux),
        start: tsToWallString(start),
        end: tsToWallString(end),
        overflows,
      });

      let flagged = [];
      if (overflowYears.length > 0) {
        flagged = await flagPlansForOverflow(client, req.sessionUser, {
          exhibitId: plan.exhibit_id,
          occupancy,
          overflowYears,
          trigger: { triggerMeasurementId: id },
          reason: () =>
            `实测 #${id} 确认后导致 ${overflowYears.join('、')} 年额度超限，转待复核`,
        });
      }

      const detail = await exhibitDetail(client, plan.exhibit_id, { lock: true });
      return { detail, overflows, overflowYears, flagged };
    });

    if (result.overflows.length > 0) {
      // 实测确认生效，但触发超限：用 409 明确报告年份与超额量及被转待复核的计划
      return res.status(409).json({
        message:
          `实测确认后超限：` +
          result.overflows.map((o) => `${o.year} 年超出 ${o.excess} lx·h`).join('；') +
          (result.flagged.length
            ? `。已将 ${result.flagged.length} 条尚未开始的计划转为待复核`
            : '；该年度没有尚未开始的已批准计划'),
        overflows: result.overflows,
        flaggedPlans: result.flagged,
        detail: result.detail,
      });
    }
    res.json(result.detail);
  } catch (err) {
    next(err);
  }
});

/**
 * 保管员对「已确认实测」发起纠错：
 * 用原记录编号（路径 :id）、替代时段、替代照度与必填原因，在展品锁事务内：
 *   1. 校验（service.correctMeasurement）：原记录已确认；替代时段正时长、完整处于原计划开灯窗内；
 *      不与同展品其他未作废实测（含草稿）或停灯相交；替代照度为正、原因必填。
 *      非法输入 400；相交冲突 409（details 一次性列出全部冲突），失败原记录与额度均不变。
 *   2. 通过后保留旧记录并标记作废，确认替代记录（直接 confirmed），写入两者关联与审计。
 *   3. 按既有自然年口径重算已确认实测与估算残余（展品详情即反映最新占用）。
 *   4. 若纠错使年度超额，沿用确认实测的生效与冲突响应口径：
 *      纠错照常生效，把相关年度仍有估算残余且尚未开始的已批准计划转待复核（写明原因），
 *      返回 409 与年份/超额量/被转计划；占用下降不自动恢复任何既有待复核计划。
 */
router.post('/:id/correct', requireRole('conservator'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError('实测记录 ID 无效');
    const { startDate, endDate, startMinute, endMinute } = parseMeasurementBody(req.body || {});
    const actualLux = positiveNumber(req.body.actualLux, '替代实测照度（lx）', { max: 1000000 });
    const reason = req.body && typeof req.body.reason === 'string'
      ? req.body.reason.trim() : '';
    if (!reason) throw new ValidationError('纠错原因不能为空');

    const preRow = await query('SELECT exhibit_id FROM measurements WHERE id = $1', [id]);
    if (preRow.rows.length === 0) throw new ValidationError('实测记录不存在');
    const exhibitId = preRow.rows[0].exhibit_id;

    const result = await withExhibitTransaction(exhibitId, async (client) => {
      await lockExhibit(client, exhibitId);

      const corrected = await correctMeasurement(client, id, {
        startDate, endDate, startMinute, endMinute, actualLux, reason,
      }, req.sessionUser);
      const { plan, original, replacement, startMs, endMs, lux } = corrected;

      const oldYearly = yearMapToObject(
        doseByYear(
          [{ start: new Date(original.start_ts).getTime(), end: new Date(original.end_ts).getTime() }],
          Number(original.actual_lux)
        )
      );
      const newYearly = yearMapToObject(doseByYear([{ start: startMs, end: endMs }], lux));
      const candidateYears = new Set(
        [...Object.keys(oldYearly), ...Object.keys(newYearly)].map(Number)
      );

      // 纠错生效后的占用：原记录已置 annulled（不再计量），替代记录为 confirmed。
      const occupancy = await computeOccupancy(client, plan.exhibit_id);
      const { overflows, overflowYears } = overflowInfoFromOccupancy(occupancy, candidateYears);

      await recordAudit(client, req.sessionUser, 'measurement.correct', 'measurement',
        replacement.id, {
          exhibitId: plan.exhibit_id,
          planId: plan.id,
          originalMeasurementId: id,
          replacementMeasurementId: replacement.id,
          reason,
          from: {
            start: tsToWallString(new Date(original.start_ts).getTime()),
            end: tsToWallString(new Date(original.end_ts).getTime()),
            actualLux: Number(original.actual_lux),
            yearly: oldYearly,
          },
          to: {
            start: tsToWallString(startMs),
            end: tsToWallString(endMs),
            actualLux: lux,
            yearly: newYearly,
          },
          overflows,
        });

      let flagged = [];
      if (overflowYears.length > 0) {
        flagged = await flagPlansForOverflow(client, req.sessionUser, {
          exhibitId: plan.exhibit_id,
          occupancy,
          overflowYears,
          trigger: { triggerMeasurementId: replacement.id, correctedMeasurementId: id },
          reason: () =>
            `实测 #${id} 纠错为 #${replacement.id} 后导致 ${overflowYears.join('、')} 年额度超限，转待复核`,
        });
      }

      const detail = await exhibitDetail(client, plan.exhibit_id, { lock: true });
      const correction = {
        originalMeasurementId: id,
        replacementMeasurementId: replacement.id,
        reason,
        original: {
          id,
          start: tsToWallString(new Date(original.start_ts).getTime()),
          end: tsToWallString(new Date(original.end_ts).getTime()),
          actualLux: Number(original.actual_lux),
          yearly: oldYearly,
        },
        replacement: {
          id: replacement.id,
          start: tsToWallString(startMs),
          end: tsToWallString(endMs),
          actualLux: lux,
          yearly: newYearly,
        },
      };
      return { detail, overflows, flagged, correction };
    });

    if (result.overflows.length > 0) {
      // 纠错已生效但造成超限：沿用确认实测口径，用 409 报告年份、超额量及被转待复核的计划
      return res.status(409).json({
        message:
          `实测纠错已生效（#${result.correction.originalMeasurementId} → ` +
          `#${result.correction.replacementMeasurementId}），但纠错后超限：` +
          result.overflows.map((o) => `${o.year} 年超出 ${o.excess} lx·h`).join('；') +
          (result.flagged.length
            ? `。已将 ${result.flagged.length} 条尚未开始的计划转为待复核`
            : '；该年度没有尚未开始的已批准计划'),
        overflows: result.overflows,
        flaggedPlans: result.flagged,
        correction: result.correction,
        detail: result.detail,
      });
    }
    res.json({ ...result.detail, correction: result.correction });
  } catch (err) {
    next(err);
  }
});

/** 删除未确认（draft）实测记录。已确认记录不可删除/修改（保留原始测量记录）。 */
router.delete('/:id', requireRole('conservator'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM measurements WHERE id = $1', [id]);
      const measurement = rows[0];
      if (!measurement) throw new ValidationError('实测记录不存在');
      if (measurement.status !== 'draft') {
        throw new ValidationError('只有未确认的实测可以删除；已确认记录须保留');
      }
      await client.query('DELETE FROM measurements WHERE id = $1', [id]);
      await recordAudit(client, req.sessionUser, 'measurement.delete_draft', 'measurement', id, {
        planId: measurement.plan_id,
      });
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
