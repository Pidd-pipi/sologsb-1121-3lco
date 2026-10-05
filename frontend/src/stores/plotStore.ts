import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import type { Plot, PlotDraft } from '../types/plot';

interface PlotState {
  items: Plot[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: PlotDraft) => Promise<Plot>;
  update: (id: string, patch: Partial<Plot>) => Promise<void>;
  toggleLock: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

const FIELD_KEYS = new Set([
  'locality',
  'lng',
  'lat',
  'shape',
  'area',
  'elevation',
  'slope',
  'aspect',
  'forestType',
  'canopyDensity',
  'dominantSpecies',
  'surveyRound',
  'surveyedAt',
  'crew',
  'locked',
]);

function stampFields(patch: Partial<Plot>, when: number): { patch: Partial<Plot>; fieldTimes: Plot['fieldTimes'] } {
  const fieldTimes: Plot['fieldTimes'] = {};
  Object.keys(patch).forEach((k) => {
    if (FIELD_KEYS.has(k)) fieldTimes[k] = when;
  });
  return { patch, fieldTimes };
}

export const usePlotStore = create<PlotState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const rows = await db.plots.orderBy('createdAt').reverse().toArray();
    set({ items: rows, loaded: true });
  },
  async add(draft) {
    const now = Date.now();
    const { fieldTimes } = stampFields(draft, now);
    const record: Plot = { ...draft, id: newId('plot'), createdAt: now, updatedAt: now, fieldTimes };
    await db.plots.put(record);
    set({ items: [record, ...get().items] });
    return record;
  },
  async update(id, patch) {
    const target = get().items.find((it) => it.id === id);
    const now = Date.now();
    const { fieldTimes: stamps } = stampFields(patch, now);
    const nextPatch: Partial<Plot> = {
      ...patch,
      updatedAt: now,
      fieldTimes: { ...(target?.fieldTimes ?? {}), ...stamps },
    };
    await db.plots.update(id, nextPatch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...nextPatch } : it)) });
  },
  async toggleLock(id) {
    const target = get().items.find((it) => it.id === id);
    if (!target) return;
    await get().update(id, { locked: !target.locked });
  },
  async remove(id) {
    await db.plots.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
  },
}));
