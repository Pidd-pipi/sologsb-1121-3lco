import type { FieldTimes } from '../types/common';
import type { Plot } from '../types/plot';
import type { TreeRecord } from '../types/tree';
import type { RegenShrub } from '../types/regen';
import type { OfflinePackage } from '../types/package';
import { db } from './db';
import { newId } from './id';
import { regeneratePlotRechecks } from './recheck';

export type MergeKind = 'plot' | 'tree' | 'regen';
export type MergeSide = 'local' | 'incoming';
export type MergeAction = 'add' | 'update';

export interface FieldConflict {
  field: string;
  label: string;
  local: unknown;
  incoming: unknown;
  /** 本地记录该字段的现场补测时间 */
  localAt: number;
  /** 离线包该字段的现场补测时间 */
  incomingAt: number;
  /** 自动判定取数方：同一字段按现场补测时间决定新值，时间相同取传入方 */
  autoWinner: MergeSide;
  /** 预览确认后的取数方 */
  winner: MergeSide;
  /** 受保护字段不允许被旧值改回（样地锁定状态、已采伐样木状态） */
  protected: boolean;
  protectedReason?: string;
}

export interface MergeItem {
  kind: MergeKind;
  action: MergeAction;
  /** 自然键 */
  key: string;
  /** 预览标题 */
  title: string;
  /** 本库已有记录 id（update 时） */
  localId?: string;
  local?: Plot | TreeRecord | RegenShrub;
  incoming: Plot | TreeRecord | RegenShrub;
  conflicts: FieldConflict[];
  /** 仅一侧有值、自动补齐的字段标签 */
  filledFields: string[];
  /** 提交后写入的主键 id */
  targetId: string;
  /** 提交后归属的样地 id（子记录用） */
  targetPlotId?: string;
  note?: string;
}

export interface MergePlan {
  items: MergeItem[];
  /** 包内引用了但包与本库都找不到样地号的子记录，跳过不合并 */
  skipped: { kind: MergeKind; key: string; reason: string }[];
  /** 受影响的本库样地 id（提交后需重算复查比对） */
  affectedPlotIds: string[];
}

/** 预览中用户的逐字段选择，键为 `${kind}:${key}:${field}` */
export type ChoiceMap = Record<string, MergeSide>;

interface MergeFieldSpec {
  field: string;
  label: string;
}

export const PLOT_MERGE_FIELDS: MergeFieldSpec[] = [
  { field: 'locality', label: '地点' },
  { field: 'lng', label: '经度' },
  { field: 'lat', label: '纬度' },
  { field: 'shape', label: '形状' },
  { field: 'area', label: '面积 m²' },
  { field: 'elevation', label: '海拔 m' },
  { field: 'slope', label: '坡度 °' },
  { field: 'aspect', label: '坡向' },
  { field: 'forestType', label: '林型' },
  { field: 'canopyDensity', label: '郁闭度' },
  { field: 'dominantSpecies', label: '优势树种' },
  { field: 'surveyRound', label: '复查期次' },
  { field: 'surveyedAt', label: '调查时间' },
  { field: 'crew', label: '调查组' },
  { field: 'locked', label: '锁定状态' },
];

export const TREE_MERGE_FIELDS: MergeFieldSpec[] = [
  { field: 'species', label: '树种' },
  { field: 'dbhCm', label: '胸径 cm' },
  { field: 'heightM', label: '树高 m' },
  { field: 'underBranchH', label: '枝下高 m' },
  { field: 'crownWidth', label: '冠幅 m' },
  { field: 'status', label: '状态' },
  { field: 'origin', label: '起源' },
  { field: 'healthClass', label: '健康等级' },
  { field: 'tiltDeg', label: '倾斜 °' },
  { field: 'remark', label: '位置描述' },
];

export const REGEN_MERGE_FIELDS: MergeFieldSpec[] = [
  { field: 'heightCm', label: '高度 cm' },
  { field: 'count', label: '株数' },
  { field: 'ageGroup', label: '苗龄组' },
  { field: 'distribution', label: '分布' },
  { field: 'browseDamage', label: '啃食情况' },
];

/** 样地档案按样地号识别 */
export const plotKey = (plotNo: string): string => `plot:${plotNo.trim()}`;
/** 样木按树号 + 复查期次识别（样地号域内） */
export const treeKey = (plotNo: string, treeNo: string, round: number): string =>
  `tree:${plotNo.trim()}::${treeNo.trim()}::r${round}`;
