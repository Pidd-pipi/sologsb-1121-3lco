import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import type { TreeRecord, TreeRecordDraft } from '../types/tree';

interface TreeState {
  items: TreeRecord[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: TreeRecordDraft) => Promise<TreeRecord>;
  addMany: (drafts: TreeRecordDraft[]) => Promise<TreeRecord[]>;
  update: (id: string, patch: Partial<TreeRecord>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  byPlot: (plotId: string, round?: number) => TreeRecord[];
}

const FIELD_KEYS = new Set([
  'species',
  'dbhCm',
  'heightM',
  'underBranchH',
  'crownWidth',
  'status',
  'origin',
  'healthClass',
  'tiltDeg',
  'remark',
]);

function stampFields(patch: Partial<TreeRecord>, when: number): TreeRecord['fieldTimes'] {
  const fieldTimes: TreeRecord['fieldTimes'] = {};
  Object.keys(patch).forEach((k) => {
    if (FIELD_KEYS.has(k)) fieldTimes[k] = when;
  });
  return fieldTimes;
}

export const useTreeStore = create<TreeState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const rows = await db.trees.toArray();
    rows.sort((a, b) => a.round - b.round || a.treeNo.localeCompare(b.treeNo));
    set({ items: rows, loaded: true });
  },
  async add(draft) {
    const now = Date.now();
    const record: TreeRecord = { ...draft, id: newId('tree'), measuredAt: now, fieldTimes: stampFields(draft, now) };
    await db.trees.put(record);
    set({ items: [...get().items, record] });
    return record;
  },
  async addMany(drafts) {
    const now = Date.now();
    const records: TreeRecord[] = drafts.map((d) => ({
      ...d,
      id: newId('tree'),
      measuredAt: now,
      fieldTimes: stampFields(d, now),
    }));
    await db.trees.bulkPut(records);
    set({ items: [...get().items, ...records] });
    return records;
  },
  async update(id, patch) {
    const target = get().items.find((it) => it.id === id);
    const now = Date.now();
    const nextPatch: Partial<TreeRecord> = {
      ...patch,
      measuredAt: Math.max(target?.measuredAt ?? 0, now),
      fieldTimes: { ...(target?.fieldTimes ?? {}), ...stampFields(patch, now) },
    };
    await db.trees.update(id, nextPatch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...nextPatch } : it)) });
  },
  async remove(id) {
    await db.trees.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
  },
  byPlot(plotId, round) {
    return get()
      .items.filter((it) => it.plotId === plotId && (round === undefined || it.round === round))
      .sort((a, b) => a.treeNo.localeCompare(b.treeNo, 'zh-Hans-CN', { numeric: true }));
  },
}));
