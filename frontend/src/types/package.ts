import type { Plot } from './plot';
import type { RegenShrub } from './regen';
import type { TreeRecord } from './tree';

/** 当前离线包格式版本 */
export const PACKAGE_FORMAT = 3;
export const PACKAGE_KIND = 'gbforestplot-offline-package';

/** 外业离线包：一份包携带若干样地档案及其全部样木、样方记录 */
export interface OfflinePackage {
  kind: string;
  format: number;
  /** 包内容指纹：同一设备重复导出的同一份数据指纹一致，用于二次导入幂等判断 */
  packageId: string;
  exportedAt: number;
  device: string;
  crew?: string;
  plots: Plot[];
  trees: TreeRecord[];
  regens: RegenShrub[];
}

export type ImportBatchStatus = 'pending' | 'imported' | 'failed';

/** 导入批次：失败后保留原始包供重试，成功后留存用于二次导入判重 */
export interface ImportBatch {
  id: string;
  packageId: string;
  fileName: string;
  device: string;
  exportedAt: number;
  createdAt: number;
  status: ImportBatchStatus;
  error?: string;
  /** 原始离线包 JSON（序列化后保存，IndexedDB 结构化克隆亦可直接存对象） */
  pkg: OfflinePackage;
}

export interface ParseResult {
  pkg: OfflinePackage;
  /** 旧版包读取时补齐/纠正项的提示 */
  warnings: string[];
}