/** 样方按层位、种类、期次识别（样地号域内） */
export const regenKey = (plotNo: string, layer: string, species: string, round: number): string =>
  `regen:${plotNo.trim()}::${layer}::${species.trim()}::r${round}`;

const LABELS: Record<MergeKind, MergeFieldSpec[]> = {
  plot: PLOT_MERGE_FIELDS,
  tree: TREE_MERGE_FIELDS,
  regen: REGEN_MERGE_FIELDS,
};

function isDefined(v: unknown): boolean {
  return v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  return false;
}

function recordFallbackAt(kind: MergeKind, rec: Plot | TreeRecord | RegenShrub): number {
  if (kind === 'tree') return (rec as TreeRecord).measuredAt || 0;
  if (kind === 'plot') {
    const p = rec as Plot;
    return p.updatedAt || p.surveyedAt || 0;
  }
  return (rec as RegenShrub).updatedAt || 0;
}

function fieldAt(rec: { fieldTimes?: FieldTimes }, field: string, fallback: number): number {
  const t = rec.fieldTimes?.[field];
  return typeof t === 'number' && t > 0 ? t : fallback;
}

/** 受保护字段的专门裁决：锁定状态不能由锁定改回未锁定；已采伐样木不能改回非采伐 */
function protection(
  kind: MergeKind,
  field: string,
  local: Plot | TreeRecord | RegenShrub,
  incoming: Plot | TreeRecord | RegenShrub,
): { protected: boolean; winner: MergeSide; reason: string } | null {
  if (kind === 'plot' && field === 'locked') {
    if ((local as Plot).locked === true && (incoming as Plot).locked === false) {
      return { protected: true, winner: 'local', reason: '样地已锁定，锁定状态不能被旧包改回' };
    }
  }
  if (kind === 'tree' && field === 'status') {
    if ((local as TreeRecord).status === '采伐' && (incoming as TreeRecord).status !== '采伐') {
      return { protected: true, winner: 'local', reason: '该样木已标记采伐，状态不能被旧包改回' };
    }
  }
  return null;
}

function buildConflicts(
  kind: MergeKind,
  local: Plot | TreeRecord | RegenShrub,
  incoming: Plot | TreeRecord | RegenShrub,
  choices: ChoiceMap,
  itemKey: string,
): { conflicts: FieldConflict[]; filledFields: string[] } {
  const localFallback = recordFallbackAt(kind, local);
  const incomingFallback = recordFallbackAt(kind, incoming);
  const conflicts: FieldConflict[] = [];
  const filledFields: string[] = [];

  LABELS[kind].forEach(({ field, label }) => {
    const lv = (local as unknown as Record<string, unknown>)[field];
    const iv = (incoming as unknown as Record<string, unknown>)[field];
    const hasL = isDefined(lv);
    const hasI = isDefined(iv);

    if (hasL && hasI && !sameValue(lv, iv)) {
      const localAt = fieldAt(local, field, localFallback);
      const incomingAt = fieldAt(incoming, field, incomingFallback);
      const guard = protection(kind, field, local, incoming);
      const autoWinner: MergeSide = incomingAt >= localAt ? 'incoming' : 'local';
      const winner = guard ? guard.winner : choices[`${kind}:${itemKey}:${field}`] ?? autoWinner;
      conflicts.push({
        field,
        label,
        local: lv,
        incoming: iv,
        localAt,
        incomingAt,
        autoWinner,
        winner: guard ? guard.winner : winner,
        protected: !!guard,
        protectedReason: guard?.reason,
      });
    } else if (!hasL && hasI) {
      filledFields.push(label);
    }
  });

  return { conflicts, filledFields };
}

function treeTitle(plotNo: string, rec: TreeRecord): string {
  return `${plotNo} · ${rec.treeNo} 号样木（第 ${rec.round} 期）`;
}

function regenTitle(plotNo: string, rec: RegenShrub): string {
  return `${plotNo} · ${rec.layer} / ${rec.species}（第 ${rec.round} 期）`;
}

/**
 * 构造逐对象合并计划（纯函数，便于预览与提交复用）。
 * @param local 本库快照（plots/trees/regens）
 * @param pkg 解析后的离线包
 * @param choices 预览中用户的逐字段选择
 */
