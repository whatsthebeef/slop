import type { SizeCheck } from '../../domain/size-check.js';
import type { SizeForecast } from '../../domain/size-forecast.js';

export interface SizeContext {
  readonly oversized: boolean;
  /** The board's fan-out floor: fan out only when at least this many workstreams can be built at the same time. */
  readonly minParallel: number;
  readonly reasons: readonly string[];
  readonly evidence: readonly string[];
  /** `split` once the glob's scope was cut into independent globs; null otherwise. */
  readonly decision: SizeCheck['decision'];
  /** Workstreams the run can work in parallel inside this glob's one PR (name, goal, files, plan share, `needs` as earlier indexes). */
  readonly proposal: SizeCheck['proposal'];
  /** Present once the code forecast was made: predicted files and parts; confirm or correct. */
  readonly forecast?: SizeForecastContext;
}

/** The forecast as the investigator receives it: its starting point, to confirm or correct in the investigation. */
export interface SizeForecastContext {
  readonly note: string;
  readonly files: readonly string[];
  readonly modules: readonly string[];
  readonly parts: SizeForecast['parts'];
  readonly expectedLines: SizeForecast['lines'];
  readonly riskTier: SizeForecast['riskTier'];
  readonly riskAreas: readonly string[];
  readonly migration: boolean;
  readonly publicApi: boolean;
  readonly confidence: SizeForecast['confidence'];
  readonly history: string | null;
}

export const FORECAST_NOTE = 'predicted files and parts; confirm or correct';


export const sizeContext = (check: SizeCheck, minParallel: number): SizeContext => ({
  oversized: check.flagged,
  minParallel,
  reasons: check.reasons,
  evidence: check.evidence,
  decision: check.decision,
  proposal: check.proposal,
  ...(check.estimate.forecast === undefined ? {} : { forecast: forecastContext(check.estimate.forecast) }),
});

export const forecastContext = (f: SizeForecast): SizeForecastContext => ({
  note: FORECAST_NOTE,
  files: f.files.paths,
  modules: f.modules,
  parts: f.parts,
  expectedLines: f.lines,
  riskTier: f.riskTier,
  riskAreas: f.riskAreas,
  migration: f.migration,
  publicApi: f.publicApi,
  confidence: f.confidence,
  history: f.reference?.summary ?? null,
});
