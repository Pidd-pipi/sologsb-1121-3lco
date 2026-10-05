import type { Plot } from '../types/plot';
import type { TreeRecord } from '../types/tree';
import type { RegenShrub } from '../types/regen';
import type {
  FieldChange,
  MergePlan,
  MergeReport,
  OfflinePackage,
  PlotMergeItem,
  RegenMergeItem,
  TreeMergeItem,
} from '../types/offline';
import { db } from './db';
import { newId } from './id';

/** 本地库现状（合并计划的对比基准） */
export interface LocalState {
  plots: Plot[];
  trees: TreeRecord[];
  regens: RegenShrub[];
}

export async function loadLocalState(): Promise<LocalState> {
  const [plots, trees, regens] = await Promise.all([
    db.plots.toArray(),
    db.trees.toArray(),
    db.regens.toArray(),
  ]);
  return { plots, trees, regens };
}

interface FieldDef<T> {
  field: keyof T & string;
  label: string;
}

/** 样地档案参与合并的字段（plotNo 是识别键，id/createdAt 不随包走） */
const PLOT_FIELDS: FieldDef<Plot>[] = [
  { field: 'locality', label: '地点' },
  { field: 'lng', label: '经度' },
  { field: 'lat', label: '纬度' },
  { field: 'shape', label: '形状' },
  { field: 'area', label: '面积' },
  { field: 'elevation', label: '海拔' },
  { field: 'slope', label: '坡度' },
  { field: 'aspect', label: '坡向' },
  { field: 'forestType', label: '林型' },
  { field: 'canopyDensity', label: '郁闭度' },
  { field: 'dominantSpecies', label: '优势树种' },
  { field: 'surveyRound', label: '复查期次' },
  { field: 'surveyedAt', label: '调查时间' },
  { field: 'crew', label: '调查组' },
];

/** 样木参与合并的字段（measuredAt 是取舍时钟，不作为普通字段） */
const TREE_FIELDS: FieldDef<TreeRecord>[] = [
  { field: 'species', label: '树种' },
  { field: 'dbhCm', label: '胸径' },
  { field: 'heightM', label: '树高' },
  { field: 'underBranchH', label: '枝下高' },
  { field: 'crownWidth', label: '冠幅' },
  { field: 'status', label: '状态' },
  { field: 'origin', label: '起源' },
  { field: 'healthClass', label: '健康等级' },
  { field: 'tiltDeg', label: '倾斜度' },
  { field: 'remark', label: '位置描述' },
];

/** 样方参与合并的字段（updatedAt 是取舍时钟） */
const REGEN_FIELDS: FieldDef<RegenShrub>[] = [
  { field: 'heightCm', label: '高度' },
  { field: 'count', label: '株数' },
  { field: 'ageGroup', label: '苗龄组' },
  { field: 'distribution', label: '分布' },
  { field: 'browseDamage', label: '啃食情况' },
];

interface Protection {
  keep: unknown;
  note: string;
}

/** 逐字段对比：取值不同的字段按现场补测时间取舍，保护规则优先 */
function diffFields<T extends Record<string, any>>(
  defs: FieldDef<T>[],
  local: T,
  incoming: T,
  incomingNewer: boolean,
  protect?: (field: string, local: T) => Protection | undefined,
): FieldChange[] {
  const changes: FieldChange[] = [];
  defs.forEach(({ field, label }) => {
    const localValue = local[field];
    const incomingValue = incoming[field];
    if (Object.is(localValue, incomingValue)) return;
    const guarded = protect?.(field, local);
    if (guarded) {
      changes.push({
        field,
        label,
        localValue,
        incomingValue,
        adoptedValue: guarded.keep,
        adoptedFrom: 'protected',
        note: guarded.note,
      });
      return;
    }
    changes.push({
      field,
      label,
      localValue,
      incomingValue,
      adoptedValue: incomingNewer ? incomingValue : localValue,
      adoptedFrom: incomingNewer ? 'incoming' : 'local',
    });
  });
  return changes;
}

