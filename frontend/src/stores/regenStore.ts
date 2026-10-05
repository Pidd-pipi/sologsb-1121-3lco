import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import type { RegenShrub, RegenShrubDraft } from '../types/regen';

interface RegenState {
  items: RegenShrub[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: RegenShrubDraft) => Promise<RegenShrub>;
  update: (id: string, patch: Partial<RegenShrub>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  byPlot: (plotId: string, round?: number) => RegenShrub[];
}

const FIELD_KEYS = new Set(['heightCm', 'count', 'ageGroup', 'distribution', 'browseDamage']);

function stampFields(patch: Partial<RegenShrub>, when: number): RegenShrub['fieldTimes'] {
  const fieldTimes: RegenShrub['fieldTimes'] = {};
  Object.keys(patch).forEach((k) => {
    if (FIELD_KEYS.has(k)) fieldTimes[k] = when;
  });
  return fieldTimes;
}

export const useRegenStore = create<RegenState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const rows = await db.regens.toArray();
    rows.sort((a, b) => a.round - b.round || a.layer.localeCompare(b.layer));
    set({ items: rows, loaded: true });
  },
  async add(draft) {
    const now = Date.now();
    const record: RegenShrub = { ...draft, id: newId('regen'), updatedAt: now, fieldTimes: stampFields(draft, now) };
    await db.regens.put(record);
    set({ items: [...get().items, record] });
    return record;
  },
  async update(id, patch) {
    const target = get().items.find((it) => it.id === id);
    const now = Date.now();
    const nextPatch: Partial<RegenShrub> = {
      ...patch,
      updatedAt: now,
      fieldTimes: { ...(target?.fieldTimes ?? {}), ...stampFields(patch, now) },
    };
    await db.regens.update(id, nextPatch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...nextPatch } : it)) });
  },
  async remove(id) {
    await db.regens.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
  },
  byPlot(plotId, round) {
    return get().items.filter((it) => it.plotId === plotId && (round === undefined || it.round === round));
  },
}));
