import { useMemo, useState } from 'react';
import { Alert, Badge, Radio, Segmented, Space, Table, Tag, Typography, type TableProps } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import type { Plot } from '../../types/plot';
import type { TreeRecord } from '../../types/tree';
import type { RegenShrub } from '../../types/regen';
import {
  PLOT_MERGE_FIELDS,
  TREE_MERGE_FIELDS,
  REGEN_MERGE_FIELDS,
  type ChoiceMap,
  type FieldConflict,
  type MergeItem,
  type MergeSide,
} from '../../utils/merge';

export interface MergePreviewProps {
  items: MergeItem[];
  /** 预览中逐字段选择（受控） */
  choices: ChoiceMap;
  onChoiceChange: (next: ChoiceMap) => void;
}

type FilterKey = 'conflict' | 'update' | 'add' | 'all';

function formatValue(field: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (field === 'surveyedAt') return new Date(Number(value)).toLocaleString('zh-CN');
  if (field === 'locked') return value ? '已锁定' : '未锁定';
  return String(value);
}

function formatAt(t: number): string {
  return t > 0 ? new Date(t).toLocaleString('zh-CN') : '无补测时间';
}

const KIND_LABEL: Record<MergeItem['kind'], string> = {
  plot: '样地档案',
  tree: '样木',
  regen: '样方',
};

const KIND_COLOR: Record<MergeItem['kind'], string> = {
  plot: 'purple',
  tree: 'green',
  regen: 'cyan',
};

interface RowModel {
  key: string;
  item: MergeItem;
}

/** 逐对象合并预览：冲突记录并排列出本库/离线包字段值，同字段按现场补测时间标新值 */
export default function MergePreview({ items, choices, onChoiceChange }: MergePreviewProps) {
  const [filter, setFilter] = useState<FilterKey>('conflict');

  const filtered = useMemo(() => {
    if (filter === 'all') return items;
    if (filter === 'add') return items.filter((i) => i.action === 'add');
    if (filter === 'update') return items.filter((i) => i.action === 'update');
    return items.filter((i) => i.conflicts.length > 0);
  }, [items, filter]);

  const conflictCount = items.reduce((s, i) => s + i.conflicts.length, 0);
  const addCount = items.filter((i) => i.action === 'add').length;

  const setWinner = (item: MergeItem, conflict: FieldConflict, winner: MergeSide) => {
    onChoiceChange({ ...choices, [`${item.kind}:${item.key}:${conflict.field}`]: winner });
  };

  const expandedRender = (item: MergeItem) => {
    if (item.action === 'add') {
      const fields =
        item.kind === 'plot'
          ? PLOT_MERGE_FIELDS
          : item.kind === 'tree'
            ? TREE_MERGE_FIELDS
            : REGEN_MERGE_FIELDS;
      const incoming = item.incoming as unknown as Record<string, unknown>;
      return (
        <Table
          size="small"
          rowKey="field"
          pagination={false}
          dataSource={fields}
          columns={[
            { title: '字段', dataIndex: 'label', width: 130 },
            { title: '离线包取值', render: (_v, row) => formatValue(row.field, incoming[row.field]) },
          ]}
        />
      );
    }
    if (item.conflicts.length === 0) {
      return (
        <Typography.Text type="success">
          两边内容一致{item.filledFields.length > 0 ? `，已补齐字段：${item.filledFields.join('、')}` : ''}，直接覆盖不丢数据。
        </Typography.Text>
      );
    }
    const columns: TableProps<FieldConflict>['columns'] = [
      { title: '字段', dataIndex: 'label', width: 110 },
      {
        title: '本库现值',
        render: (_v, c) => (
          <div>
            <span>{formatValue(c.field, c.local)}</span>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatAt(c.localAt)}
              </Typography.Text>
            </div>
          </div>
        ),
      },
      {
        title: '离线包取值',
        render: (_v, c) => (
          <div>
            <span>{formatValue(c.field, c.incoming)}</span>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatAt(c.incomingAt)}
              </Typography.Text>
            </div>
          </div>
        ),
      },
      {
        title: '采用',
        width: 230,
        render: (_v, c) =>
          c.protected ? (
            <Tag icon={<LockOutlined />} color="red">
              保护：保留本库
              <div style={{ fontSize: 12 }}>{c.protectedReason}</div>
            </Tag>
          ) : (
            <Radio.Group
              size="small"
              value={c.winner}
              onChange={(e) => setWinner(item, c, e.target.value as MergeSide)}
            >
              <Radio.Button value="local">本库</Radio.Button>
              <Radio.Button value="incoming">离线包</Radio.Button>
            </Radio.Group>
          ),
      },
    ];
    return (
      <Space direction="vertical" style={{ width: '100%' }} size={4}>
        {item.filledFields.length > 0 ? (
          <Typography.Text type="secondary">自动补齐字段：{item.filledFields.join('、')}</Typography.Text>
        ) : null}
        <Table<FieldConflict>
          size="small"
          rowKey="field"
          pagination={false}
          dataSource={item.conflicts}
          columns={columns}
        />
      </Space>
    );
  };

  const rows: RowModel[] = filtered.map((item) => ({ key: `${item.kind}:${item.key}`, item }));

  const columns: TableProps<RowModel>['columns'] = [
    {
      title: '对象',
      width: 90,
      render: (_v, row) => <Tag color={KIND_COLOR[row.item.kind]}>{KIND_LABEL[row.item.kind]}</Tag>,
    },
    { title: '识别键 / 标题', render: (_v, row) => row.item.title },
    {
      title: '动作',
      width: 120,
      render: (_v, row) =>
        row.item.action === 'add' ? (
          <Tag color="blue">新增入库</Tag>
        ) : (
          <Tag color="default">逐字段合并</Tag>
        ),
    },
    {
      title: '双边冲突',
      width: 220,
      render: (_v, row) => {
        const n = row.item.conflicts.length;
        if (n === 0) {
          return row.item.filledFields.length > 0 ? (
            <Tag color="orange">补齐 {row.item.filledFields.length} 项</Tag>
          ) : (
            <Tag color="green">无冲突</Tag>
          );
        }
        const protectedN = row.item.conflicts.filter((c) => c.protected).length;
        return (
          <span>
            <Badge count={`${n} 字段`} style={{ backgroundColor: '#fa8c16' }} />
            {protectedN > 0 ? (
              <Tag icon={<LockOutlined />} color="red" style={{ marginLeft: 8 }}>
                {protectedN} 项受保护
              </Tag>
            ) : null}
          </span>
        );
      },
    },
  ];

  if (items.length === 0) {
    return <Alert type="info" showIcon message="包内对象均已存在且内容一致：无需写入，重复导入不会增加记录。" />;
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={8}>
      <Space wrap>
        <Segmented
          value={filter}
          onChange={(v) => setFilter(v as FilterKey)}
          options={[
            { value: 'conflict', label: `双边冲突 (${conflictCount} 字段)` },
            { value: 'update', label: '已有对象' },
            { value: 'add', label: `新增对象 (${addCount})` },
            { value: 'all', label: `全部 (${items.length})` },
          ]}
        />
      </Space>
      <Table<RowModel>
        size="small"
        rowKey="key"
        columns={columns}
        dataSource={rows}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        expandable={{
          expandedRowRender: (row) => expandedRender(row.item),
          rowExpandable: (row) => row.item.action === 'add' || row.item.conflicts.length > 0 || row.item.filledFields.length > 0,
        }}
      />
    </Space>
  );
}

