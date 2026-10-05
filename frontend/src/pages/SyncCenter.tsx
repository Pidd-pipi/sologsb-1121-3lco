import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Modal,
  Popconfirm,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  Upload,
  message,
  type TableProps,
  type UploadProps,
} from 'antd';
import {
  CheckCircleOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  FileSearchOutlined,
  InboxOutlined,
  RedoOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { usePlotStore } from '../stores/plotStore';
import { useTreeStore } from '../stores/treeStore';
import { useRegenStore } from '../stores/regenStore';
import MergePreview from '../components/sync/MergePreview';
import {
  deleteImportBatch,
  findBatchByPackageId,
  listImportBatches,
  saveImportBatch,
} from '../utils/db';
import {
  buildMergePlan,
  commitMerge,
  summarizePlan,
  type ChoiceMap,
  type MergePlan,
} from '../utils/merge';
import { parseOfflinePackage } from '../utils/package';
import { newId } from '../utils/id';
import type { ImportBatch, OfflinePackage, ParseResult } from '../types/package';

const { Dragger } = Upload;

type Stage = 'idle' | 'preview' | 'committing' | 'done';

interface CommitOutcome {
  written: number;
  adds: ReturnType<typeof summarizePlan>['adds'];
  updates: ReturnType<typeof summarizePlan>['updates'];
  conflictCount: number;
  skipped: number;
}

function fmt(t: number): string {
  return t ? new Date(t).toLocaleString('zh-CN') : '—';
}

/** /sync 外业离线包逐对象合并：预览双边冲突、失败批次保留重试、重复导入幂等 */
export default function SyncCenter() {
  const plots = usePlotStore((s) => s.items);
  const trees = useTreeStore((s) => s.items);
  const regens = useRegenStore((s) => s.items);
  const reloadPlots = usePlotStore((s) => s.load);
  const reloadTrees = useTreeStore((s) => s.load);
  const reloadRegens = useRegenStore((s) => s.load);

  const [stage, setStage] = useState<Stage>('idle');
  const [fileName, setFileName] = useState('');
  const [pkg, setPkg] = useState<OfflinePackage | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [choices, setChoices] = useState<ChoiceMap>({});
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [dupBatch, setDupBatch] = useState<ImportBatch | null>(null);
  const [commitError, setCommitError] = useState('');
  const [outcome, setOutcome] = useState<CommitOutcome | null>(null);
  const batchIdRef = useRef<string>('');

  const refreshBatches = useCallback(async () => {
    setBatches(await listImportBatches());
  }, []);

  useEffect(() => {
    void refreshBatches();
  }, [refreshBatches]);

  const summary = useMemo(() => (plan ? summarizePlan(plan) : null), [plan]);

  const openPreview = useCallback(
    (nextPkg: OfflinePackage, nextWarnings: string[], nextFileName: string) => {
      const nextPlan = buildMergePlan({ plots, trees, regens }, nextPkg, {});
      setPkg(nextPkg);
      setWarnings(nextWarnings);
      setFileName(nextFileName);
      setPlan(nextPlan);
      setChoices({});
      setCommitError('');
      setOutcome(null);
      setStage('preview');
    },
    [plots, trees, regens],
  );

  const handleFile = useCallback(
    async (file: File) => {
      let parsed: ParseResult;
      try {
        const text = await file.text();
        parsed = parseOfflinePackage(text, file.name);
      } catch (err) {
        message.error(err instanceof Error ? err.message : '离线包解析失败');
        return;
      }

      const existed = await findBatchByPackageId(parsed.pkg.packageId);
      if (existed) {
        setDupBatch(existed);
        return;
      }

      // 失败后保留批次供重试：入预览即落一条 pending 批次（含原始包）
      const batchId = newId('batch');
      batchIdRef.current = batchId;
      const batch: ImportBatch = {
        id: batchId,
        packageId: parsed.pkg.packageId,
        fileName: file.name,
        device: parsed.pkg.device,
        exportedAt: parsed.pkg.exportedAt,
        createdAt: Date.now(),
        status: 'pending',
        pkg: parsed.pkg,
      };
      await saveImportBatch(batch);
      await refreshBatches();
      openPreview(parsed.pkg, parsed.warnings, file.name);
    },
    [openPreview, refreshBatches],
  );

  const uploadProps: UploadProps = {
    accept: '.json,application/json',
    multiple: false,
    showUploadList: false,
    beforeUpload: (file) => {
      void handleFile(file);
      return false; // 阻止 antd 自动上传，本应用纯本地解析
    },
  };

  const retryBatch = async (batch: ImportBatch) => {
    batchIdRef.current = batch.id;
    openPreview(batch.pkg, batch.status === 'failed' ? ['正在重试上次失败的导入批次'] : [], batch.fileName);
  };

  const viewImported = (batch: ImportBatch) => {
    openPreview(batch.pkg, ['该包此前已成功导入；以下为按当前数据重算的预览，再次提交不会产生重复记录。'], batch.fileName);
  };

  const removeBatch = async (id: string) => {
    await deleteImportBatch(id);
    await refreshBatches();
    message.success('批次已删除');
  };

  const confirmMerge = async () => {
    if (!pkg) return;
    setStage('committing');
    setCommitError('');
    const persist = async (status: 'imported' | 'failed', error?: string) => {
      // 按批次 id 更新：重试 / 二次确认都不会新增重复批次
      const existing = batches.find((b) => b.id === batchIdRef.current);
      await saveImportBatch({
        id: batchIdRef.current || newId('batch'),
        packageId: pkg.packageId,
        fileName,
        device: pkg.device,
        exportedAt: pkg.exportedAt,
        createdAt: existing?.createdAt ?? Date.now(),
        status,
        error,
        pkg,
      });
    };
    try {
      const { written, plan: committedPlan } = await commitMerge(pkg, choices);
      const stat = summarizePlan(committedPlan);
      await persist('imported');
      setOutcome({
        written,
        adds: stat.adds,
        updates: stat.updates,
        conflictCount: stat.conflictCount,
        skipped: committedPlan.skipped.length,
      });
      setPlan(committedPlan);
      setStage('done');
      await Promise.all([reloadPlots(), reloadTrees(), reloadRegens(), refreshBatches()]);
      message.success('离线包逐对象合并完成');
    } catch (err) {
      const reason = err instanceof Error ? err.message : '未知错误';
      setCommitError(`合并写入失败，批次已保留，可在下方批次列表重试：${reason}`);
      await persist('failed', reason);
      setStage('preview');
      await refreshBatches();
    }
  };

  const reset = () => {
    setStage('idle');
    setPkg(null);
    setPlan(null);
    setChoices({});
    setOutcome(null);
    setCommitError('');
    setWarnings([]);
    setFileName('');
  };

  const pendingCount = batches.filter((b) => b.status !== 'imported').length;

  const batchColumns: TableProps<ImportBatch>['columns'] = [
    { title: '文件', dataIndex: 'fileName', ellipsis: true },
    { title: '来源终端', dataIndex: 'device', width: 140 },
    { title: '包导出时间', dataIndex: 'exportedAt', width: 180, render: (v: number) => fmt(v) },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (v: ImportBatch['status'], row) =>
        v === 'imported' ? (
          <Tag icon={<CheckCircleOutlined />} color="success">
            已导入
          </Tag>
        ) : v === 'failed' ? (
          <Tag icon={<WarningOutlined />} color="error">
            失败（可重试）
            {row.error ? <div style={{ fontSize: 12 }}>{row.error}</div> : null}
          </Tag>
        ) : (
          <Tag color="processing">待确认</Tag>
        ),
    },
    {
      title: '操作',
      width: 220,
      render: (_v, row) => (
        <Space size={4}>
          {row.status === 'imported' ? (
            <Button size="small" icon={<FileSearchOutlined />} onClick={() => viewImported(row)}>
              查看结果
            </Button>
          ) : (
            <Button size="small" type="primary" icon={<RedoOutlined />} onClick={() => retryBatch(row)}>
              {row.status === 'failed' ? '重试导入' : '继续导入'}
            </Button>
          )}
          <Popconfirm title="删除该批次？原始包将从本机移除" onConfirm={() => removeBatch(row.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          外业离线包逐对象合并
        </Typography.Title>
        <Tag color="purple">样地按样地号 · 样木按树号+期次 · 样方按层位+种类+期次</Tag>
        <div style={{ flex: 1 }} />
      </Space>

      {stage === 'idle' || stage === 'preview' || stage === 'committing' || stage === 'done' ? (
        <>
          {stage === 'idle' ? (
            <Row gutter={12}>
              <Col span={pendingCount > 0 ? 15 : 24}>
                <Card size="small">
                  <Dragger {...uploadProps} style={{ padding: '12px 8px' }}>
                    <p className="ant-upload-drag-icon">
                      <InboxOutlined />
                    </p>
                    <p className="ant-upload-text">点击或拖拽外业队员带回的离线包（.json）</p>
                    <p className="ant-upload-hint">
                      不会整包覆盖：双边都改过的记录先预览并排比对，按现场补测时间取新；锁定状态与已采伐样木受保护。
                    </p>
                  </Dragger>
                </Card>
              </Col>
              {pendingCount > 0 ? (
                <Col span={9}>
                  <Card size="small" title="待处理 / 失败批次" style={{ height: '100%' }}>
                    <Space direction="vertical">
                      <Statistic title="保留批次" value={pendingCount} suffix="个" />
                      <Typography.Text type="secondary">
                        导入失败的离线包会原样保留，可直接重试，不必找外业队员重发。
                      </Typography.Text>
                    </Space>
                  </Card>
                </Col>
              ) : null}
            </Row>
          ) : null}

          {warnings.length > 0 ? (
            <Alert type="warning" showIcon message="旧版包兼容提示" description={warnings.join('；')} />
          ) : null}
          {commitError ? <Alert type="error" showIcon message={commitError} /> : null}

          {stage !== 'idle' && pkg && plan ? (
            <>
              <Card size="small">
                <Space wrap size={16}>
                  <Statistic title="文件" value={fileName} valueStyle={{ fontSize: 14 }} />
                  <Statistic title="来源" value={pkg.device} valueStyle={{ fontSize: 14 }} />
                  <Statistic title="包导出时间" value={fmt(pkg.exportedAt)} valueStyle={{ fontSize: 14 }} />
                  <Statistic
                    title="样地 / 样木 / 样方"
                    value={`${pkg.plots.length} / ${pkg.trees.length} / ${pkg.regens.length}`}
                    valueStyle={{ fontSize: 14 }}
                  />
                </Space>
              </Card>

              <Row gutter={12}>
                <Col span={4}>
                  <Card size="small">
                    <Statistic
                      title="新增样地"
                      value={summary?.adds.plot ?? 0}
                      suffix="块"
                      valueStyle={{ color: '#1677ff' }}
                    />
                  </Card>
                </Col>
                <Col span={4}>
                  <Card size="small">
                    <Statistic title="新增样木" value={summary?.adds.tree ?? 0} suffix="株" valueStyle={{ color: '#1677ff' }} />
                  </Card>
                </Col>
                <Col span={4}>
                  <Card size="small">
                    <Statistic title="新增样方" value={summary?.adds.regen ?? 0} suffix="条" valueStyle={{ color: '#1677ff' }} />
                  </Card>
                </Col>
                <Col span={4}>
                  <Card size="small">
                    <Statistic
                      title="双边冲突字段"
                      value={summary?.conflictCount ?? 0}
                      suffix="个"
                      valueStyle={{ color: '#fa8c16' }}
                    />
                  </Card>
                </Col>
                <Col span={4}>
                  <Card size="small">
                    <Statistic title="受保护字段" value={summary?.protectedCount ?? 0} suffix="个" valueStyle={{ color: '#cf1322' }} />
                  </Card>
                </Col>
                <Col span={4}>
                  <Card size="small">
                    <Statistic title="跳过记录" value={plan.skipped.length} suffix="条" />
                  </Card>
                </Col>
              </Row>

              {plan.skipped.length > 0 ? (
                <Alert
                  type="warning"
                  showIcon
                  message={`${plan.skipped.length} 条记录无法按样地号定位，已跳过（不影响其他对象合并）`}
                  description={
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {plan.skipped.slice(0, 6).map((s) => (
                        <li key={`${s.kind}:${s.key}`}>
                          {s.kind === 'tree' ? '样木' : '样方'} {s.key}：{s.reason}
                        </li>
                      ))}
                      {plan.skipped.length > 6 ? <li>… 其余 {plan.skipped.length - 6} 条略</li> : null}
                    </ul>
                  }
                />
              ) : null}

              <Card
                size="small"
                title="逐对象合并预览（双边都改过的记录并排列出）"
                extra={
                  stage === 'done' ? (
                    <Tag icon={<CheckCircleOutlined />} color="success">
                      已写入本地档案库
                    </Tag>
                  ) : (
                    <Space>
                      <Button onClick={reset}>取消</Button>
                      <Button
                        type="primary"
                        icon={<CloudUploadOutlined />}
                        loading={stage === 'committing'}
                        onClick={confirmMerge}
                      >
                        确认合并写入
                      </Button>
                    </Space>
                  )
                }
              >
                <MergePreview items={plan.items} choices={choices} onChoiceChange={setChoices} />
              </Card>

              {stage === 'done' && outcome ? (
                <Alert
                  type="success"
                  showIcon
                  message={`合并完成：写入/更新 ${outcome.written} 个对象（样地 +${outcome.adds.plot}、样木 +${outcome.adds.tree}、样方 +${outcome.adds.regen}；更新样地 ${outcome.updates.plot}、样木 ${outcome.updates.tree}、样方 ${outcome.updates.regen}），裁决冲突字段 ${outcome.conflictCount} 个。`}
                  description={
                    <Space direction="vertical" size={2}>
                      <span>复查比对已按合并后的新数据重算；林分汇总（株数、断面积、更新密度等）打开即按新数据计算。</span>
                      {outcome.skipped > 0 ? <span>{outcome.skipped} 条无法定位的记录已跳过。</span> : null}
                      <Button size="small" onClick={reset}>
                        继续导入下一个包
                      </Button>
                    </Space>
                  }
                />
              ) : null}
            </>
          ) : null}

          <Card size="small" title={`导入批次（${batches.length}）`}>
            <Table<ImportBatch>
              rowKey="id"
              size="small"
              columns={batchColumns}
              dataSource={batches}
              pagination={false}
              locale={{ emptyText: <Empty description="还没有导入过离线包" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
            />
          </Card>
        </>
      ) : null}

      <Modal
        open={!!dupBatch}
        title="同一个离线包已导入过"
        onCancel={() => setDupBatch(null)}
        onOk={() => {
          if (dupBatch) viewImported(dupBatch);
          setDupBatch(null);
        }}
        okText="查看当前合并结果"
        cancelText="关闭"
      >
        <Typography.Paragraph>
          文件「{dupBatch?.fileName}」（来源 {dupBatch?.device}）与 {fmt(dupBatch?.createdAt ?? 0)}{' '}
          导入的批次内容指纹一致。
        </Typography.Paragraph>
        <Alert
          type="info"
          showIcon
          message="第二次导入同一包不会增加任何重复记录：所有对象均按样地号 / 树号+期次 / 层位+种类+期次识别后做幂等更新。可查看按当前数据重算的预览。"
        />
      </Modal>
    </Space>
  );
}