export function buildMergePlan(
  local: { plots: Plot[]; trees: TreeRecord[]; regens: RegenShrub[] },
  pkg: OfflinePackage,
  choices: ChoiceMap = {},
): MergePlan {
  const items: MergeItem[] = [];
  const skipped: MergePlan['skipped'] = [];

  const localPlotByNo = new Map<string, Plot>();
  local.plots.forEach((p) => localPlotByNo.set(p.plotNo.trim(), p));

  const pkgPlotById = new Map<string, Plot>();
  pkg.plots.forEach((p) => pkgPlotById.set(p.id, p));

  // 样地号 -> 合并后落库的样地 id（含本库已有与新包新增）
  const targetPlotIdByNo = new Map<string, string>();
  // 已分配的主键，避免包内 id 与本库或同批其它记录撞车（各表主键同源于 newId，统一管理）
  const usedIds = new Set<string>([
    ...local.plots.map((p) => p.id),
    ...local.trees.map((t) => t.id),
    ...local.regens.map((r) => r.id),
  ]);
  const allocId = (prefix: string, preferred?: string): string => {
    const candidate = preferred && !usedIds.has(preferred) ? preferred : newId(prefix);
    usedIds.add(candidate);
    return candidate;
  };

  // 1) 样地档案
  pkg.plots.forEach((incoming) => {
    const no = incoming.plotNo.trim();
    const key = plotKey(no);
    const exist = localPlotByNo.get(no);
    if (!exist) {
      const targetId = allocId('plot', incoming.id);
      targetPlotIdByNo.set(no, targetId);
      items.push({
        kind: 'plot',
        action: 'add',
        key,
        title: `${no}（新样地）`,
        incoming,
        conflicts: [],
        filledFields: [],
        targetId,
      });
    } else {
      targetPlotIdByNo.set(no, exist.id);
      const { conflicts, filledFields } = buildConflicts('plot', exist, incoming, choices, key);
      items.push({
        kind: 'plot',
        action: 'update',
        key,
        title: no,
        localId: exist.id,
        local: exist,
        incoming,
        conflicts,
        filledFields,
        targetId: exist.id,
        note: conflicts.some((c) => c.protected) ? '含受保护字段' : undefined,
      });
    }
  });

  const localPlotById = new Map(local.plots.map((p) => [p.id, p]));

  const resolvePlotNo = (childPlotId: string): Plot | undefined =>
    pkgPlotById.get(childPlotId) ?? localPlotById.get(childPlotId);

  // 2) 样木
  const localTreeByKey = new Map<string, TreeRecord>();
  local.trees.forEach((t) => {
    const p = localPlotById.get(t.plotId);
    if (p) localTreeByKey.set(treeKey(p.plotNo, t.treeNo, t.round), t);
  });

  pkg.trees.forEach((incoming) => {
    const plot = resolvePlotNo(incoming.plotId);
    if (!plot) {
      skipped.push({
        kind: 'tree',
        key: `${incoming.treeNo}#r${incoming.round}`,
        reason: '离线包缺少该样木所属样地档案，无法按样地号定位，已跳过',
      });
      return;
    }
    const no = plot.plotNo.trim();
    const key = treeKey(no, incoming.treeNo, incoming.round);
    const targetPlotId = targetPlotIdByNo.get(no);
    if (!targetPlotId) {
      skipped.push({ kind: 'tree', key, reason: `样地 ${no} 未在本批合并中，已跳过` });
      return;
    }
    const exist = localTreeByKey.get(key);
    if (!exist) {
      items.push({
        kind: 'tree',
        action: 'add',
        key,
        title: treeTitle(no, incoming),
        incoming,
        conflicts: [],
        filledFields: [],
        targetId: allocId('tree', incoming.id),
        targetPlotId,
      });
    } else {
      const { conflicts, filledFields } = buildConflicts('tree', exist, incoming, choices, key);
      items.push({
        kind: 'tree',
        action: 'update',
        key,
        title: treeTitle(no, incoming),
        localId: exist.id,
        local: exist,
        incoming,
        conflicts,
        filledFields,
        targetId: exist.id,
        targetPlotId,
        note: conflicts.some((c) => c.protected) ? '含受保护字段' : undefined,
      });
    }
  });

  // 3) 样方
  const localRegenByKey = new Map<string, RegenShrub>();
  local.regens.forEach((r) => {
    const p = localPlotById.get(r.plotId);
    if (p) localRegenByKey.set(regenKey(p.plotNo, r.layer, r.species, r.round), r);
  });

  pkg.regens.forEach((incoming) => {
    const plot = resolvePlotNo(incoming.plotId);
    if (!plot) {
      skipped.push({
        kind: 'regen',
        key: `${incoming.layer}/${incoming.species}#r${incoming.round}`,
        reason: '离线包缺少该样方所属样地档案，无法按样地号定位，已跳过',
      });
      return;
    }
    const no = plot.plotNo.trim();
    const key = regenKey(no, incoming.layer, incoming.species, incoming.round);
    const targetPlotId = targetPlotIdByNo.get(no);
    if (!targetPlotId) {
      skipped.push({ kind: 'regen', key, reason: `样地 ${no} 未在本批合并中，已跳过` });
      return;
    }
    const exist = localRegenByKey.get(key);
    if (!exist) {
      items.push({
        kind: 'regen',
        action: 'add',
        key,
        title: regenTitle(no, incoming),
        incoming,
        conflicts: [],
        filledFields: [],
        targetId: allocId('regen', incoming.id),
        targetPlotId,
      });
    } else {
      const { conflicts, filledFields } = buildConflicts('regen', exist, incoming, choices, key);
      items.push({
        kind: 'regen',
        action: 'update',
        key,
        title: regenTitle(no, incoming),
        localId: exist.id,
        local: exist,
        incoming,
        conflicts,
        filledFields,
        targetId: exist.id,
        targetPlotId,
      });
    }
  });

  return {
    items,
    skipped,
    affectedPlotIds: Array.from(new Set(items.filter((i) => i.kind === 'tree').map((i) => i.targetPlotId!).filter(Boolean))),
  };
}