/** 合并结果是否真的改变本地记录（采用值与本地值不同的字段存在才算） */
function hasRealChange(changes: FieldChange[]): boolean {
  return changes.some((c) => !Object.is(c.adoptedValue, c.localValue));
}

/** 已采伐样木不允许被旧包改回其他状态 */
function protectTree(field: string, local: TreeRecord): Protection | undefined {
  if (field === 'status' && local.status === '采伐') {
    return { keep: '采伐', note: '已采伐样木不允许被旧包改回' };
  }
  return undefined;
}

const treeKey = (plotId: string, treeNo: string, round: number) => `${plotId}|${treeNo}|${round}`;
const regenKey = (plotId: string, layer: string, species: string, round: number) =>
  `${plotId}|${layer}|${species}|${round}`;

/**
 * 逐对象合并计划：
 * 样地按样地号识别，样木按树号+复查期次，样方按层位+种类+期次；
 * 两边都有的记录逐字段按现场补测时间取舍，锁定状态与已采伐样木受保护。
 */
export function computeMergePlan(pkg: OfflinePackage, local: LocalState): MergePlan {
  const warnings: string[] = [];
  /** 包内样地 id → 本地样地 id */
  const plotIdMap = new Map<string, string>();
  const plotNoByLocalId = new Map<string, string>(local.plots.map((p) => [p.id, p.plotNo]));
  const localPlotIds = new Set(local.plots.map((p) => p.id));

  // —— 样地：按样地号识别 ——
  const plots: PlotMergeItem[] = pkg.plots.map((incoming) => {
    const localPlot = local.plots.find((p) => p.plotNo === incoming.plotNo);
    if (!localPlot) {
      // id 撞上本地其他样地时换发新 id，避免误覆盖
      const id = incoming.id && !localPlotIds.has(incoming.id) ? incoming.id : newId('plot');
      localPlotIds.add(id);
      plotIdMap.set(incoming.id, id);
      plotNoByLocalId.set(id, incoming.plotNo);
      const merged: Plot = { ...incoming, id };
      return { plotNo: incoming.plotNo, action: 'insert', changes: [], incoming, localId: id, merged };
    }
    plotIdMap.set(incoming.id, localPlot.id);
    const incomingNewer = incoming.surveyedAt > localPlot.surveyedAt;
    const changes = diffFields(PLOT_FIELDS, localPlot, incoming, incomingNewer);
    // 锁定状态单独处理：已锁定样地不允许被旧包改回未锁定
    if (localPlot.locked !== incoming.locked) {
      changes.push(
        localPlot.locked
          ? {
              field: 'locked',
              label: '锁定状态',
              localValue: true,
              incomingValue: false,
              adoptedValue: true,
              adoptedFrom: 'protected',
              note: '已锁定样地不允许被旧包改回',
            }
          : {
              field: 'locked',
              label: '锁定状态',
              localValue: false,
              incomingValue: true,
              adoptedValue: true,
              adoptedFrom: 'incoming',
            },
      );
    }
    const merged: Plot = { ...localPlot };
    changes.forEach((c) => {
      (merged as any)[c.field] = c.adoptedValue;
    });
    return {
      plotNo: incoming.plotNo,
      action: hasRealChange(changes) ? 'update' : 'unchanged',
      changes,
      incoming,
      localId: localPlot.id,
      merged,
    };
  });

  // —— 样木：按树号 + 复查期次识别 ——
  const localTreeByKey = new Map<string, TreeRecord>();
  local.trees.forEach((t) => localTreeByKey.set(treeKey(t.plotId, t.treeNo, t.round), t));
  const localTreeIds = new Set(local.trees.map((t) => t.id));

  let skippedOrphans = 0;
  const trees: TreeMergeItem[] = [];
  pkg.trees.forEach((incoming) => {
    const localPlotId =
      plotIdMap.get(incoming.plotId) ?? (localPlotIds.has(incoming.plotId) ? incoming.plotId : undefined);
    if (!localPlotId) {
      skippedOrphans += 1;
      return;
    }
    const plotNo = plotNoByLocalId.get(localPlotId) ?? incoming.plotId;
    const mapped: TreeRecord = { ...incoming, plotId: localPlotId };
    const localTree = localTreeByKey.get(treeKey(localPlotId, incoming.treeNo, incoming.round));
    if (!localTree) {
      const id = incoming.id && !localTreeIds.has(incoming.id) ? incoming.id : newId('tree');
      localTreeIds.add(id);
      const merged: TreeRecord = { ...mapped, id };
      trees.push({ plotNo, treeNo: incoming.treeNo, round: incoming.round, action: 'insert', changes: [], incoming, merged });
      return;
    }
    const incomingNewer = incoming.measuredAt > localTree.measuredAt;
    const changes = diffFields(TREE_FIELDS, localTree, mapped, incomingNewer, protectTree);
    const merged: TreeRecord = { ...localTree };
    changes.forEach((c) => {
      (merged as any)[c.field] = c.adoptedValue;
    });
    if (incomingNewer) merged.measuredAt = incoming.measuredAt;
    trees.push({
      plotNo,
      treeNo: incoming.treeNo,
      round: incoming.round,
      action: hasRealChange(changes) ? 'update' : 'unchanged',
      changes,
      incoming,
      merged,
    });
  });

  // —— 样方：按层位 + 种类 + 期次识别 ——
  const localRegenByKey = new Map<string, RegenShrub>();
  local.regens.forEach((r) => localRegenByKey.set(regenKey(r.plotId, r.layer, r.species, r.round), r));
  const localRegenIds = new Set(local.regens.map((r) => r.id));

  const regens: RegenMergeItem[] = [];
  pkg.regens.forEach((incoming) => {
    const localPlotId =
      plotIdMap.get(incoming.plotId) ?? (localPlotIds.has(incoming.plotId) ? incoming.plotId : undefined);
    if (!localPlotId) {
      skippedOrphans += 1;
      return;
    }
    const plotNo = plotNoByLocalId.get(localPlotId) ?? incoming.plotId;
    const mapped: RegenShrub = { ...incoming, plotId: localPlotId };
    const localRegen = localRegenByKey.get(regenKey(localPlotId, incoming.layer, incoming.species, incoming.round));
    if (!localRegen) {
      const id = incoming.id && !localRegenIds.has(incoming.id) ? incoming.id : newId('regen');
      localRegenIds.add(id);
      const merged: RegenShrub = { ...mapped, id };
      regens.push({
        plotNo,
        layer: incoming.layer,
        species: incoming.species,
        round: incoming.round,
        action: 'insert',
        changes: [],
        incoming,
        merged,
      });
      return;
    }
    const incomingNewer = incoming.updatedAt > localRegen.updatedAt;
    const changes = diffFields(REGEN_FIELDS, localRegen, mapped, incomingNewer);
    const merged: RegenShrub = { ...localRegen };
    changes.forEach((c) => {
      (merged as any)[c.field] = c.adoptedValue;
    });
    if (incomingNewer) merged.updatedAt = incoming.updatedAt;
    regens.push({
      plotNo,
      layer: incoming.layer,
      species: incoming.species,
      round: incoming.round,
      action: hasRealChange(changes) ? 'update' : 'unchanged',
      changes,
      incoming,
      merged,
    });
  });

  if (skippedOrphans > 0) {
    warnings.push(`包内有 ${skippedOrphans} 条记录找不到对应样地，已跳过`);
  }
  return { plots, trees, regens, skippedOrphans, warnings };
}

