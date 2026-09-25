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

function websocketEndpoint(environment: "testnet" | "mainnet"): string {
  return environment === "mainnet"
    // Binance USD-M routed `aggTrade` to the regular market-data endpoint.
    // An unrouted `/ws` socket still acknowledges SUBSCRIBE but does not emit
    // this stream, which silently leaves every giveback trail degraded.
    ? "wss://fstream.binance.com/market/ws"
    : "wss://stream.binancefuture.com/ws";
}

type DailyRangeContractPathSubscriptionMethod = "SUBSCRIBE" | "UNSUBSCRIBE";

interface DailyRangeContractPathSubscriptionRequest {
  method: DailyRangeContractPathSubscriptionMethod;
  symbols: string[];
}

export interface DailyRangeContractPathSupervisorOptions {
  environment: "testnet" | "mainnet";
  onEvent: (event: DailyRangeContractPathEvent) => void;
  /** A live-stream interruption downgrades open-trade path quality; it has no execution authority. */
  onStreamInterrupted?: (reason: string) => void;
  nowMs?: () => number;
  logger?: (event: string, fields: Record<string, unknown>) => void;
  /** Test-only seam; production uses the platform WebSocket implementation. */
  createWebSocket?: (url: string) => WebSocket;
}

/**
 * One bounded dynamic-subscription stream for the Daily C1-C6 universe. Pool
 * membership may rotate on every scheduler pass, so it uses Binance's live
 * SUBSCRIBE/UNSUBSCRIBE controls on the existing socket. A physical reconnect
 * remains a real path gap; a harmless pool rotation is not one. This never
 * retries orders and never blocks the lane tick.
 */
export class DailyRangeContractPathSupervisor {
  private readonly environment: "testnet" | "mainnet";
  private readonly onEvent: (event: DailyRangeContractPathEvent) => void;
  private readonly onStreamInterrupted: (reason: string) => void;
  private readonly nowMs: () => number;
  private readonly logger: (event: string, fields: Record<string, unknown>) => void;
  private readonly createWebSocket: ((url: string) => WebSocket) | null;
  private socket: WebSocket | null = null;
  private streamStartedAtMs: number | null = null;
  /** Desired dynamic subscription set. Active trades are always included by the caller. */
  private desiredSymbols = new Set<string>();
  /** Exchange-acknowledged aggTrade streams on the current physical socket. */
  private subscribedSymbols = new Set<string>();
  /** Per-symbol coverage start; never reset merely because another symbol changes membership. */
  private symbolStreamStartedAtMs = new Map<string, number>();
  private pendingRequests = new Map<number, DailyRangeContractPathSubscriptionRequest>();
  private nextRequestId = 1;

  constructor(opts: DailyRangeContractPathSupervisorOptions) {
    this.environment = opts.environment;
    this.onEvent = opts.onEvent;
    this.onStreamInterrupted = opts.onStreamInterrupted ?? (() => {});
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.logger = opts.logger ?? (() => {});
    this.createWebSocket = opts.createWebSocket
      ?? (typeof WebSocket === "undefined" ? null : (url: string) => new WebSocket(url));
  }

  refresh(symbols: readonly string[]): void {
    const normalized = [...new Set(symbols
      .map((symbol) => symbol.trim().toUpperCase())
      .filter((symbol) => /^[A-Z0-9]+USDT$/.test(symbol)))]
      .sort();
    this.desiredSymbols = new Set(normalized);
    if (normalized.length === 0) {
      this.disconnect("subscription set cleared");
      return;
    }
    if (this.socket === null) {
      this.connect();
      return;
    }
    // Membership churn in the auto-pool is normal. Do not close a healthy
    // socket: a physical reconnect would fabricate a path gap for every
    // already-open FADE and permanently disable its causal giveback trail.
    if (this.streamStartedAtMs !== null) this.syncSubscriptions(this.socket);
  }

