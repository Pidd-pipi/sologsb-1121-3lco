import type { Plot } from '../types/plot';
import type { RegenShrub } from '../types/regen';
import type { TreeRecord } from '../types/tree';
import { PACKAGE_FORMAT, PACKAGE_KIND, type OfflinePackage, type ParseResult } from '../types/package';
import { db } from './db';
import { newId } from './id';

const DEVICE_KEY = 'gbforestplot:device';

function getDevice(): string {
  try {
    let device = window.localStorage.getItem(DEVICE_KEY);
    if (!device) {
      device = `外业终端-${Math.random().toString(36).slice(2, 7)}`;
      window.localStorage.setItem(DEVICE_KEY, device);
    }
    return device;
  } catch {
    return '外业终端';
  }
}

/** 内容指纹：只由样地号 + 自然键 + 记录内容决定，同一包重复导出指纹一致，供二次导入判重 */
export function contentFingerprint(pkg: Pick<OfflinePackage, 'plots' | 'trees' | 'regens'>): string {
  const stable = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    const obj = value as Record<string, unknown>;
    // id、创建/修改时间、字段时间不参与指纹：同一组现场数据重复导出应判为同一个包
    const skip = new Set(['id', 'createdAt', 'updatedAt', 'measuredAt', 'fieldTimes']);
    const keys = Object.keys(obj).filter((k) => !skip.has(k)).sort();
    const parts = keys.map((k) => JSON.stringify(k) + ':' + stable(obj[k]));
    return '{' + parts.join(',') + '}';
  };
  const sortedPlots = [...pkg.plots].sort((a, b) => a.plotNo.localeCompare(b.plotNo));
  const sortedTrees = [...pkg.trees].sort((a, b) => {
    const ka = a.plotId + ':' + a.round + ':' + a.treeNo;
    const kb = b.plotId + ':' + b.round + ':' + b.treeNo;
    return ka.localeCompare(kb);
  });
  const sortedRegens = [...pkg.regens].sort((a, b) => {
    const ka = a.plotId + ':' + a.round + ':' + a.layer + ':' + a.species;
    const kb = b.plotId + ':' + b.round + ':' + b.layer + ':' + b.species;
    return ka.localeCompare(kb);
  });
  const raw = stable({ plots: sortedPlots, trees: sortedTrees, regens: sortedRegens });
  // djb2
  let hash = 5381;
  for (let i = 0; i < raw.length; i += 1) {
    hash = ((hash << 5) + hash + raw.charCodeAt(i)) | 0;
  }
  return 'fp_' + (hash >>> 0).toString(36) + '_' + raw.length.toString(36);
}

/** 按样地导出现场外业离线包 */
export async function buildOfflinePackage(plotIds: string[]): Promise<OfflinePackage> {
  const ids = new Set(plotIds);
  const [plots, trees, regens] = await Promise.all([
    db.plots.filter((p) => ids.has(p.id)).toArray(),
    db.trees.filter((t) => ids.has(t.plotId)).toArray(),
    db.regens.filter((r) => ids.has(r.plotId)).toArray(),
  ]);
  const crewSet = Array.from(new Set(plots.map((p) => p.crew).filter(Boolean)));
  const pkg: Omit<OfflinePackage, 'packageId'> = {
    kind: PACKAGE_KIND,
    format: PACKAGE_FORMAT,
    exportedAt: Date.now(),
    device: getDevice(),
    crew: crewSet.join('、'),
    plots,
    trees,
    regens,
  };
  return { ...pkg, packageId: contentFingerprint(pkg) };
}

