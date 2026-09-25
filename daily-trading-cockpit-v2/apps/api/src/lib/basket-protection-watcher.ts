import type { BookQuote } from "./cross-profit-protection-v1.js";
export interface ProtectionSnapshot {
    quotes: ReadonlyMap<string, BookQuote>;
    marks: ReadonlyMap<string, {
        price: number;
        observedAtMs: number;
    }>;
}
interface Options {
    environment: "mainnet" | "testnet";
    symbols: () => string[];
    evaluate: (snapshot: ProtectionSnapshot) => Promise<void>;
    nowMs?: () => number;
    createWebSocket?: (url: string) => WebSocket;
}
type Kind = "book" | "mark";
interface Connection {
    socket: WebSocket | null;
    key: string;
    lastMessageAt: number;
    openedAt: number;
    retryAt: number;
    failures: number;
}
/** Market data only; the executor retains exclusive ownership of all orders. */
export class BasketProtectionWatcher {
    private quotes = new Map<string, BookQuote>();
    private marks = new Map<string, {
        price: number;
        observedAtMs: number;
    }>();
    private updateIds = new Map<string, number>();
    private wanted = new Set<string>();
    private connections: Record<Kind, Connection> = {
        book: { socket: null, key: "", lastMessageAt: 0, openedAt: 0, retryAt: 0, failures: 0 },
        mark: { socket: null, key: "", lastMessageAt: 0, openedAt: 0, retryAt: 0, failures: 0 },
    };
    private running: Promise<void> | null = null;
    private dirty = false;
    private stopped = false;
    private timer: ReturnType<typeof setInterval> | null = null;
    private lastError: string | null = null;
    private passes = 0;
    private lastStartedAt = 0;
    private now: () => number;
    constructor(private options: Options) { this.now = options.nowMs ?? Date.now; }
    start() { if (this.timer)
        return; this.stopped = false; this.pulse(); this.timer = setInterval(() => this.pulse(), 1000); this.timer.unref?.(); }
    stop() { this.stopped = true; if (this.timer)
        clearInterval(this.timer); this.timer = null; this.drop("book"); this.drop("mark"); }
    private drop(kind: Kind) { const c = this.connections[kind], socket = c.socket; c.socket = null; if (kind === "book") {
        this.quotes.clear();
        this.updateIds.clear();
    }
    else
        this.marks.clear(); socket?.close(); }
    private pulse() {
        if (this.stopped)
            return;
        this.wanted = new Set(this.options.symbols().filter(s => /^[A-Z0-9_]+$/.test(s)));
        for (const s of this.quotes.keys())
            if (!this.wanted.has(s)) {
                this.quotes.delete(s);
                this.updateIds.delete(s);
            }
        for (const s of this.marks.keys())
            if (!this.wanted.has(s))
                this.marks.delete(s);
        const key = [...this.wanted].sort().join(","), now = this.now();
        for (const kind of ["book", "mark"] as const) {
            const c = this.connections[kind];
            if (c.socket && (c.key !== key || now - c.lastMessageAt > 30000 || now - c.openedAt > 23 * 3600000))
                this.drop(kind);
            if (key && !c.socket && now >= c.retryAt)
                this.connect(kind, key);
            if (!key && c.socket)
                this.drop(kind);
        }
        // Resume durable residual closes even if market data is interrupted.
        void this.requestEvaluation();
    }
    private connect(kind: Kind, key: string) {
        const c = this.connections[kind], suffix = kind === "book" ? "bookTicker" : "markPrice@1s";
        const streams = key.split(",").map(s => `${s.toLowerCase()}@${suffix}`).join("/");
        const base = this.options.environment === "mainnet" ? `wss://fstream.binance.com/${kind === "book" ? "public" : "market"}/stream` : "wss://stream.binancefuture.com/stream";
        try {
            const socket = (this.options.createWebSocket ?? (url => new WebSocket(url)))(`${base}?streams=${streams}`);
            c.socket = socket;
            c.key = key;
            c.openedAt = c.lastMessageAt = this.now();
            const failed = () => { if (c.socket !== socket)
                return; this.drop(kind); c.failures++; c.retryAt = this.now() + Math.min(30000, 1000 * 2 ** Math.min(5, c.failures - 1)); };
            socket.addEventListener("close", failed);
            socket.addEventListener("error", failed);
            socket.addEventListener("message", event => {
                if (c.socket !== socket || this.stopped)
                    return;
                try {
                    if (this.accept(JSON.parse(String(event.data)), kind)) {
                        c.lastMessageAt = this.now();
                        c.failures = 0;
                        void this.requestEvaluation();
                    }
                }
                catch { /* malformed data stays unusable */ }
            });
        }
        catch (error) {
            this.lastError = (error as Error).message;
            c.retryAt = this.now() + 5000;
        }
    }
    /** Replay seam; production input is exclusively the socket handler. */
    accept(payload: unknown, kind: Kind): boolean {
        const envelope = payload as {
            data?: unknown;
        } | null;
        const d = (envelope?.data ?? payload) as Record<string, unknown> | null;
        if (!d || typeof d !== "object" || typeof d.s !== "string" || !this.wanted.has(d.s))
            return false;
        if (d.st !== undefined && Number(d.st) !== 1)
            return false;
        const now = this.now(), at = Number(kind === "book" ? d.T : d.E);
        if (!Number.isFinite(at) || at <= 0 || at > now || now - at > 15000)
            return false;
        if (kind === "mark") {
            const price = Number(d.p);
            if (d.e !== "markPriceUpdate" || !Number.isFinite(price) || price <= 0 || at <= (this.marks.get(d.s)?.observedAtMs ?? 0))
                return false;
            this.marks.set(d.s, { price, observedAtMs: at });
        }
        else {
            const bidPrice = Number(d.b), askPrice = Number(d.a), bidQty = Number(d.B), askQty = Number(d.A), id = Number(d.u);
            if (d.e !== "bookTicker" || ![bidPrice, askPrice, bidQty, askQty].every(n => Number.isFinite(n) && n > 0) || bidPrice > askPrice || !Number.isSafeInteger(id) || id <= (this.updateIds.get(d.s) ?? -1) || at < (this.quotes.get(d.s)?.observedAtMs ?? 0))
                return false;
            this.updateIds.set(d.s, id);
            this.quotes.set(d.s, { symbol: d.s, bidPrice, askPrice, bidQty, askQty, observedAtMs: at });
        }
        return true;
    }
    requestEvaluation(): Promise<void> {
        if (this.stopped)
            return Promise.resolve();
        this.dirty = true;
        if (this.running)
            return this.running;
        // One dirty bit, never an unbounded queue of obsolete snapshots.
        this.running = Promise.resolve().then(async () => {
            // Coalesce idle quote bursts for at most 100 ms. An update DURING evaluation
            // still gets an immediate latest-snapshot pass in the loop below.
            const delay = Math.max(0, 100 - (this.now() - this.lastStartedAt));
            if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
            while (this.dirty && !this.stopped) {
                this.dirty = false;
                this.lastStartedAt = this.now();
                try {
                    await this.options.evaluate({ quotes: new Map(this.quotes), marks: new Map(this.marks) });
                    this.passes++;
                    this.lastError = null;
                }
                catch (error) {
                    this.lastError = (error as Error).message;
                }
            }
        }).finally(() => { this.running = null; if (this.dirty && !this.stopped)
            void this.requestEvaluation(); });
        return this.running;
    }
    status() {
        const quoteAgesMs = Object.fromEntries([...this.wanted].map(symbol => {
            const quote = this.quotes.get(symbol);
            return [symbol, quote ? this.now() - quote.observedAtMs : null];
        }));
        return {
            running: !!this.running, pending: this.dirty, passes: this.passes, lastError: this.lastError,
            symbols: [...this.wanted], quoteCount: this.quotes.size, markCount: this.marks.size,
            quoteAgesMs, freshQuoteCount: Object.values(quoteAgesMs).filter(age => age !== null && age >= 0 && age <= 15_000).length,
            bookConnected: this.connections.book.socket?.readyState === 1,
            markConnected: this.connections.mark.socket?.readyState === 1,
        };
    }
}
