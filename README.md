# sologsb-1121 森林样地调查记录台（gbforestplot）

面向森林资源调查员的固定样地工作台：为样地建档，逐株记录胸径、树高、枝下高与检尺位置，登记更新幼苗与灌木层，并在复查期与上一期数据逐株比对生长量、计算林分因子。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21821**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| UI | Ant Design 5 |
| 构建 | Vite 5 |
| 状态管理 | Zustand |
| 路由 | React Router v6（BrowserRouter） |
| 本地存储 | IndexedDB（Dexie 4），含结构版本号与升级迁移 |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc 类型检查 + vite 构建
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1121/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.tsx
        ├── index.css
        ├── router/index.tsx
        ├── types/{plot,tree,regen,recheck,common,package}.ts
        ├── stores/{plot,tree,regen}Store.ts
        ├── components/common/{PlotCard,TreeTable,GrowthDiffTable,RoundTag}.tsx
        ├── components/sync/MergePreview.tsx
        ├── hooks/{usePlotFilter,useTreeStats}.ts
        ├── pages/{PlotList,TreeEntry,RegenView,RecheckView,PlotSummary,SyncCenter}.tsx
        └── utils/{db,forestCalc,id,merge,recheck,package}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/plots` | 样地台账：按地点/林型/复查期次/郁闭度区间筛选，显示面积、优势树种、已录样木数，可锁定往期、勾选导出现场离线包 | Plot |
| `/sync` | 外业离线包逐对象合并：解析预览、双边冲突并排比对、失败批次保留重试 | ImportBatch、OfflinePackage |
| `/plots/:id/trees` | 样木录入与清单：径阶分组快速录入、行内改胸径、树种联想、胸径异常提示 | TreeRecord |
| `/plots/:id/regen` | 更新苗与灌木样方记录，按高度级与株数分组合计 | RegenShrub |
| `/plots/:id/recheck` | 复查比对：逐株两期胸径/树高与生长量，标记缺失与状态变化，保存比对结果 | RecheckDiff、TreeRecord |
| `/summary/:plotId` | 林分因子汇总：每公顷株数、平均胸径、断面积、郁闭度、更新密度，可导出调查记录文本 | Plot、TreeRecord、RegenShrub |

`/` 重定向到 `/plots`，未匹配路由同样兜底到 `/plots`。

## 数据存储说明

- 数据库名 `gbforestplot`，当前结构版本 **v3**（`localStorage['gbforestplot:db-version']` 记录）。
- 五张表：`plots`（样地）、`trees`（样木，按期次分行）、`regens`（更新苗与灌木样方）、`rechecks`（复查逐株比对）、`importBatches`（离线包导入批次）。
- v1 → v2 迁移：为老样地补 `locked`、`surveyRound`，为老样木补 `round`、`measuredAt`，并新增索引。
- v2 → v3 迁移：样地/样方补 `updatedAt`；样地、样木、样方均支持字段级 `fieldTimes`（现场补测时间）；新增 `importBatches` 表。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 个示范样地、11 条样木（含第 1/2 两期，便于直接做复查比对）与 4 条样方记录。

## 外业离线包与逐对象合并

外业队员各带一份按样地勾选导出的 JSON 离线包（`/plots` → 导出离线包），回队后在 `/sync` 并入档案库：

- **识别规则（不按整包/行 id 覆盖）**：样地档案按**样地号**；样木按**树号 + 复查期次**（样地号域内）；样方按**层位 + 种类 + 期次**。
- **冲突裁决**：两边都改过的记录在预览里并排列出本库值/离线包值及各自现场补测时间；同一字段按 `fieldTimes` 里的现场补测时间决定新值（时间相同取传入方），可在预览中手动改取数方。仅一侧有值的字段自动补齐。
- **硬保护**：样地 `locked=true` 不会被旧包改回未锁定；本库已标记「采伐」的样木状态不会被旧包改回非采伐；样地号等识别键不参与改写。
- **失败批次保留**：解析成功的包先落 `importBatches`（含原始包）；写入失败标记 failed 后可一键重试，无需重发包。
- **幂等**：包带内容指纹（由样地号、自然键与记录内容决定），同一包第二次导入被识别提示；所有对象按自然键 upsert，不会增加重复记录。
- **合并后重算**：受影响样地已保存的复查比对在同一事务内按新数据整体重建（无历史记录且有两期以上数据时自动生成最新相邻两期）；林分汇总由前端按合并后数据即时重算。
- **旧版包兼容**：无版本号或 v1/v2 的包可容错读入，自动补齐 `locked/round/measuredAt/updatedAt`、枚举默认值与包指纹；子记录样地 id 悬空且包内仅一个样地时自动归并。

合并逻辑的端到端冒烟脚本：`frontend/scripts/smoke-merge.ts`（`npx esbuild scripts/smoke-merge.ts --bundle --platform=node --format=esm --outfile=/tmp/smoke.mjs && node /tmp/smoke.mjs`，需 `fake-indexeddb`）。

## 功能要点

- **径阶归组**：按「6/8/12/16/20/24/28/32+」cm 径阶自动归组，表格内联展示各径阶株数。
- **胸径异常提示**：数值超出 0~200 cm 或与本树种同期均值偏离 >60% 时标黄并给出提示。
- **复查比对**：任选上下两期生成逐株差值表，标记「本期未复测（疑似采伐或倒伏）」与「本期新增进界木」，生长率为负或缺失行高亮，并计算保留木生长率。
- **林分因子**：每公顷株数、平均胸径/树高、断面积与每公顷断面积、冠幅折算郁闭度、更新苗/灌木密度。
- **导出**：复查比对结果写入本地档案库；林分汇总可复制或导出调查记录 txt。
