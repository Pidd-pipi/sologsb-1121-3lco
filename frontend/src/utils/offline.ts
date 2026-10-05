import type { Plot } from '../types/plot';
import type { TreeRecord } from '../types/tree';
import type { RegenShrub } from '../types/regen';
import type { RecheckDiff } from '../types/recheck';
import { PACKAGE_FORMAT_VERSION, type OfflinePackage, type PackageMeta } from '../types/offline';
import { db } from './db';
import { newId } from './id';

/** 稳定短哈希：为没有 packageId 的旧包生成确定性的包标识（同一文件重传可识别） */
export function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

/** 组装离线包（当前格式版本） */
export function buildPackage(
  plots: Plot[],
  trees: TreeRecord[],
  regens: RegenShrub[],
  rechecks: RecheckDiff[],
): OfflinePackage {
  return {
    meta: {
      formatVersion: PACKAGE_FORMAT_VERSION,
      packageId: newId('pkg'),
      exportedAt: Date.now(),
      plotNo: plots.length === 1 ? plots[0].plotNo : undefined,
      source: 'gbforestplot',
    },
    plots,
    trees,
    regens,
    rechecks,
  };
}

/** 导出单个样地的离线包（含样木、样方与复查比对存档） */
export async function exportPlotPackage(plotId: string): Promise<OfflinePackage | null> {
  const plot = await db.plots.get(plotId);
  if (!plot) return null;
  const [trees, regens, rechecks] = await Promise.all([
    db.trees.where('plotId').equals(plotId).toArray(),
    db.regens.where('plotId').equals(plotId).toArray(),
    db.rechecks.where('plotId').equals(plotId).toArray(),
  ]);
  return buildPackage([plot], trees, regens, rechecks);
}

export function packageFileName(pkg: OfflinePackage): string {
  const stamp = new Date(pkg.meta.exportedAt || Date.now()).toISOString().slice(0, 10);
  return `样地离线包_${pkg.meta.plotNo ?? '多样地'}_${stamp}.json`;
}

export function downloadPackage(pkg: OfflinePackage): void {
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = packageFileName(pkg);
  a.click();
  URL.revokeObjectURL(url);
}

function normalizePlot(row: any, index: number, exportedAt: number): Plot {
  const plotNo = str(row?.plotNo).trim();
  if (!plotNo) throw new Error(`第 ${index + 1} 个样地缺少样地号（plotNo），离线包无效`);
  return {
    id: str(row.id) || newId('plot'),
    plotNo,
    locality: str(row.locality),
    lng: num(row.lng),
    lat: num(row.lat),
    shape: row.shape === '圆形' ? '圆形' : '方形',
    area: num(row.area),
    elevation: num(row.elevation),
    slope: num(row.slope),
    aspect: str(row.aspect),
    forestType: str(row.forestType),
    canopyDensity: num(row.canopyDensity),
    dominantSpecies: str(row.dominantSpecies),
    surveyRound: Math.max(1, num(row.surveyRound, 1)),
    surveyedAt: num(row.surveyedAt, exportedAt),
    crew: str(row.crew),
    locked: row.locked === true,
    createdAt: num(row.createdAt, exportedAt || Date.now()),
  };
}

function normalizeTree(row: any, index: number, exportedAt: number): TreeRecord {
  const plotId = str(row?.plotId);
  const treeNo = str(row?.treeNo).trim();
  if (!plotId || !treeNo) throw new Error(`第 ${index + 1} 条样木缺少样地或树号，离线包无效`);
  return {
    id: str(row.id) || newId('tree'),
    plotId,
    treeNo,
    species: str(row.species),
    dbhCm: num(row.dbhCm),
    heightM: num(row.heightM),
    underBranchH: num(row.underBranchH),
    crownWidth: num(row.crownWidth),
    status: str(row.status, '活立木') as TreeRecord['status'],
    origin: str(row.origin, '天然') as TreeRecord['origin'],
    healthClass: str(row.healthClass, '健康') as TreeRecord['healthClass'],
    tiltDeg: num(row.tiltDeg),
    remark: str(row.remark),
    round: Math.max(1, num(row.round, 1)),
    measuredAt: num(row.measuredAt, exportedAt),
  };
}

function normalizeRegen(row: any, index: number, exportedAt: number): RegenShrub {
  const plotId = str(row?.plotId);
  const layer = str(row?.layer);
  const species = str(row?.species).trim();
  if (!plotId || !layer || !species) throw new Error(`第 ${index + 1} 条样方缺少样地、层位或种类，离线包无效`);
  return {
    id: str(row.id) || newId('regen'),
    plotId,
    layer: layer as RegenShrub['layer'],
    species,
    heightCm: num(row.heightCm),
    count: num(row.count),
    ageGroup: str(row.ageGroup),
    distribution: str(row.distribution, '均匀') as RegenShrub['distribution'],
    browseDamage: str(row.browseDamage, '无') as RegenShrub['browseDamage'],
    round: Math.max(1, num(row.round, 1)),
    updatedAt: num(row.updatedAt, exportedAt),
  };
}

export interface ParsedPackage {
  pkg: OfflinePackage;
  warnings: string[];
}

/**
 * 解析离线包文本。
 * 兼容旧版包：无 meta、缺 round / measuredAt / updatedAt / locked 等字段时按默认值补全，
 * 缺失的时间字段回退为包导出时间（更旧的本地数据不会被其覆盖）。
 */
export function parsePackage(text: string): ParsedPackage {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('文件不是有效的 JSON，无法解析离线包');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('离线包结构不正确：应为包含 meta / plots / trees / regens 的对象');
  }

  const warnings: string[] = [];
  const metaRaw = raw.meta && typeof raw.meta === 'object' ? raw.meta : undefined;
  const formatVersion = num(metaRaw?.formatVersion ?? raw.formatVersion ?? raw.version, 1);
  if (formatVersion > PACKAGE_FORMAT_VERSION) {
    throw new Error(`离线包格式版本 v${formatVersion} 高于当前支持的 v${PACKAGE_FORMAT_VERSION}，请升级应用后再导入`);
  }
  if (formatVersion < PACKAGE_FORMAT_VERSION) {
    warnings.push(`旧版离线包（v${formatVersion}）：已按当前结构补全缺失字段`);
  }

  const exportedAt = num(metaRaw?.exportedAt, 0);
  const meta: PackageMeta = {
    formatVersion,
    packageId: str(metaRaw?.packageId) || `pkg_${contentHash(text)}`,
    exportedAt,
    plotNo: metaRaw?.plotNo ? str(metaRaw.plotNo) : undefined,
    source: str(metaRaw?.source, 'unknown'),
  };

  const rawPlots = Array.isArray(raw.plots) ? raw.plots : [];
  const rawTrees = Array.isArray(raw.trees) ? raw.trees : [];
  const rawRegens = Array.isArray(raw.regens) ? raw.regens : [];
  const rawRechecks = Array.isArray(raw.rechecks) ? raw.rechecks : [];
  if (rawPlots.length === 0 && rawTrees.length === 0 && rawRegens.length === 0) {
    throw new Error('离线包内没有可合并的样地、样木或样方记录');
  }

  const plots = rawPlots.map((row: any, i: number) => normalizePlot(row, i, exportedAt));
  const trees = rawTrees.map((row: any, i: number) => normalizeTree(row, i, exportedAt));
  const regens = rawRegens.map((row: any, i: number) => normalizeRegen(row, i, exportedAt));
  const rechecks = rawRechecks as RecheckDiff[];

  return { pkg: { meta, plots, trees, regens, rechecks }, warnings };
}
