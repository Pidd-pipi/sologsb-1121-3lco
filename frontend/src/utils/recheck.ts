import { db } from './db';
import { newId } from './id';
import type { Plot } from '../types/plot';
import type { TreeRecord } from '../types/tree';
import type { RecheckDiff } from '../types/recheck';
import type { DexieTx } from './merge';

function r2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 由两期样木生成逐株比对表（RecheckView 与离线合并后重算共用） */
export function buildRecheckDiffs(
  plotId: string,
  baseRound: number,
  targetRound: number,
  trees: TreeRecord[],
  generatedAt = Date.now(),
): RecheckDiff[] {
  const baseList = trees.filter((t) => t.plotId === plotId && t.round === baseRound);
  const targetList = trees.filter((t) => t.plotId === plotId && t.round === targetRound);
  const baseMap = new Map<string, TreeRecord>();
  baseList.forEach((t) => baseMap.set(t.treeNo, t));
  const targetMap = new Map<string, TreeRecord>();
  targetList.forEach((t) => targetMap.set(t.treeNo, t));
  const allNos = Array.from(new Set([...baseMap.keys(), ...targetMap.keys()])).sort((a, b) =>
    a.localeCompare(b, 'zh-Hans-CN', { numeric: true }),
  );

  return allNos.map((treeNo) => {
    const b = baseMap.get(treeNo);
    const t = targetMap.get(treeNo);
    const baseDbh = b?.dbhCm;
    const targetDbh = t?.dbhCm;
    const dbhGrowth = baseDbh !== undefined && targetDbh !== undefined ? r2(targetDbh - baseDbh) : 0;
    const heightGrowth = b && t ? r2(t.heightM - b.heightM) : 0;
    const statusChange = b && t && b.status !== t.status ? `${b.status} → ${t.status}` : '';
    const missingReason = !t ? '本期未复测（疑似采伐或倒伏）' : !b ? '本期新增进界木' : '';
    return {
      id: newId('diff'),
      plotId,
      baseRound,
      targetRound,
      treeNo,
      species: t?.species ?? b?.species ?? '',
      baseDbhCm: baseDbh,
      targetDbhCm: targetDbh,
      baseHeightM: b?.heightM,
      targetHeightM: t?.heightM,
      dbhGrowth,
      heightGrowth,
      statusChange,
      missingReason,
      generatedAt,
    };
  });
}

type TableLike<T> = {
  toArray(): Promise<T[]>;
  bulkPut(rows: T[]): Promise<unknown>;
  bulkDelete(keys: string[]): Promise<unknown>;
  where(index: string): { equals(value: string | number): { toArray(): Promise<T[]> } };
};

interface StoreLike {
  plots: TableLike<Plot>;
  trees: TableLike<TreeRecord>;
  rechecks: TableLike<RecheckDiff>;
}

function storeFrom(tx?: DexieTx): StoreLike {
  if (tx) {
    return {
      plots: tx.table('plots'),
      trees: tx.table('trees'),
      rechecks: tx.table('rechecks'),
    };
  }
  return db as unknown as StoreLike;
}

/**
 * 合并后复查比对按新数据重算：
 * - 已保存过的上下期组合：用新数据整体重建（同 plotId/baseRound/targetRound 覆盖）
 * - 尚未保存过且已有两期以上数据：按最新相邻两期生成一组
 */
export async function regeneratePlotRechecks(tx: DexieTx | undefined, plotId: string): Promise<number> {
  const store = storeFrom(tx);
  const [plot, trees, saved] = await Promise.all([
    store.plots.where('id').equals(plotId).toArray() as Promise<Plot[]>,
    store.trees.where('plotId').equals(plotId).toArray() as Promise<TreeRecord[]>,
    store.rechecks.where('plotId').equals(plotId).toArray() as Promise<RecheckDiff[]>,
  ]);
  if (!plot[0]) return 0;

  const rounds = Array.from(new Set(trees.map((t) => t.round))).sort((a, b) => a - b);
  if (rounds.length < 2) return 0;

  const pairKey = (b: number, t: number) => `${b}->${t}`;
  const pairs = new Map<string, { base: number; target: number }>();
  saved.forEach((d) => pairs.set(pairKey(d.baseRound, d.targetRound), { base: d.baseRound, target: d.targetRound }));
  if (pairs.size === 0) {
    pairs.set(pairKey(rounds[rounds.length - 2], rounds[rounds.length - 1]), {
      base: rounds[rounds.length - 2],
      target: rounds[rounds.length - 1],
    });
  }

  const now = Date.now();
  const next: RecheckDiff[] = [];
  pairs.forEach(({ base, target }) => {
    next.push(...buildRecheckDiffs(plotId, base, target, trees, now));
  });
  // 先清掉该样地的旧比对行（重建后 id 全部刷新），避免重复堆积
  await store.rechecks.bulkDelete(saved.map((d) => d.id));
  await store.rechecks.bulkPut(next);
  return next.length;
}
