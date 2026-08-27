/**
 * Daily Range path observation is deliberately separate from execution.
 *
 * Native Daily brackets use CONTRACT_PRICE. This supervisor observes Binance
 * USD-M aggregated contract trades and forwards them to the lane only for
 * MFE/MAE attribution. It has no order methods, no stop/TP authority, and no
 * route or allocation authority. A disconnect makes later observations
 * incomplete rather than fabricating an exact path.
 */

export type DailyRangeContractPathSource = "CONTRACT_AGG_TRADE" | "EXIT_FILL" | "RECOVERED_1M" | "RECONCILE_MARK";
export type DailyRangePathQuality = "EXACT_STREAM" | "RECOVERED_FINE_DATA" | "APPROX_1M" | "INCOMPLETE";

export interface DailyRangeContractPathEvent {
  symbol: string;
  price: number;
  eventTimeMs: number;
  receivedAtMs: number;
  source: DailyRangeContractPathSource;
  /**
   * The current stream connection began at this time. A trade filled before
   * this value may have an unobserved gap and must not be labelled exact.
   */
  streamStartedAtMs: number | null;
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function parseDailyRangeContractAggTrade(
  value: unknown,
  receivedAtMs: number,
  streamStartedAtMs: number | null,
): DailyRangeContractPathEvent | null {
  if (!value || typeof value !== "object") return null;
  const envelope = value as { data?: unknown };
  const data = envelope.data && typeof envelope.data === "object" ? envelope.data as Record<string, unknown> : value as Record<string, unknown>;
  const symbol = typeof data.s === "string" ? data.s.trim().toUpperCase() : "";
  const price = Number(data.p);
  const eventTimeMs = Number(data.T ?? data.E);
  if (!symbol || !finitePositive(price) || !finiteTime(eventTimeMs) || !finiteTime(receivedAtMs)) return null;
  return {
    symbol,
    price,
    eventTimeMs,
    receivedAtMs,
    source: "CONTRACT_AGG_TRADE",
    streamStartedAtMs,
  };
}

function websocketBase(environment: "testnet" | "mainnet"): string {
  return environment === "mainnet"
    ? "wss://fstream.binance.com/stream?streams="
    : "wss://stream.binancefuture.com/stream?streams=";
}

export interface DailyRangeContractPathSupervisorOptions {
  environment: "testnet" | "mainnet";
  onEvent: (event: DailyRangeContractPathEvent) => void;
  /** A live-stream interruption downgrades open-trade path quality; it has no execution authority. */
  onStreamInterrupted?: (reason: string) => void;
  nowMs?: () => number;
  logger?: (event: string, fields: Record<string, unknown>) => void;
}

/**
 * One bounded combined stream for the Daily C1-C6 universe. The set is
 * refreshed by the app scheduler. It reconnects only when membership changes
 * or after a disconnected state; it never retries orders and never blocks the
 * lane tick.
 */
export class DailyRangeContractPathSupervisor {
  private readonly environment: "testnet" | "mainnet";
  private readonly onEvent: (event: DailyRangeContractPathEvent) => void;
  private readonly onStreamInterrupted: (reason: string) => void;
  private readonly nowMs: () => number;
  private readonly logger: (event: string, fields: Record<string, unknown>) => void;
  private socket: WebSocket | null = null;
  private symbolKey: string | null = null;
  private streamStartedAtMs: number | null = null;

  constructor(opts: DailyRangeContractPathSupervisorOptions) {
    this.environment = opts.environment;
    this.onEvent = opts.onEvent;
    this.onStreamInterrupted = opts.onStreamInterrupted ?? (() => {});
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.logger = opts.logger ?? (() => {});
  }

  refresh(symbols: readonly string[]): void {
    const normalized = [...new Set(symbols
      .map((symbol) => symbol.trim().toUpperCase())
      .filter((symbol) => /^[A-Z0-9]+USDT$/.test(symbol)))]
      .sort();
    const nextKey = normalized.join(",");
    if (nextKey === this.symbolKey && this.socket !== null) return;
    this.disconnect("subscription set changed");
    if (normalized.length === 0) return;
    if (typeof WebSocket === "undefined") {
      this.logger("DAILY_RANGE_PATH_STREAM_UNAVAILABLE", { reason: "global WebSocket is unavailable" });
      this.symbolKey = nextKey;
      return;
    }
    const streams = normalized.map((symbol) => symbol.toLowerCase() + "@aggTrade").join("/");
    const url = websocketBase(this.environment) + streams;
    this.symbolKey = nextKey;
    try {
      const socket = new WebSocket(url);
      this.socket = socket;
      socket.onopen = () => {
        if (this.socket !== socket) return;
        this.streamStartedAtMs = this.nowMs();
        this.logger("DAILY_RANGE_PATH_STREAM_OPEN", { environment: this.environment, symbols: normalized.length });
      };
      socket.onmessage = (message: { data: unknown }) => {
        if (this.socket !== socket) return;
        const receivedAtMs = this.nowMs();
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(message.data));
        } catch {
          return;
        }
        const event = parseDailyRangeContractAggTrade(parsed, receivedAtMs, this.streamStartedAtMs);
        if (event) this.onEvent(event);
      };
      socket.onerror = () => {
        if (this.socket !== socket) return;
        this.logger("DAILY_RANGE_PATH_STREAM_ERROR", { environment: this.environment });
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        const hadLiveStream = this.streamStartedAtMs !== null;
        this.socket = null;
        this.streamStartedAtMs = null;
        this.symbolKey = null;
        if (hadLiveStream) this.onStreamInterrupted("contract-price websocket closed");
        this.logger("DAILY_RANGE_PATH_STREAM_CLOSED", { environment: this.environment });
      };
    } catch (error) {
      this.socket = null;
      this.streamStartedAtMs = null;
      this.symbolKey = null;
      this.logger("DAILY_RANGE_PATH_STREAM_CONNECT_FAILED", {
        environment: this.environment,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  disconnect(reason = "contract-price websocket stopped"): void {
    const socket = this.socket;
    const hadLiveStream = this.streamStartedAtMs !== null;
    this.socket = null;
    this.streamStartedAtMs = null;
    this.symbolKey = null;
    if (!socket) return;
    if (hadLiveStream) this.onStreamInterrupted(reason);
    try {
      socket.close();
    } catch {
      // The stream is observational. A later refresh can reconnect.
    }
  }

  getStatus(): { subscribedSymbols: number; connected: boolean; streamStartedAtMs: number | null } {
    return {
      subscribedSymbols: this.symbolKey ? this.symbolKey.split(",").filter(Boolean).length : 0,
      connected: this.socket !== null && this.streamStartedAtMs !== null,
      streamStartedAtMs: this.streamStartedAtMs,
    };
  }
}