/** 触发浏览器下载 */
export function downloadPackage(pkg: OfflinePackage): string {
  const stamp = new Date(pkg.exportedAt)
    .toISOString()
    .slice(0, 19)
    .replace(/[-:T]/g, '');
  const first = pkg.plots[0]?.plotNo ?? 'plots';
  const fileName = `样地离线包_${first}等${pkg.plots.length}块_${stamp}.json`;
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
  return fileName;
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v === undefined || v === null ? fallback : String(v);
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function cleanText(v: unknown): string {
  return str(v).trim();
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * 容错解析离线包文件：
 * - 支持当前信封格式与直接含 plots/trees/regens 的裸对象
 * - 旧版包（v1/v2，无 locked/round/measuredAt/fieldTimes 等）自动补齐
 */
export function parseOfflinePackage(text: string, fileName = '离线包'): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('文件不是有效的 JSON，请确认选择的是样地离线包（.json）');
  }
  const root = asObject(data);
  if (!Array.isArray(root.plots)) {
    throw new Error('未找到 plots 数据：该文件不是样地离线包');
  }

  const warnings: string[] = [];
  const rawFormat = Number(root.format);
  const isLegacy = !Number.isFinite(rawFormat) || rawFormat < PACKAGE_FORMAT;
  if (isLegacy) {
    warnings.push(
      Number.isFinite(rawFormat) && rawFormat > 0
        ? `检测到旧版包（格式 v${rawFormat}），已按当前结构补齐字段后读入`
        : '检测到无版本号的旧版包，已按当前结构补齐字段后读入',
    );
  }

  const plots: Plot[] = asArray(root.plots).map((item) => {
    const o = asObject(item);
    const plot: Plot = {
      id: cleanText(o.id) || newId('plot'),
      plotNo: cleanText(o.plotNo),
      locality: str(o.locality),
      lng: num(o.lng, 0),
      lat: num(o.lat, 0),
      shape: o.shape === '圆形' ? '圆形' : '方形',
      area: num(o.area, 0),
      elevation: num(o.elevation, 0),
      slope: num(o.slope, 0),
      aspect: str(o.aspect),
      forestType: str(o.forestType),
      canopyDensity: num(o.canopyDensity, 0),
      dominantSpecies: str(o.dominantSpecies),
      surveyRound: num(o.surveyRound, 1),
      surveyedAt: num(o.surveyedAt, 0),
      crew: str(o.crew),
      locked: bool(o.locked, false),
      createdAt: num(o.createdAt, num(o.surveyedAt, 0)),
    };
    if (hasOwn(o, 'updatedAt')) plot.updatedAt = num(o.updatedAt, 0);
    const ft = asObject(o.fieldTimes);
    if (Object.keys(ft).length > 0) plot.fieldTimes = ft as Plot['fieldTimes'];
    if (!plot.updatedAt) plot.updatedAt = plot.surveyedAt || plot.createdAt;
    return plot;
  });

  const missingPlots = plots.filter((p) => !p.plotNo);
  if (missingPlots.length > 0) {
    throw new Error(`有 ${missingPlots.length} 条样地档案缺少样地号，无法识别，导入中止`);
  }
  if (new Set(plots.map((p) => p.plotNo)).size !== plots.length) {
    throw new Error('包内存在重复样地号，无法按样地号识别，导入中止');
  }

  const validStatus = new Set(['活立木', '枯立木', '倒木', '采伐']);
  const validOrigin = new Set(['天然', '人工']);
  const validHealth = new Set(['健康', '亚健康', '不健康']);
  const validLayer = new Set(['更新苗', '灌木', '草本']);
  const validDistribution = new Set(['均匀', '团状']);
  const validBrowse = new Set(['无', '轻度', '中度', '重度']);

  const trees: TreeRecord[] = [];
  asArray(root.trees).forEach((item) => {
    const o = asObject(item);
    const treeNo = cleanText(o.treeNo);
    if (!treeNo) return; // 无树号记录无法按自然键识别，丢弃
    const round = num(o.round, 1);
    const measuredAt = num(o.measuredAt, 0);
    const tree: TreeRecord = {
      id: cleanText(o.id) || newId('tree'),
      plotId: cleanText(o.plotId),
      treeNo,
      species: str(o.species),
      dbhCm: num(o.dbhCm, 0),
      heightM: num(o.heightM, 0),
      underBranchH: num(o.underBranchH, 0),
      crownWidth: num(o.crownWidth, 0),
      status: validStatus.has(str(o.status)) ? (str(o.status) as TreeRecord['status']) : '活立木',
      origin: validOrigin.has(str(o.origin)) ? (str(o.origin) as TreeRecord['origin']) : '天然',
      healthClass: validHealth.has(str(o.healthClass))
        ? (str(o.healthClass) as TreeRecord['healthClass'])
        : '健康',
      tiltDeg: num(o.tiltDeg, 0),
      remark: str(o.remark),
      round,
      measuredAt,
    };
    const ft = asObject(o.fieldTimes);
    if (Object.keys(ft).length > 0) tree.fieldTimes = ft as TreeRecord['fieldTimes'];
    trees.push(tree);
  });
  if (!isLegacy && asArray(root.trees).length > trees.length) {
    warnings.push(`${asArray(root.trees).length - trees.length} 条样木缺少树号，已跳过`);
  }

  const regens: RegenShrub[] = [];
  asArray(root.regens).forEach((item) => {
    const o = asObject(item);
    const layerRaw = str(o.layer);
    const species = cleanText(o.species);
    const layer = validLayer.has(layerRaw) ? (layerRaw as RegenShrub['layer']) : '更新苗';
    if (!species) return;
    const row: RegenShrub = {
      id: cleanText(o.id) || newId('regen'),
      plotId: cleanText(o.plotId),
      layer,
      species,
      heightCm: num(o.heightCm, 0),
      count: num(o.count, 0),
      ageGroup: str(o.ageGroup, '多年生'),
      distribution: validDistribution.has(str(o.distribution))
        ? (str(o.distribution) as RegenShrub['distribution'])
        : '均匀',
      browseDamage: validBrowse.has(str(o.browseDamage))
        ? (str(o.browseDamage) as RegenShrub['browseDamage'])
        : '无',
      round: num(o.round, 1),
    };
    if (hasOwn(o, 'updatedAt')) row.updatedAt = num(o.updatedAt, 0);
    const ft = asObject(o.fieldTimes);
    if (Object.keys(ft).length > 0) row.fieldTimes = ft as RegenShrub['fieldTimes'];
    regens.push(row);
  });

  // 子记录 plotId 悬空时，若包内只有一个样地则归并过去（旧版包常见）
  const orphanTrees = trees.filter((t) => !plots.some((p) => p.id === t.plotId));
  const orphanRegens = regens.filter((r) => !plots.some((p) => p.id === r.plotId));
  if (plots.length === 1) {
    orphanTrees.forEach((t) => {
      t.plotId = plots[0].id;
    });
    orphanRegens.forEach((r) => {
      r.plotId = plots[0].id;
    });
  } else {
    orphanTrees.forEach((t) => {
      t.plotId = ''; // 合并阶段进入 skipped 分支
    });
    orphanRegens.forEach((r) => {
      r.plotId = '';
    });
  }

  const pkg: OfflinePackage = {
    kind: str(root.kind, PACKAGE_KIND),
    format: Number.isFinite(rawFormat) && rawFormat > 0 ? rawFormat : 1,
    packageId: cleanText(root.packageId) || '',
    exportedAt: num(root.exportedAt, 0),
    device: str(root.device, '外业终端（未知）'),
    crew: str(root.crew) || undefined,
    plots,
    trees,
    regens,
  };
  if (!pkg.packageId) {
    pkg.packageId = contentFingerprint(pkg);
    if (isLegacy) warnings.push('旧版包无包指纹，已按内容生成，重复导入仍可按对象自然键判重');
  }
  if (!pkg.exportedAt) {
    pkg.exportedAt = Math.max(...plots.map((p) => p.surveyedAt), ...trees.map((t) => t.measuredAt), 0) || Date.now();
  }

  if (plots.length === 0) throw new Error('离线包内没有任何样地档案');
  return { pkg, warnings };
}
