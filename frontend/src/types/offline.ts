import type { Plot } from './plot';
import type { TreeRecord } from './tree';
import type { RegenShrub } from './regen';
import type { RecheckDiff } from './recheck';

/**
 * 离线包格式版本。
 * v1：早期外业包，无 meta，记录缺 round / measuredAt / updatedAt / locked 等字段；
 * v2：当前版本，带 meta（packageId 用于幂等导入）。
 */
export const PACKAGE_FORMAT_VERSION = 2;

export interface PackageMeta {
  formatVersion: number;
  /** 包级唯一标识：同一个包第二次导入时据此拦截，避免重复记录 */
  packageId: string;
  exportedAt: number;
  /** 单样地包的样地号，便于识别 */
  plotNo?: string;
  source: string;
}

/** 样地离线包：外业队员随身携带、回队后离线合并的数据单元 */
export interface OfflinePackage {
  meta: PackageMeta;
  plots: Plot[];
  trees: TreeRecord[];
  regens: RegenShrub[];
  /** 派生数据，随包携带仅作存档；合并时不写入，按合并后的新数据重算 */
  rechecks: RecheckDiff[];
}

export type BatchStatus = 'applied' | 'failed';

/** 导入批次：失败保留原始报文供重试；applied 用于同包幂等拦截 */
export interface ImportBatch {
  id: string;
  packageId: string;
  fileName: string;
  status: BatchStatus;
  error?: string;
  /** 合并结果摘要 */
  summary?: string;
  receivedAt: number;
  appliedAt?: number;
  /** 原始报文，供失败重试 */
  payload: string;
}

/** 字段级差异：两边都有该记录且取值不同，预览时并排列出 */
export interface FieldChange {
  field: string;
  label: string;
  localValue: unknown;
  incomingValue: unknown;
  adoptedValue: unknown;
  /** local=本地较新；incoming=包内补测较新；protected=保护规则（锁定/已采伐） */
  adoptedFrom: 'local' | 'incoming' | 'protected';
  note?: string;
}

export type MergeAction = 'insert' | 'update' | 'unchanged';

export interface PlotMergeItem {
  plotNo: string;
  action: MergeAction;
  changes: FieldChange[];
  incoming: Plot;
  /** 合并后落到本地的样地 id */
  localId: string;
  /** 待写入记录（insert/update 时有效） */
  merged: Plot;
}

export interface TreeMergeItem {
  plotNo: string;
  treeNo: string;
  round: number;
  action: MergeAction;
  changes: FieldChange[];
  incoming: TreeRecord;
  merged: TreeRecord;
}

export interface RegenMergeItem {
  plotNo: string;
  layer: string;
  species: string;
  round: number;
  action: MergeAction;
  changes: FieldChange[];
  incoming: RegenShrub;
  merged: RegenShrub;
}

/** 逐对象合并计划：预览展示与事务写入共用 */
export interface MergePlan {
  plots: PlotMergeItem[];
  trees: TreeMergeItem[];
  regens: RegenMergeItem[];
  /** 找不到对应样地而跳过的记录数 */
  skippedOrphans: number;
  warnings: string[];
}

export interface MergeReport {
  plotInserted: number;
  plotUpdated: number;
  treeInserted: number;
  treeUpdated: number;
  regenInserted: number;
  regenUpdated: number;
  unchanged: number;
  /** 双方都有且内容不同、已逐字段取舍的记录数 */
  conflicts: number;
  /** 被保护规则拦截的字段数（样地锁定状态 / 已采伐样木） */
  protectedFields: number;
  skippedOrphans: number;
  /** 因合并作废、待按新数据重算的复查比对条数 */
  purgedRechecks: number;
  warnings: string[];
}