  private connect(): void {
    if (this.desiredSymbols.size === 0 || this.socket !== null) return;
    if (!this.createWebSocket) {
      this.logger("DAILY_RANGE_PATH_STREAM_UNAVAILABLE", { reason: "global WebSocket is unavailable" });
      return;
    }
    try {
      const socket = this.createWebSocket(websocketEndpoint(this.environment));
      this.socket = socket;
      socket.onopen = () => {
        if (this.socket !== socket) return;
        this.streamStartedAtMs = this.nowMs();
        this.syncSubscriptions(socket);
        this.logger("DAILY_RANGE_PATH_STREAM_OPEN", { environment: this.environment, symbols: this.desiredSymbols.size });
      };
      socket.onmessage = (message: { data: unknown }) => {
        if (this.socket !== socket) return;
        const receivedAtMs = this.nowMs();
        let payload: unknown;
        try {
          payload = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (this.handleSubscriptionResponse(socket, payload)) return;
        const event = parseDailyRangeContractAggTrade(payload, receivedAtMs, null);
        if (event) {
          this.onEvent({
            ...event,
            streamStartedAtMs: this.symbolStreamStartedAtMs.get(event.symbol) ?? null,
          });
        }
      };
      socket.onerror = () => {
        if (this.socket !== socket) return;
        this.logger("DAILY_RANGE_PATH_STREAM_ERROR", { environment: this.environment });
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        const hadLiveStream = this.streamStartedAtMs !== null;
        this.clearSocketState();
        if (hadLiveStream) this.onStreamInterrupted("contract-price websocket closed");
        this.logger("DAILY_RANGE_PATH_STREAM_CLOSED", { environment: this.environment });
      };
    } catch (error) {
      this.clearSocketState();
      this.logger("DAILY_RANGE_PATH_STREAM_CONNECT_FAILED", {
        environment: this.environment,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private syncSubscriptions(socket: WebSocket): void {
    if (this.socket !== socket || this.streamStartedAtMs === null) return;
    const pendingSubscribe = new Set<string>();
    const pendingUnsubscribe = new Set<string>();
    for (const request of this.pendingRequests.values()) {
      const target = request.method === "SUBSCRIBE" ? pendingSubscribe : pendingUnsubscribe;
      for (const symbol of request.symbols) target.add(symbol);
    }
    const toSubscribe = [...this.desiredSymbols]
      .filter((symbol) => !this.subscribedSymbols.has(symbol) && !pendingSubscribe.has(symbol));
    const toUnsubscribe = [...this.subscribedSymbols]
      .filter((symbol) => !this.desiredSymbols.has(symbol) && !pendingUnsubscribe.has(symbol));
    this.sendSubscriptionRequest(socket, "SUBSCRIBE", toSubscribe);
    this.sendSubscriptionRequest(socket, "UNSUBSCRIBE", toUnsubscribe);
  }

  private sendSubscriptionRequest(
    socket: WebSocket,
    method: DailyRangeContractPathSubscriptionMethod,
    symbols: readonly string[],
  ): void {
    if (symbols.length === 0 || this.socket !== socket) return;
    const id = this.nextRequestId++;
    const request: DailyRangeContractPathSubscriptionRequest = { method, symbols: [...symbols] };
    this.pendingRequests.set(id, request);
    try {
      socket.send(JSON.stringify({
        method,
        params: request.symbols.map((symbol) => `${symbol.toLowerCase()}@aggTrade`),
        id,
      }));
    } catch (error) {
      this.pendingRequests.delete(id);
      this.logger("DAILY_RANGE_PATH_STREAM_SUBSCRIPTION_SEND_FAILED", {
        environment: this.environment,
        method,
        symbols: request.symbols.length,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private handleSubscriptionResponse(socket: WebSocket, payload: unknown): boolean {
    if (!payload || typeof payload !== "object") return false;
    const record = payload as Record<string, unknown>;
    const id = Number(record.id);
    if (!Number.isInteger(id)) return false;
    const request = this.pendingRequests.get(id);
    if (!request) return false;
    this.pendingRequests.delete(id);
    if (record.result !== null) {
      this.logger("DAILY_RANGE_PATH_STREAM_SUBSCRIPTION_REJECTED", {
        environment: this.environment,
        method: request.method,
        symbols: request.symbols.length,
        detail: typeof record.msg === "string" ? record.msg : record.code ?? "unknown exchange response",
      });
      return true;
    }
    if (request.method === "SUBSCRIBE") {
      const subscribedAtMs = this.nowMs();
      for (const symbol of request.symbols) {
        if (!this.subscribedSymbols.has(symbol)) this.symbolStreamStartedAtMs.set(symbol, subscribedAtMs);
        this.subscribedSymbols.add(symbol);
      }
    } else {
      for (const symbol of request.symbols) {
        this.subscribedSymbols.delete(symbol);
        this.symbolStreamStartedAtMs.delete(symbol);
      }
    }
    this.syncSubscriptions(socket);
    return true;
  }

  private clearSocketState(): void {
    this.socket = null;
    this.streamStartedAtMs = null;
    this.subscribedSymbols.clear();
    this.symbolStreamStartedAtMs.clear();
    this.pendingRequests.clear();
  }

  disconnect(reason = "contract-price websocket stopped"): void {
    const socket = this.socket;
    const hadLiveStream = this.streamStartedAtMs !== null;
    this.clearSocketState();
    if (!socket) return;
    if (hadLiveStream) this.onStreamInterrupted(reason);
    try {
      socket.close();
    } catch {
      // The stream is observational. A later refresh can reconnect.
    }
  }

  getStatus(): {
    desiredSymbols: number;
    subscribedSymbols: number;
    pendingSubscriptions: number;
    connected: boolean;
    streamStartedAtMs: number | null;
  } {
    return {
      desiredSymbols: this.desiredSymbols.size,
      subscribedSymbols: this.subscribedSymbols.size,
      pendingSubscriptions: this.pendingRequests.size,
      connected: this.socket !== null && this.streamStartedAtMs !== null,
      streamStartedAtMs: this.streamStartedAtMs,
    };
  }
}