function buildReport(plan: MergePlan, purgedRechecks: number): MergeReport {
  const items = [...plan.plots, ...plan.trees, ...plan.regens];
  const updates = items.filter((i) => i.action === 'update');
  const conflicts = items.filter((i) => i.changes.length > 0);
  return {
    plotInserted: plan.plots.filter((i) => i.action === 'insert').length,
    plotUpdated: plan.plots.filter((i) => i.action === 'update').length,
    treeInserted: plan.trees.filter((i) => i.action === 'insert').length,
    treeUpdated: plan.trees.filter((i) => i.action === 'update').length,
    regenInserted: plan.regens.filter((i) => i.action === 'insert').length,
    regenUpdated: plan.regens.filter((i) => i.action === 'update').length,
    unchanged: items.filter((i) => i.action === 'unchanged').length,
    conflicts: conflicts.length,
    protectedFields: conflicts.reduce(
      (sum, i) => sum + i.changes.filter((c) => c.adoptedFrom === 'protected').length,
      0,
    ),
    skippedOrphans: plan.skippedOrphans,
    purgedRechecks,
    warnings: plan.warnings,
  };
}

/**
 * 事务内执行合并：以库内最新状态重算计划后写入。
 * 新记录沿用包内 id（撞号才换发），同一个包重复导入不会产生重复记录；
 * 受影响样地的复查比对存档作废，按合并后的新数据重算。
 */
