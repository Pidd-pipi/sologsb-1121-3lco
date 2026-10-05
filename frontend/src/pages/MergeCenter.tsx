import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Modal,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  Upload,
  type TableProps,
} from 'antd';
import { DeleteOutlined, InboxOutlined, RedoOutlined } from '@ant-design/icons';
import { usePlotStore } from '../stores/plotStore';
import { useTreeStore } from '../stores/treeStore';
import { useRegenStore } from '../stores/regenStore';
import { deleteBatch, findBatchByPackage, listBatches, saveBatch } from '../utils/db';
import { contentHash, parsePackage } from '../utils/offline';
import { applyPackage, computeMergePlan, loadLocalState, reportSummary } from '../utils/merge';
import type { FieldChange, ImportBatch, MergePlan, MergeReport, OfflinePackage } from '../types/offline';

interface PreviewState {
  pkg: OfflinePackage;
  plan: MergePlan;
  warnings: string[];
  fileName: string;
  raw: string;
}

interface ChangeRow {
  key: string;
  target: string;
  clock: string;
  label: string;
  change: FieldChange;
}

function fmtValue(field: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (field === 'locked') return value ? '已锁定' : '未锁定';
  if (field === 'surveyedAt') return new Date(Number(value)).toLocaleString('zh-CN');
  return String(value);
}

