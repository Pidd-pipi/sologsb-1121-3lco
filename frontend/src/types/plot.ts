import type { FieldTimes } from './common';

/** 样地形状 */
export type PlotShape = '方形' | '圆形';

export const PLOT_SHAPES: PlotShape[] = ['方形', '圆形'];

export const FOREST_TYPES = ['针叶林', '阔叶林', '针阔混交林', '灌木林', '竹林'];

/** 固定样地 */
export interface Plot {
  id: string;
  /** 样地号 */
  plotNo: string;
  locality: string;
  lng: number;
  lat: number;
  shape: PlotShape;
  /** 面积 m² */
  area: number;
  /** 海拔 m */
  elevation: number;
  /** 坡度 ° */
  slope: number;
  /** 坡向 */
  aspect: string;
  forestType: string;
  /** 郁闭度 0-1 */
  canopyDensity: number;
  dominantSpecies: string;
  /** 复查期次 */
  surveyRound: number;
  surveyedAt: number;
  /** 调查组 */
  crew: string;
  /** 往期数据是否锁定 */
  locked: boolean;
  createdAt: number;
  /** 档案最后修改时间（v3 补，旧数据迁移为 surveyedAt） */
  updatedAt?: number;
  /** 各字段现场补测/修改时间，离线合并时同字段按此时序取新 */
  fieldTimes?: FieldTimes;
}

export type PlotDraft = Omit<Plot, 'id' | 'createdAt'>;