export async function applyPackage(pkg: OfflinePackage): Promise<MergeReport> {
  return db.transaction('rw', [db.plots, db.trees, db.regens, db.rechecks], async () => {
    const [plots, trees, regens] = await Promise.all([
      db.plots.toArray(),
      db.trees.toArray(),
      db.regens.toArray(),
    ]);
    const plan = computeMergePlan(pkg, { plots, trees, regens });

    const plotPuts = plan.plots.filter((i) => i.action !== 'unchanged').map((i) => i.merged);
    const treePuts = plan.trees.filter((i) => i.action !== 'unchanged').map((i) => i.merged);
    const regenPuts = plan.regens.filter((i) => i.action !== 'unchanged').map((i) => i.merged);
    if (plotPuts.length > 0) await db.plots.bulkPut(plotPuts);
    if (treePuts.length > 0) await db.trees.bulkPut(treePuts);
    if (regenPuts.length > 0) await db.regens.bulkPut(regenPuts);

    // 复查比对与林分汇总按新数据重算：作废旧比对存档（汇总由页面实时计算）
    const affectedPlotIds = new Set<string>();
    plan.plots.forEach((i) => {
      if (i.action !== 'unchanged') affectedPlotIds.add(i.localId);
    });
    plan.trees.forEach((i) => {
      if (i.action !== 'unchanged') affectedPlotIds.add(i.merged.plotId);
    });
    plan.regens.forEach((i) => {
      if (i.action !== 'unchanged') affectedPlotIds.add(i.merged.plotId);
    });
    let purgedRechecks = 0;
    for (const plotId of affectedPlotIds) {
      purgedRechecks += await db.rechecks.where('plotId').equals(plotId).delete();
    }

    return buildReport(plan, purgedRechecks);
  });
}

export function reportSummary(report: MergeReport): string {
  const parts = [
    `样地 新增 ${report.plotInserted} / 更新 ${report.plotUpdated}`,
    `样木 新增 ${report.treeInserted} / 更新 ${report.treeUpdated}`,
    `样方 新增 ${report.regenInserted} / 更新 ${report.regenUpdated}`,
  ];
  if (report.conflicts > 0) parts.push(`两边都改过的记录 ${report.conflicts} 条（已逐字段取舍）`);
  if (report.protectedFields > 0) parts.push(`保护字段 ${report.protectedFields} 处`);
  if (report.purgedRechecks > 0) parts.push(`复查比对按新数据重算 ${report.purgedRechecks} 条`);
  if (report.skippedOrphans > 0) parts.push(`跳过无主记录 ${report.skippedOrphans} 条`);
  return parts.join('；');
}