/** /merge 离线包合并：逐对象预览、冲突并排取舍、失败批次重试、同包幂等 */
export default function MergeCenter() {
  const loadPlots = usePlotStore((s) => s.load);
  const loadTrees = useTreeStore((s) => s.load);
  const loadRegens = useRegenStore((s) => s.load);

  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [report, setReport] = useState<MergeReport | null>(null);
  const [applying, setApplying] = useState(false);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  const refreshBatches = useCallback(async () => {
    setBatches(await listBatches());
  }, []);

  useEffect(() => {
    void refreshBatches();
  }, [refreshBatches]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  /** 解析 → 幂等检查 → 生成合并计划并打开预览（失败保留批次） */
  const handleText = useCallback(
    async (text: string, fileName: string) => {
      setError('');
      setReport(null);
      let parsed: ReturnType<typeof parsePackage>;
      try {
        parsed = parsePackage(text);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        await saveBatch({
          id: `batch_${contentHash(text)}`,
          packageId: `pkg_${contentHash(text)}`,
          fileName,
          status: 'failed',
          error: message,
          receivedAt: Date.now(),
          payload: text,
        });
        setError(`导入失败：${message}。批次已保留，可在下方列表中重试。`);
        await refreshBatches();
        return;
      }
      const { pkg, warnings } = parsed;
      const existing = await findBatchByPackage(pkg.meta.packageId);
      if (existing?.status === 'applied') {
        setToast(
          `离线包「${fileName}」已于 ${new Date(existing.appliedAt ?? existing.receivedAt).toLocaleString('zh-CN')} 完成合并，本次未重复导入，不会新增重复记录`,
        );
        return;
      }
      const local = await loadLocalState();
      const plan = computeMergePlan(pkg, local);
      setPreview({ pkg, plan, warnings, fileName, raw: text });
    },
    [refreshBatches],
  );

  const confirmMerge = async () => {
    if (!preview) return;
    setApplying(true);
    const batchId = `batch_${preview.pkg.meta.packageId}`;
    try {
      const prior = await findBatchByPackage(preview.pkg.meta.packageId);
      const result = await applyPackage(preview.pkg);
      await saveBatch({
        id: batchId,
        packageId: preview.pkg.meta.packageId,
        fileName: preview.fileName,
        status: 'applied',
        summary: reportSummary(result),
        receivedAt: prior?.receivedAt ?? Date.now(),
        appliedAt: Date.now(),
        payload: preview.raw,
      });
      await Promise.all([loadPlots(), loadTrees(), loadRegens()]);
      setReport(result);
      setPreview(null);
      setToast('合并完成，复查比对与林分汇总已按新数据重算');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const prior = await findBatchByPackage(preview.pkg.meta.packageId);
      await saveBatch({
        id: batchId,
        packageId: preview.pkg.meta.packageId,
        fileName: preview.fileName,
        status: 'failed',
        error: message,
        receivedAt: prior?.receivedAt ?? Date.now(),
        payload: preview.raw,
      });
      setPreview(null);
      setError(`合并失败：${message}。批次已保留，可在下方列表中重试。`);
    } finally {
      setApplying(false);
      await refreshBatches();
    }
  };

  const removeBatch = async (id: string) => {
    await deleteBatch(id);
    await refreshBatches();
  };

  const changeRows = useMemo<ChangeRow[]>(() => {
    if (!preview) return [];
    const rows: ChangeRow[] = [];
    preview.plan.plots
      .filter((i) => i.changes.length > 0)
      .forEach((i) =>
        i.changes.forEach((c, idx) =>
          rows.push({ key: `p-${i.plotNo}-${idx}`, target: `样地 ${i.plotNo}`, clock: '调查时间', label: c.label, change: c }),
        ),
      );
    preview.plan.trees
      .filter((i) => i.changes.length > 0)
      .forEach((i) =>
        i.changes.forEach((c, idx) =>
          rows.push({
            key: `t-${i.plotNo}-${i.treeNo}-${i.round}-${idx}`,
            target: `样木 ${i.treeNo} 号 · 第 ${i.round} 期（${i.plotNo}）`,
            clock: '补测时间',
            label: c.label,
            change: c,
          }),
        ),
      );
    preview.plan.regens
      .filter((i) => i.changes.length > 0)
      .forEach((i) =>
        i.changes.forEach((c, idx) =>
          rows.push({
            key: `r-${i.plotNo}-${i.layer}-${i.species}-${i.round}-${idx}`,
            target: `样方 ${i.layer}·${i.species} · 第 ${i.round} 期（${i.plotNo}）`,
            clock: '登记时间',
            label: c.label,
            change: c,
          }),
        ),
      );
    return rows;
  }, [preview]);

  const inserts = useMemo(() => {
    if (!preview) return { plots: 0, trees: 0, regens: 0, labels: [] as string[] };
    const { plan } = preview;
    const labels: string[] = [];
    plan.plots.filter((i) => i.action === 'insert').forEach((i) => labels.push(`样地 ${i.plotNo}`));
    plan.trees.filter((i) => i.action === 'insert').forEach((i) => labels.push(`样木 ${i.treeNo} 号 · 第 ${i.round} 期（${i.plotNo}）`));
    plan.regens
      .filter((i) => i.action === 'insert')
      .forEach((i) => labels.push(`样方 ${i.layer}·${i.species} · 第 ${i.round} 期（${i.plotNo}）`));
    return {
      plots: plan.plots.filter((i) => i.action === 'insert').length,
      trees: plan.trees.filter((i) => i.action === 'insert').length,
      regens: plan.regens.filter((i) => i.action === 'insert').length,
      labels,
    };
  }, [preview]);

  const unchangedCount = useMemo(() => {
    if (!preview) return 0;
    const { plan } = preview;
    return [...plan.plots, ...plan.trees, ...plan.regens].filter((i) => i.action === 'unchanged').length;
  }, [preview]);

  const protectedCount = useMemo(
    () => changeRows.filter((r) => r.change.adoptedFrom === 'protected').length,
    [changeRows],
  );

  const changeColumns: NonNullable<TableProps<ChangeRow>['columns']> = [
    { title: '对象', dataIndex: 'target', width: 230 },
    { title: '字段', dataIndex: 'label', width: 90 },
    {
      title: '本地值',
      width: 150,
      render: (_: unknown, row: ChangeRow) => fmtValue(row.change.field, row.change.localValue),
    },
    {
      title: '包内值',
      width: 150,
      render: (_: unknown, row: ChangeRow) => fmtValue(row.change.field, row.change.incomingValue),
    },
    {
      title: '采用值',
      width: 170,
      render: (_: unknown, row: ChangeRow) => (
        <Typography.Text
          strong
          type={row.change.adoptedFrom === 'protected' ? 'danger' : row.change.adoptedFrom === 'incoming' ? 'success' : undefined}
        >
          {fmtValue(row.change.field, row.change.adoptedValue)}
        </Typography.Text>
      ),
    },
    {
      title: '取舍依据',
      width: 150,
      render: (_: unknown, row: ChangeRow) => {
        if (row.change.adoptedFrom === 'protected') {
          return (
            <Space size={4} wrap>
              <Tag color="red">保护规则</Tag>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {row.change.note}
              </Typography.Text>
            </Space>
          );
        }
        return row.change.adoptedFrom === 'incoming' ? (
          <Tag color="green">包内{row.clock}较新</Tag>
        ) : (
          <Tag color="blue">本地{row.clock}较新</Tag>
        );
      },
    },
  ];

  const batchColumns: NonNullable<TableProps<ImportBatch>['columns']> = [
    { title: '文件名', dataIndex: 'fileName', ellipsis: true },
    {
      title: '包标识',
      dataIndex: 'packageId',
      width: 150,
      ellipsis: true,
    },
    {
      title: '接收时间',
      dataIndex: 'receivedAt',
      width: 170,
      render: (v: number) => new Date(v).toLocaleString('zh-CN'),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (v: ImportBatch['status']) =>
        v === 'applied' ? <Tag color="green">已合并</Tag> : <Tag color="red">失败待重试</Tag>,
    },
    {
      title: '结果 / 错误',
      width: 280,
      ellipsis: true,
      render: (_: unknown, b: ImportBatch) => (b.status === 'applied' ? b.summary : b.error),
    },
    {
      title: '操作',
      width: 140,
      render: (_: unknown, b: ImportBatch) => (
        <Space size={4}>
          {b.status === 'failed' ? (
            <Button size="small" type="link" icon={<RedoOutlined />} onClick={() => void handleText(b.payload, b.fileName)}>
              重试
            </Button>
          ) : null}
          <Button size="small" type="link" danger icon={<DeleteOutlined />} onClick={() => void removeBatch(b.id)} />
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          离线包合并
        </Typography.Title>
        <Tag>逐对象合并</Tag>
        <Tag color="blue">同包幂等</Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to="/plots">返回样地台账</Link>
        </Button>
      </Space>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}
      {report ? (
        <Alert
          type="success"
          showIcon
          closable
          onClose={() => setReport(null)}
          message="合并完成"
          description={
            <Space direction="vertical" size={4}>
              <span>{reportSummary(report)}。复查比对与林分汇总已按合并后的新数据重算。</span>
              {report.warnings.map((w) => (
                <span key={w}>⚠ {w}</span>
              ))}
            </Space>
          }
        />
      ) : null}

      <Card size="small" title="导入离线包">
        <Upload.Dragger
          accept=".json,application/json"
          showUploadList={false}
          beforeUpload={(file) => {
            void file.text().then((text) => handleText(text, file.name));
            return false;
          }}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">点击或拖拽离线包（.json）到此处导入</p>
          <p className="ant-upload-hint">
            样地按样地号、样木按树号+复查期次、样方按层位+种类+期次识别；两边都改过的记录会在预览中并排列出，
            同一字段按现场补测时间取舍；已锁定样地与已采伐样木不会被旧包改回；同一个包重复导入不会新增重复记录。
          </p>
        </Upload.Dragger>
      </Card>

      <Card size="small" title={`导入批次（${batches.length}）`}>
        <Table<ImportBatch>
          rowKey="id"
          size="small"
          columns={batchColumns}
          dataSource={batches}
          pagination={false}
          locale={{ emptyText: '暂无导入批次' }}
        />
      </Card>

      <Modal
        open={!!preview}
        title={`合并预览 · ${preview?.fileName ?? ''}`}
        width={1000}
        onCancel={() => setPreview(null)}
        footer={[
          <Button key="cancel" onClick={() => setPreview(null)}>
            取消
          </Button>,
          <Button key="ok" type="primary" loading={applying} onClick={() => void confirmMerge()}>
            确认合并
          </Button>,
        ]}
      >
        {preview ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {preview.warnings.concat(preview.plan.warnings).map((w) => (
              <Alert key={w} type="warning" showIcon message={w} />
            ))}
            <Descriptions size="small" column={3}>
              <Descriptions.Item label="样地号">{preview.pkg.meta.plotNo ?? '多样地'}</Descriptions.Item>
              <Descriptions.Item label="格式版本">v{preview.pkg.meta.formatVersion}</Descriptions.Item>
              <Descriptions.Item label="导出时间">
                {preview.pkg.meta.exportedAt ? new Date(preview.pkg.meta.exportedAt).toLocaleString('zh-CN') : '未知'}
              </Descriptions.Item>
              <Descriptions.Item label="包标识" span={2}>
                {preview.pkg.meta.packageId}
              </Descriptions.Item>
              <Descriptions.Item label="记录数">
                样地 {preview.pkg.plots.length} · 样木 {preview.pkg.trees.length} · 样方 {preview.pkg.regens.length}
              </Descriptions.Item>
            </Descriptions>

            <Row gutter={12}>
              <Col span={4}>
                <Statistic title="新增样地" value={inserts.plots} suffix="个" />
              </Col>
              <Col span={4}>
                <Statistic title="新增样木" value={inserts.trees} suffix="株" />
              </Col>
              <Col span={4}>
                <Statistic title="新增样方" value={inserts.regens} suffix="条" />
              </Col>
              <Col span={4}>
                <Statistic title="两边都改过" value={changeRows.length > 0 ? new Set(changeRows.map((r) => r.target)).size : 0} suffix="条" />
              </Col>
              <Col span={4}>
                <Statistic title="保护字段" value={protectedCount} suffix="处" />
              </Col>
              <Col span={4}>
                <Statistic title="不变记录" value={unchangedCount} suffix="条" />
              </Col>
            </Row>

            {changeRows.length > 0 ? (
              <Card size="small" title="两边都改过的记录（并排列出，同一字段按现场补测时间取舍）">
                <Table<ChangeRow>
                  rowKey="key"
                  size="small"
                  columns={changeColumns}
                  dataSource={changeRows}
                  pagination={false}
                  scroll={{ x: 1000 }}
                />
              </Card>
            ) : (
              <Alert type="info" showIcon message="没有发现两边都改过的记录，包内数据将直接并入。" />
            )}

            <Collapse
              items={[
                {
                  key: 'inserts',
                  label: `新增记录清单（${inserts.labels.length} 条，合并时写入本地）`,
                  children:
                    inserts.labels.length > 0 ? (
                      <Space wrap size={4}>
                        {inserts.labels.map((l) => (
                          <Tag key={l} color="green">
                            {l}
                          </Tag>
                        ))}
                      </Space>
                    ) : (
                      '无新增记录'
                    ),
                },
              ]}
            />
          </Space>
        ) : null}
      </Modal>
    </Space>
  );
}
