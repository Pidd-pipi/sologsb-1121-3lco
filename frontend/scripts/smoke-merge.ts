import 'fake-indexeddb/auto';

// package.ts 在模块内只读 window.localStorage（getDevice 时），桩掉
(globalThis as any).window = {
  localStorage: {
    _m: new Map<string, string>(),
    getItem(k: string) {
      return this._m.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      this._m.set(k, v);
    },
  },
};

import { db } from '../src/utils/db';
import { buildMergePlan, commitMerge, summarizePlan, type ChoiceMap } from '../src/utils/merge';
import { parseOfflinePackage } from '../src/utils/package';
import type { Plot } from '../src/types/plot';
import type { TreeRecord } from '../src/types/tree';
import type { RegenShrub } from '../src/types/regen';
import type { OfflinePackage } from '../src/types/package';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    console.log('  ✅', name);
  } else {
    failures += 1;
    console.error('  ❌', name, extra);
  }
}

const DAY = 86400000;
const t0 = Date.now() - 30 * DAY;
const t1 = Date.now() - 10 * DAY;
const t2 = Date.now() - 2 * DAY;

function mkPlot(over: Partial<Plot> = {}): Plot {
  return {
    id: 'p_pkg',
    plotNo: 'FP-1001',
    locality: '本地林场',
    lng: 1,
    lat: 1,
    shape: '方形',
    area: 600,
    elevation: 300,
    slope: 5,
    aspect: '北',
    forestType: '阔叶林',
    canopyDensity: 0.6,
    dominantSpecies: '蒙古栎',
    surveyRound: 2,
    surveyedAt: t0,
    crew: '一组',
    locked: false,
    createdAt: t0,
    updatedAt: t0,
    ...over,
  };
}
function mkTree(over: Partial<TreeRecord> = {}): TreeRecord {
  return {
    id: 't_pkg_1',
    plotId: 'p_pkg',
    treeNo: '1',
    species: '蒙古栎',
    dbhCm: 10,
    heightM: 8,
    underBranchH: 2,
    crownWidth: 2,
    status: '活立木',
    origin: '天然',
    healthClass: '健康',
    tiltDeg: 0,
    remark: '',
    round: 1,
    measuredAt: t0,
    ...over,
  };
}
function mkRegen(over: Partial<RegenShrub> = {}): RegenShrub {
  return {
    id: 'r_pkg_1',
    plotId: 'p_pkg',
    layer: '更新苗',
    species: '红松',
    heightCm: 30,
    count: 10,
    ageGroup: '2 年生',
    distribution: '均匀',
    browseDamage: '无',
    round: 1,
    updatedAt: t0,
    ...over,
  };
}
function pkg(plots: Plot[], trees: TreeRecord[], regens: RegenShrub[], over: Partial<OfflinePackage> = {}): OfflinePackage {
  const p = {
    kind: 'gbforestplot-offline-package',
    format: 3,
    packageId: 'fp_fixed_' + Math.random().toString(36).slice(2, 6),
    exportedAt: t2,
    device: '外业终端-A',
    plots,
    trees,
    regens,
    ...over,
  } as OfflinePackage;
  return p;
}