/** 合并统计 */
export function summarizePlan(plan: MergePlan): {
  adds: Record<MergeKind, number>;
  updates: Record<MergeKind, number>;
  conflictCount: number;
  protectedCount: number;
} {
  const adds: Record<MergeKind, number> = { plot: 0, tree: 0, regen: 0 };
  const updates: Record<MergeKind, number> = { plot: 0, tree: 0, regen: 0 };
  let conflictCount = 0;
  let protectedCount = 0;
  plan.items.forEach((item) => {
    if (item.action === 'add') adds[item.kind] += 1;
    else updates[item.kind] += 1;
    conflictCount += item.conflicts.length;
    protectedCount += item.conflicts.filter((c) => c.protected).length;
  });
  return { adds, updates, conflictCount, protectedCount };
}

function mergeFieldTimes(
  kind: MergeKind,
  local: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
  conflicts: FieldConflict[],
  fallback: number,
): FieldTimes {
  const result: FieldTimes = { ...((local?.fieldTimes as FieldTimes) ?? {}) };
  const incomingTimes = (incoming.fieldTimes as FieldTimes) ?? {};
  LABELS[kind].forEach(({ field }) => {
    const conflict = conflicts.find((c) => c.field === field);
    if (conflict) {
      result[field] = conflict.winner === 'local' ? conflict.localAt : conflict.incomingAt;
      return;
    }
    const iv = incoming[field];
    const lv = local?.[field];
    if (isDefined(iv) && !isDefined(lv)) {
      result[field] = incomingTimes[field] ?? fallback;
    } else if (incomingTimes[field] !== undefined && (result[field] === undefined || incomingTimes[field] > result[field])) {
      result[field] = incomingTimes[field];
    }
  });
  return result;
}

/**
 * 在单个事务内提交合并：逐对象 upsert（自然键识别，重复导入不产生重复记录），
 * 随后重算受影响样地的复查比对。
 * 提交时重新从库内取最新记录重算冲突，只沿用预览中未受保护字段的选择。
 */
