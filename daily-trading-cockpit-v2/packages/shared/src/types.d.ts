export type Direction = "LONG" | "SHORT" | "NEUTRAL";
export type FinalStatus = "TRADE_NOW" | "READY" | "WAIT" | "WATCH" | "SKIP";
export type TrendLabel = "BULLISH" | "BEARISH" | "SIDEWAYS";
export type ExternalSignalLabel = "BULLISH" | "BEARISH" | "NEUTRAL" | "UNAVAILABLE";
export type SocialScope = "MARKET" | "SYMBOL";
export interface Candle {
    openTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}
export interface MacdSnapshot {
    macd: number;
    signal: number;
    histogram: number;
}
export interface BollingerBands {
    upper: number;
    middle: number;
    lower: number;
}
export interface TimeframeIndicatorSnapshot {
    timeframe: "5m" | "15m" | "1h";
    latestClose: number;
    ema20: number;
    ema50: number;
    ema200: number;
    sma20: number;
    rsi14: number;
    macd: MacdSnapshot;
    bollingerBands20: BollingerBands;
    atr14: number;
    atrPercent: number;
    vwap: number;
    volumeRatio: number | null;
    bodyWickRatio: number;
    support: number;
    resistance: number;
    recentSwingHigh: number;
    recentSwingLow: number;
    distanceFromEma20: number;
    distanceFromVwap: number;
    breakoutHigh: boolean;
    breakoutLow: boolean;
    trend: TrendLabel;
    isFresh: boolean;
    lastOpenTime: number;
}
export interface FibonacciLevels {
    recentHigh: number;
    recentLow: number;
    retracement236: number;
    retracement382: number;
    retracement500: number;
    retracement618: number;
    retracement786: number;
    extension1272: number;
    extension1618: number;
}
export interface AtrPlan {
    atr14: number;
    atrPercent: number;
    entryZoneLow: number | null;
    entryZoneHigh: number | null;
    stopLoss: number | null;
    takeProfit1: number | null;
    takeProfit2: number | null;
    takeProfit3: number | null;
    riskReward: number | null;
}
export interface IndicatorSet {
    fiveMinute: TimeframeIndicatorSnapshot;
    fifteenMinute: TimeframeIndicatorSnapshot;
    oneHour: TimeframeIndicatorSnapshot;
    fibonacci: FibonacciLevels;
    atr: AtrPlan;
}
export interface KronosPrediction {
    available: boolean;
    reason?: string;
    kronosLongProbability?: number;
    kronosShortProbability?: number;
    kronosBias?: Direction;
    expectedReturn3?: number;
    expectedReturn6?: number;
    expectedVolatility?: number;
    kronosConfidence?: number;
    kronosRisk?: number;
}
export interface WhaleSignal {
    available: boolean;
    signal: ExternalSignalLabel;
    score: number;
    reason?: string;
}
export interface SentimentSignal {
    available: boolean;
    signal: ExternalSignalLabel;
    score: number;
    confidence?: number;
    scope?: SocialScope;
    source?: string;
    reason?: string;
}
export interface VolumeSnapshot {
    quoteVolume24h: number | null;
    baseVolume24h: number | null;
    volumeRatio5m: number | null;
}
export interface SpreadSnapshot {
    bid: number | null;
    ask: number | null;
    absolute: number | null;
    percent: number | null;
}
export interface ChartPoint {
    time: number;
    value: number;
}
export interface Candidate {
    rank: number;
    symbol: string;
    direction: Direction;
    status: FinalStatus;
    longScore: number;
    shortScore: number;
    opportunityScore: number;
    dangerScore: number;
    confidence: number;
    dataQualityScore: number;
    liquidityScore: number;
    volatilityScore: number;
    trendScore: number;
    volumeScore: number;
    kronosScore: number;
    finalDirection: Direction;
    finalStatus: FinalStatus;
    sourceConflict: boolean;
    kronosBias: Direction | "UNAVAILABLE";
    kronosConfidence: number | null;
    expectedReturn3: number | null;
    expectedReturn6: number | null;
    indicators: IndicatorSet;
    fibonacci: FibonacciLevels;
    atr: AtrPlan;
    volume: VolumeSnapshot;
    spread: SpreadSnapshot;
    whale: WhaleSignal;
    sentiment: SentimentSignal;
    entryZone: [number, number] | null;
    stopLoss: number | null;
    takeProfits: {
        tp1: number | null;
        tp2: number | null;
        tp3: number | null;
    };
    riskReward: number | null;
    reason: string[];
    blockers: string[];
    chart: ChartPoint[];
}
export interface CoverageSnapshot {
    totalSymbols: number;
    scannedSymbols: number;
    returnedSymbols: number;
    skippedSymbols: number;
    percent: number;
    liveSymbols?: number;
    cacheFreshSymbols?: number;
}
export interface CapabilitySnapshot {
    configured?: boolean;
    available: boolean;
    provider?: string;
    message: string;
}
export interface SymbolFailure {
    symbol: string;
    stage: string;
    failureType: "timeout" | "429" | "network" | "invalid_response" | "unsupported";
    reason: string;
}
export interface ScanDiagnostics {
    universe: string[];
    skippedSymbols: string[];
    symbolFailures: SymbolFailure[];
    hiddenSkips: Candidate[];
    kronos: CapabilitySnapshot;
    whale: CapabilitySnapshot;
    sentiment: CapabilitySnapshot;
}
export interface ScanResult {
    generatedAt: string;
    coverage: CoverageSnapshot;
    marketRegime: string;
    top10: Candidate[];
    diagnostics: ScanDiagnostics;
}