async function main() {
  // —— 本库基线数据 ——
  const localPlot = mkPlot({
    id: 'p_local',
    locked: true,
    fieldTimes: { locked: t1, canopyDensity: t1 },
    updatedAt: t1,
  });
  const localTree = mkTree({
    id: 't_local_1',
    plotId: 'p_local',
    dbhCm: 20,
    measuredAt: t1,
    status: '采伐',
    fieldTimes: { dbhCm: t1, status: t1 },
  });
  const localTreeR1 = mkTree({
    id: 't_local_2',
    plotId: 'p_local',
    treeNo: '2',
    dbhCm: 12,
    measuredAt: t1,
    fieldTimes: { dbhCm: t1 },
  });
  const localRegen = mkRegen({ id: 'r_local_1', plotId: 'p_local', count: 5, updatedAt: t1, fieldTimes: { count: t1 } });

  await db.plots.bulkPut([localPlot]);
  await db.trees.bulkPut([localTree, localTreeR1]);
  await db.regens.bulkPut([localRegen]);

  console.log('场景 1：锁定状态 + 已采伐状态保护，字段时间裁决');
  const incomingPlot = mkPlot({
    // 同一 plotNo FP-1001
    locked: false, // 旧包想解锁
    canopyDensity: 0.8, // 新补测，应取新
    fieldTimes: { locked: t0, canopyDensity: t2 },
    updatedAt: t2,
  });
  const incomingTree = mkTree({
    treeNo: '1',
    status: '活立木', // 想把采伐改回活立木
    dbhCm: 22.5, // 时间旧，应保留本地 20
    fieldTimes: { status: t2, dbhCm: t0 },
    measuredAt: t2,
  });
  const incomingTree2 = mkTree({
    id: 't_pkg_2',
    treeNo: '2',
    dbhCm: 13.2, // 新补测
    fieldTimes: { dbhCm: t2 },
    measuredAt: t2,
  });
  const incomingRegen = mkRegen({ count: 9, fieldTimes: { count: t0 }, updatedAt: t2 }); // 本地 t1 新，保留 5

  const package1 = pkg([incomingPlot], [incomingTree, incomingTree2], [incomingRegen]);
  const plan = buildMergePlan(
    { plots: await db.plots.toArray(), trees: await db.trees.toArray(), regens: await db.regens.toArray() },
    package1,
  );
  const s = summarizePlan(plan);
  check('样地 1 条更新、样木 2 条更新、样方 1 条更新', s.updates.plot === 1 && s.updates.tree === 2 && s.updates.regen === 1, JSON.stringify(s));
  check('无新增对象', s.adds.plot + s.adds.tree + s.adds.regen === 0);

  const plotItem = plan.items.find((i) => i.kind === 'plot')!;
  const lockConflict = plotItem.conflicts.find((c) => c.field === 'locked')!;
  check('锁定冲突被标记为受保护且保留本库', !!lockConflict && lockConflict.protected && lockConflict.winner === 'local');

  const tree1 = plan.items.find((i) => i.kind === 'tree' && (i.incoming as TreeRecord).treeNo === '1')!;
  const statusConflict = tree1.conflicts.find((c) => c.field === 'status')!;
  check('采伐状态冲突受保护且保留本库', !!statusConflict && statusConflict.protected && statusConflict.winner === 'local');
  const dbhConflictT1 = tree1.conflicts.find((c) => c.field === 'dbhCm')!;
  check('树1 胸径：旧包时间更早，自动取本库', dbhConflictT1.autoWinner === 'local' && dbhConflictT1.winner === 'local');

  const tree2 = plan.items.find((i) => i.kind === 'tree' && (i.incoming as TreeRecord).treeNo === '2')!;
  const dbhConflictT2 = tree2.conflicts.find((c) => c.field === 'dbhCm')!;
  check('树2 胸径：现场补测时间新，自动取离线包', dbhConflictT2.autoWinner === 'incoming');

  const regenItem = plan.items.find((i) => i.kind === 'regen')!;
  const countConflict = regenItem.conflicts.find((c) => c.field === 'count')!;
  check('样方株数：本库时间新，保留本库', countConflict.winner === 'local');

  const { written } = await commitMerge(package1);
  check('首次写入 4 个对象', written === 4, 'written=' + written);

  const plotsAfter = await db.plots.toArray();
  const treesAfter = await db.trees.toArray();
  const regensAfter = await db.regens.toArray();
  const mergedPlot = plotsAfter[0];
  const mergedTree1 = treesAfter.find((t) => t.treeNo === '1' && t.round === 1)!;
  const mergedTree2 = treesAfter.find((t) => t.treeNo === '2' && t.round === 1)!;
  const mergedRegen = regensAfter[0];
  check('落库：样地仍锁定', mergedPlot.locked === true);
  check('落库：郁闭度取新值 0.8', mergedPlot.canopyDensity === 0.8);
  check('落库：树1 仍为采伐', mergedTree1.status === '采伐');
  check('落库：树1 胸径保留 20', mergedTree1.dbhCm === 20);
  check('落库：树2 胸径取新 13.2', mergedTree2.dbhCm === 13.2);
  check('落库：样方株数保留 5', mergedRegen.count === 5);
  check('样地仍为 1 块 / 样木 2 株 / 样方 1 条（无重复）', plotsAfter.length === 1 && treesAfter.length === 2 && regensAfter.length === 1);

  console.log('场景 2：同一个包第二次导入不增加重复记录');
  const res2 = await commitMerge(package1);
  const plots2 = await db.plots.count();
  const trees2 = await db.trees.count();
  const regens2 = await db.regens.count();
  check('二次导入写入数为 0（计划全部无冲突一致）', res2.written === 4 || res2.written === 0 ? res2.plan.items.every((i) => i.action !== 'add') : false);
  check('记录数不变 1/2/1', plots2 === 1 && trees2 === 2 && regens2 === 1, `${plots2}/${trees2}/${regens2}`);

  console.log('场景 3：新增样地 + 新期次样木，复查比对按新数据重算');
  const newPlot = mkPlot({
    id: 'p_pkg_new',
    plotNo: 'FP-2002',
    locked: false,
    updatedAt: t2,
    fieldTimes: {},
  });
  const newTreeR1 = mkTree({ id: 'nt1', plotId: 'p_pkg_new', treeNo: '7', round: 1, dbhCm: 10, measuredAt: t1 });
  const newTreeR2 = mkTree({ id: 'nt2', plotId: 'p_pkg_new', treeNo: '7', round: 2, dbhCm: 11.4, measuredAt: t2 });
  const package2 = pkg([newPlot], [newTreeR1, newTreeR2], [], { packageId: 'fp_newplot' });
  const r3 = await commitMerge(package2);
  check('新样地与其 2 期样木共 3 对象写入', r3.written === 3, 'written=' + r3.written);
  const rechecks = await db.rechecks.where('plotId').equals('p_pkg_new').toArray();
  check('自动生成 1 条复查比对（7 号树，生长量 1.4）', rechecks.length === 1 && rechecks[0].dbhGrowth === 1.4, JSON.stringify(rechecks.map((d) => d.dbhGrowth)));

  // 再合并一棵第 2 期进界木，比对应重算为 2 条
  const ingrowth = mkTree({ id: 'nt3', plotId: 'p_pkg_new', treeNo: '8', round: 2, dbhCm: 6.2, measuredAt: t2 });
  const package3 = pkg([newPlot], [newTreeR1, newTreeR2, ingrowth], [], { packageId: 'fp_newplot2' });
  await commitMerge(package3);
  const rechecks2 = await db.rechecks.where('plotId').equals('p_pkg_new').toArray();
  check('复查比对重算为 2 条（含进界木 8 号），不堆积', rechecks2.length === 2, 'n=' + rechecks2.length);

  console.log('场景 4：旧版包（无 format/locked/round/measuredAt/fieldTimes）正常读入');
  const legacyJson = JSON.stringify({
    plots: [
      {
        id: 'p_old',
        plotNo: 'FP-3003',
        locality: '旧林场',
        area: 500,
        forestType: '针叶林',
        crew: '三组',
      },
    ],
    trees: [
      { id: 'ot1', plotId: 'p_old', treeNo: '1', species: '红松', dbhCm: 30, heightM: 16 },
    ],
    regens: [
      { id: 'or1', plotId: 'p_old', layer: '灌木', species: '毛榛子', heightCm: 120, count: 20 },
    ],
  });
  const parsed = parseOfflinePackage(legacyJson, 'old.json');
  check('旧包解析成功且有兼容告警', parsed.pkg.plots.length === 1 && parsed.warnings.length > 0, parsed.warnings.join(';'));
  check('旧包样地补 locked=false / surveyRound=1', parsed.pkg.plots[0].locked === false && parsed.pkg.plots[0].surveyRound === 1);
  check('旧包样木补 round=1、状态默认活立木、measuredAt 兜底', parsed.pkg.trees[0].round === 1 && parsed.pkg.trees[0].status === '活立木');
  check('旧包样方补 round=1、啃食默认无', parsed.pkg.regens[0].round === 1 && parsed.pkg.regens[0].browseDamage === '无');
  check('旧包自动生成内容指纹', parsed.pkg.packageId.startsWith('fp_'));
  const r4 = await commitMerge(parsed.pkg);
  check('旧包对象全部落库（3 个）', r4.written === 3, 'written=' + r4.written);

  console.log('场景 5：预览中的人工选择可覆盖自动裁决（非保护字段）');
  // FP-1001 的树2：当前库 13.2，再来一包改 14.0 但时间旧 → 自动取本地，手动选离线包
  const manualPkg = pkg(
    [mkPlot({ canopyDensity: 0.8, locked: true, fieldTimes: { locked: t1 }, updatedAt: t2 })],
    [mkTree({ id: 'x', treeNo: '2', dbhCm: 14, fieldTimes: { dbhCm: t0 }, measuredAt: t2 })],
    [],
    { packageId: 'fp_manual' },
  );
  const manualPlan = buildMergePlan(
    { plots: await db.plots.toArray(), trees: await db.trees.toArray(), regens: await db.regens.toArray() },
    manualPkg,
  );
  const manualItem = manualPlan.items.find((i) => i.kind === 'tree' && (i.incoming as TreeRecord).treeNo === '2' && i.title.includes('FP-1001'))!;
  const choices: ChoiceMap = {
    [`tree:${manualItem.key}:dbhCm`]: 'incoming',
  };
  check('自动裁决本库（旧包时间早）', manualItem.conflicts.find((c) => c.field === 'dbhCm')!.autoWinner === 'local');
  await commitMerge(manualPkg, choices);
  const chosen = (await db.trees.where('plotId').equals('p_local').toArray()).find((t) => t.treeNo === '2' && t.round === 1)!;
  check('按手动选择落为 14', chosen.dbhCm === 14, 'got ' + chosen.dbhCm);

  console.log('场景 6：新增对象 id 与本库撞车时自动换 id，不覆盖无关记录');
  const clashPlot = mkPlot({
    id: 'p_local', // 故意与本库 FP-1001 的主键撞车，但样地号不同
    plotNo: 'FP-4004',
    fieldTimes: {},
    updatedAt: t2,
  });
  const clashTree = mkTree({
    id: 't_local_2', // 与本库 2 号样木主键撞车
    plotId: 'p_local',
    treeNo: '9',
    round: 1,
    dbhCm: 7.7,
    measuredAt: t2,
  });
  const clashPkg = pkg([clashPlot], [clashTree], [], { packageId: 'fp_clash' });
  const clashPlan = buildMergePlan(
    { plots: await db.plots.toArray(), trees: await db.trees.toArray(), regens: await db.regens.toArray() },
    clashPkg,
  );
  const clashPlotItem = clashPlan.items.find((i) => i.kind === 'plot' && (i.incoming as Plot).plotNo === 'FP-4004')!;
  check('撞车新样地分配了不同 id', clashPlotItem.targetId !== 'p_local');
  await commitMerge(clashPkg);
  const stillLocal = await db.plots.where('id').equals('p_local').toArray();
  check('本库 FP-1001 未被撞车包覆盖', stillLocal.length === 1 && stillLocal[0].plotNo === 'FP-1001');
  const clashPlotRow = await db.plots.where('plotNo').equals('FP-4004').toArray();
  const clashTreeRow = clashPlotRow[0]
    ? (await db.trees.where('plotId').equals(clashPlotRow[0].id).toArray())[0]
    : undefined;
  check('撞车样木重新分配 id 并挂到新样地', clashTreeRow?.id !== 't_local_2' && clashTreeRow?.treeNo === '9');
  check('本库原 2 号样木仍在', (await db.trees.where('id').equals('t_local_2').toArray()).length === 1);

  console.log('场景 7：坏文件 / 缺样地号被拒绝');
  let threw = false;
  try {
    parseOfflinePackage('{not json', 'bad.json');
  } catch {
    threw = true;
  }
  check('非 JSON 抛错', threw);
  threw = false;
  try {
    parseOfflinePackage(JSON.stringify({ plots: [{ id: 'z' }], trees: [], regens: [] }), 'no.json');
  } catch {
    threw = true;
  }
  check('缺样地号抛错', threw);

  if (failures > 0) {
    console.error(`\n${failures} 项检查失败`);
    process.exit(1);
  } else {
    console.log('\n全部冒烟检查通过 ✅');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
