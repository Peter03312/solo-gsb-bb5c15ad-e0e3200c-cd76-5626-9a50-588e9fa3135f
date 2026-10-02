'use strict';

/*
 * 年度用光账册封存路由（规则 16）。
 *   GET  /api/exhibits/:id/ledgers            登录用户：列出该展品全部已封存账册
 *   POST /api/exhibits/:id/ledgers            保管员：封存某已结束自然年（重复封存 409，不覆盖旧账）
 *   GET  /api/exhibits/:id/ledgers/:year      登录用户：取某年封存账册 + 按当前数据重算的对照差额
 * 改/删一律拒绝（旧账始终不可改）。
 */

const express = require('express');
const { withExhibitTransaction } = require('../db');
const { requireRole } = require('../auth');
const { recordAudit } = require('../audit');
const { ValidationError } = require('../validation');
const { lockExhibit } = require('../service');
const {
  buildYearSnapshot,
  snapshotFromLedgerRow,
  diffSnapshots,
  getSealedLedger,
  listSealedLedgers,
  sealYearLedger,
  serializeLedger,
} = require('../ledger');

// mergeParams：路由挂载在 /api/exhibits/:id/ledgers 下，需要父路径的 :id
const router = express.Router({ mergeParams: true });

router.use(require('../auth').requireAuth);

function parseYear(value, field = '年份') {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1900 || year > 2999) {
    throw new ValidationError(`${field}必须是 1900-2999 之间的整数`);
  }
  return year;
}

// 该展品全部已封存账册（列表带封存值；附按当前数据重算的对照，供详情页展示差额）
router.get('/', async (req, res, next) => {
  try {
    const exhibitId = Number(req.params.id);
    const withComparison = req.query.compare === '1' || req.query.compare === 'true';
    const result = await withExhibitTransaction(exhibitId, async (client) => {
      const exist = await client.query('SELECT id FROM exhibits WHERE id = $1', [exhibitId]);
      if (exist.rows.length === 0) throw new ValidationError('展品不存在');
      const rows = await listSealedLedgers(client, exhibitId);
      if (!withComparison) return rows.map((row) => serializeLedger(row));
      const out = [];
      for (const row of rows) {
        const sealedSnap = snapshotFromLedgerRow(row);
        const current = await buildYearSnapshot(client, exhibitId, sealedSnap.year);
        out.push(serializeLedger(row, diffSnapshots(sealedSnap, current)));
      }
      return out;
    });
    res.json({ ledgers: result });
  } catch (err) {
    next(err);
  }
});

// 保管员封存某已结束自然年（原子快照；重复提交 409，不覆盖旧账）
router.post('/', requireRole('conservator'), async (req, res, next) => {
  try {
    const exhibitId = Number(req.params.id);
    const year = parseYear((req.body || {}).year);

    const out = await withExhibitTransaction(exhibitId, async (client) => {
      await lockExhibit(client, exhibitId);
      const { ledger, diff } = await sealYearLedger(client, exhibitId, year, req.sessionUser);

      await recordAudit(client, req.sessionUser, 'ledger.seal', 'annual_ledger', ledger.id, {
        exhibitId,
        year,
        limit: diff.sealed.limit,
        confirmedTotal: diff.sealed.confirmedTotal,
        residueTotal: diff.sealed.residueTotal,
        total: diff.sealed.total,
        itemCount: diff.sealed.items.length,
      });

      // 取封存人姓名后对外返回（拆简单查询，规避内存驱动 JOIN 缺陷）
      const rows = await listSealedLedgers(client, exhibitId);
      const fresh = rows.find((r) => Number(r.id) === Number(ledger.id));
      return serializeLedger(fresh || ledger, diff);
    });
    res.status(201).json({ ledger: out });
  } catch (err) {
    next(err);
  }
});

// 某年封存账册 + 按当前数据重算的同年值、上限和合计差额、逐项来源差额
router.get('/:year', async (req, res, next) => {
  try {
    const exhibitId = Number(req.params.id);
    const year = parseYear(req.params.year, '账册年份');
    const result = await withExhibitTransaction(exhibitId, async (client) => {
      const row = await getSealedLedger(client, exhibitId, year);
      if (!row) {
        const err = new ValidationError(`展品 #${exhibitId} ${year} 年尚无封存账册`);
        err.statusCode = 404;
        throw err;
      }
      const sealedSnap = snapshotFromLedgerRow(row);
      const current = await buildYearSnapshot(client, exhibitId, year);
      const diff = diffSnapshots(sealedSnap, current);
      return { ledger: serializeLedger(row), current, comparison: diff };
    });
    // comparison 同时给一份精简对外形态（ledger 内不再重复内嵌）
    res.json({
      ledger: result.ledger,
      current: {
        year: result.current.year,
        limit: result.current.limit,
        confirmedTotal: result.current.confirmedTotal,
        incidentTotal: result.current.incidentTotal,
        residueTotal: result.current.residueTotal,
        total: result.current.total,
        items: result.current.items,
      },
      comparison: {
        year: result.comparison.year,
        totals: result.comparison.totals,
        itemDiffs: result.comparison.itemDiffs.map((it) => ({
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
      },
    });
  } catch (err) {
    next(err);
  }
});

// 账册永久不可修改/删除：显式拒绝并给出中文原因（GET/POST 之外的方法）。
router.use((req, _res, next) => {
  next(new ValidationError(`年度账册封存后保留，不可${req.method === 'DELETE' ? '删除' : '修改'}`));
});

module.exports = router;