export async function commitMerge(
  pkg: OfflinePackage,
  choices: ChoiceMap = {},
): Promise<{ written: number; plan: MergePlan }> {
  let written = 0;
  let plan: MergePlan = { items: [], skipped: [], affectedPlotIds: [] };

  await db.transaction(
    'rw',
    db.plots,
    db.trees,
    db.regens,
    db.rechecks,
    async (tx) => {
      const [plots, trees, regens] = await Promise.all([
        tx.table<Plot, string>('plots').toArray(),
        tx.table<TreeRecord, string>('trees').toArray(),
        tx.table<RegenShrub, string>('regens').toArray(),
      ]);
      plan = buildMergePlan({ plots, trees, regens }, pkg, choices);

      const plotsToPut: Plot[] = [];
      const treesToPut: TreeRecord[] = [];
      const regensToPut: RegenShrub[] = [];
      const now = Date.now();

      for (const freshItem of plan.items) {
        const spec = LABELS[freshItem.kind];
        const local = freshItem.local as unknown as Record<string, unknown> | undefined;
        const incoming = freshItem.incoming as unknown as Record<string, unknown>;

        if (freshItem.action === 'add') {
          if (freshItem.kind === 'plot') {
            plotsToPut.push({ ...(incoming as unknown as Plot), id: freshItem.targetId });
          } else if (freshItem.kind === 'tree') {
            treesToPut.push({
              ...(incoming as unknown as TreeRecord),
              id: freshItem.targetId,
              plotId: freshItem.targetPlotId!,
            });
          } else {
            regensToPut.push({
              ...(incoming as unknown as RegenShrub),
              id: freshItem.targetId,
              plotId: freshItem.targetPlotId!,
            });
          }
          written += 1;
          continue;
        }

        const merged: Record<string, unknown> = { ...local };
        spec.forEach(({ field }) => {
          const conflict = freshItem.conflicts.find((c) => c.field === field);
          const lv = local?.[field];
          const iv = incoming[field];
          if (conflict) {
            merged[field] = conflict.winner === 'local' ? lv : iv;
          } else if (!isDefined(lv) && isDefined(iv)) {
            merged[field] = iv;
          }
        });

        const fallback = recordFallbackAt(freshItem.kind, freshItem.incoming);
        const fieldTimes = mergeFieldTimes(
          freshItem.kind,
          local as Record<string, unknown> | undefined,
          incoming,
          freshItem.conflicts,
          fallback,
        );

        if (freshItem.kind === 'plot') {
          const localPlot = local as unknown as Plot;
          const incomingPlot = incoming as unknown as Plot;
          merged.id = freshItem.targetId;
          merged.plotNo = localPlot.plotNo; // 样地号为识别键，不被改写
          merged.createdAt = localPlot.createdAt;
          merged.updatedAt = Math.max(localPlot.updatedAt || localPlot.surveyedAt || 0, incomingPlot.updatedAt || incomingPlot.surveyedAt || 0, now);
          merged.fieldTimes = fieldTimes;
          plotsToPut.push(merged as unknown as Plot);
        } else if (freshItem.kind === 'tree') {
          const localTree = local as unknown as TreeRecord;
          merged.id = freshItem.targetId;
          merged.plotId = freshItem.targetPlotId!;
          merged.treeNo = localTree.treeNo;
          merged.round = localTree.round;
          merged.measuredAt = Math.max(localTree.measuredAt || 0, (incoming as unknown as TreeRecord).measuredAt || 0);
          merged.fieldTimes = fieldTimes;
          treesToPut.push(merged as unknown as TreeRecord);
        } else {
          const localRegen = local as unknown as RegenShrub;
          merged.id = freshItem.targetId;
          merged.plotId = freshItem.targetPlotId!;
          merged.layer = localRegen.layer;
          merged.species = localRegen.species;
          merged.round = localRegen.round;
          merged.updatedAt = Math.max(localRegen.updatedAt || 0, (incoming as unknown as RegenShrub).updatedAt || 0, now);
          merged.fieldTimes = fieldTimes;
          regensToPut.push(merged as unknown as RegenShrub);
        }
        written += 1;
      }

      if (plotsToPut.length) await tx.table('plots').bulkPut(plotsToPut);
      if (treesToPut.length) await tx.table('trees').bulkPut(treesToPut);
      if (regensToPut.length) await tx.table('regens').bulkPut(regensToPut);

      // 合并后复查比对按新数据重算
      for (const plotId of Array.from(new Set(plan.affectedPlotIds))) {
        await regeneratePlotRechecks(tx as unknown as DexieTx, plotId);
      }
    },
  );

  return { written, plan };
}

/** Dexie 事务对象的最小结构（regeneratePlotRechecks 只依赖表访问） */
export interface DexieTx {
  table<T = unknown, K = string>(name: string): {
    toArray(): Promise<T[]>;
    bulkPut(rows: T[]): Promise<unknown>;
    bulkDelete(keys: K[]): Promise<unknown>;
    where(index: string): { equals(value: K): { toArray(): Promise<T[]> } };
  };
}
