import type { Candidate, Candle, Direction, IndicatorSet, KronosPrediction, SentimentSignal, SpreadSnapshot, VolumeSnapshot, WhaleSignal } from "./types.js";
export interface CandidateBuildInput {
    symbol: string;
    candles5m: Candle[];
    candles15m: Candle[];
    candles1h: Candle[];
    spread: SpreadSnapshot;
    volume: VolumeSnapshot;
    kronos: KronosPrediction;
    whale: WhaleSignal;
    sentiment: SentimentSignal;
    now?: number;
}
export declare function chooseDirection(longScore: number, shortScore: number): Direction;
export declare function calculateDangerScore(args: {
    direction: Direction;
    indicators: IndicatorSet;
    spread: SpreadSnapshot;
    volume: VolumeSnapshot;
    riskReward: number | null;
    whale: WhaleSignal;
    sentiment: SentimentSignal;
    oneHourTrendConflict: boolean;
}): number;
export declare function classifyStatus(args: {
    dataFresh: boolean;
    spreadAcceptable: boolean;
    direction: Direction;
    opportunityScore: number;
    confidence: number;
    dangerScore: number;
    riskReward: number | null;
    hasTradePlan: boolean;
    kronosAgrees: boolean;
    liquidityScore: number;
}): Candidate["status"];
export declare function buildCandidate(input: CandidateBuildInput): Candidate;
