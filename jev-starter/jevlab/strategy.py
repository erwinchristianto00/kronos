"""YOUR STRATEGY. This is the one file you're meant to edit.

Jev makes a call several times a second ("buy, 91% sure"). Your strategy decides
which of those calls actually become trades. Most should end in "hold": every
trade has a cost, so a bot that trades every call bleeds.

decide() is called every time Jev answers, with:

  call      Jev's answer, e.g. {"side": "buy", "conf": 0.91}. On the 24/7 bot the call can also come
            from the local signal model (jevlab/model.py): {"source": "model", "edge_bps": 7.2, ...},
            handled by decide_model() below; or from the rules fallback when Jev is busy.
  market    the live numbers Jev was shown, for example:
              return_5s_bps, return_30s_bps     price change over 5s / 30s (1 bps = 0.01%)
              top_of_book_imbalance             -1 (all sellers) .. +1 (all buyers) at the best price
              depth5_imbalance                  the same, over the top 5 price levels
              aggressor_buy_share_5s / _30s     share of recent trade volume that was buyers (0..1)
              trades_last_5s                    how busy the market is right now
              spread_bps, microprice_vs_mid_bps, tick_volatility_60s_bps
              claude_bias                       24/7 bot only: "long", "short" or "flat", Claude's
                                                big-picture call, refreshed every few minutes
  position  1 = you're long, -1 = you're short, 0 = flat
  seconds_since_trade   seconds since your last fill

Return one of:
  "buy"            go (or stay) long
  "sell"           go (or stay) short
  "flat"           close the position
  "hold · reason"  do nothing. The reason shows up in the dashboard feed.

The loop handles everything else: placing the (paper) order, fees, the
dashboard. Want a different strategy? Describe it to Claude in one sentence
and ask it to rewrite decide(), e.g. "only buy when Jev is 90%+ sure AND
buyers have been in control for the last 30 seconds".
"""

# Slower, pickier strategy for liquid altcoins like SOL: fees are ~4 bps a round trip,
# so only enter when the last 30 seconds already moved more than that in Jev's direction
# (with buyers or sellers in control), then sit in the position for at least 5 minutes.
SETTINGS = {
    "min_conf": 0.85,       # only act when Jev is at least this sure
    "min_move_bps": 4.0,    # the last 30s must have moved at least this far in Jev's direction (≈ fees)
    "min_flow": 0.55,       # share of 30s trade volume on Jev's side (buyers for a buy, sellers for a sell)
    "min_hold": 300,        # seconds to stay in a position before exiting or flipping (5 minutes)
    "cooldown": 60,         # seconds to wait after any trade before entering again
    "max_spread_bps": None, # skip entries when the spread is wider than this (None = off; the testnet's is always wide)
    "fallback_min_flow": 0.65,  # when Jev is busy: share of 30s volume needed on one side for a rules-only call
    "model_min_edge_bps": None,  # local model: predicted move needed to enter (None = the model's own tested 6 bps;
                                 # 4 trades ~3x as often but tested slightly negative after fees)
    "model_follow_claude": False,  # local model: True = only trade in Claude's direction (untested); False = Claude
                                   # only vetoes, by saying "flat" (this matches how the model was tested)
}

DESCRIPTION = (f"enter at ≥{SETTINGS['min_conf']:.0%} with a ≥{SETTINGS['min_move_bps']:g} bps 30s move and flow · "
               f"hold ≥{SETTINGS['min_hold'] // 60:g} min")


def decide_model(call: dict, market: dict, position: int, seconds_since_trade: float) -> str:
    """Calls from the local signal model (jevlab/model.py). call["edge_bps"] is its predicted move over
    call["horizon_s"] seconds. This mirrors how the model was tested: enter when the predicted move is at
    least min_edge_bps, hold for the horizon, then exit unless the model still predicts the same side.
    Claude can only veto (bias "flat"), unless SETTINGS["model_follow_claude"] is True."""
    edge, horizon = call["edge_bps"], call["horizon_s"]
    min_edge = SETTINGS.get("model_min_edge_bps") or call["min_edge_bps"]
    want = (1 if edge > 0 else -1) if abs(edge) >= min_edge else 0
    bias = market.get("claude_bias")
    follow = SETTINGS.get("model_follow_claude", False)
    if bias == "flat":  # Claude's veto: the market looks too messy to trade
        return "flat" if position else "hold · Claude says stay out"
    if follow and ((bias == "long" and position < 0) or (bias == "short" and position > 0)):
        return "flat"  # Claude changed its mind: get out of the old direction first
    if position:
        if seconds_since_trade < horizon:
            return f"hold · in position ({horizon // 60} min hold)"
        return "hold · model still agrees" if want == position else "flat"
    if not want:
        return f"hold · predicted move {edge:+.1f} bps, under {min_edge:g}"
    if follow and ((bias == "long" and want < 0) or (bias == "short" and want > 0)):
        return f"hold · against Claude's {bias} bias"
    if seconds_since_trade < SETTINGS["cooldown"]:
        return "hold · cooling down"
    return "buy" if want > 0 else "sell"


def decide(call: dict, market: dict, position: int, seconds_since_trade: float) -> str:
    if call.get("source") == "model":
        return decide_model(call, market, position, seconds_since_trade)
    want = 1 if call["side"] == "buy" else -1
    strong = call["conf"] >= SETTINGS["min_conf"]
    bias = market.get("claude_bias")  # only set on the 24/7 bot, where Claude is the brain

    # 1. Claude's big picture always wins
    if bias == "flat":
        return "flat" if position else "hold · Claude says stay out"
    if (bias == "long" and position < 0) or (bias == "short" and position > 0):
        return "flat"  # Claude changed its mind: get out of the old direction first

    # 2. In a position: sit tight for the minimum hold, then exit on a strong call against it
    if position and seconds_since_trade < SETTINGS["min_hold"]:
        return "hold · in position (min hold)"
    if position and want != position and strong:
        return "flat"
    if want == position:
        return "hold · already " + ("long" if want > 0 else "short")

    # 3. Entering: Jev, Claude, the recent move and the order flow must all agree
    if (bias == "long" and want < 0) or (bias == "short" and want > 0):
        return f"hold · against Claude's {bias} bias"
    if not strong:
        return "hold · low conviction"
    if seconds_since_trade < SETTINGS["cooldown"]:
        return "hold · cooling down"
    if SETTINGS["max_spread_bps"] is not None and market.get("spread_bps", 0) > SETTINGS["max_spread_bps"]:
        return "hold · spread too wide"
    if want * market.get("return_30s_bps", 0) < SETTINGS["min_move_bps"]:
        return "hold · move too small"
    flow = market.get("aggressor_buy_share_30s", 0.5)
    if (flow if want > 0 else 1 - flow) < SETTINGS["min_flow"]:
        return "hold · flow disagrees"
    return call["side"]


def fallback_call(market: dict) -> dict | None:
    """When Jev doesn't answer (busy or down), make the call from the market numbers alone:
    the last 30s moved at least min_move_bps and one side clearly controlled the trading.
    The result goes through decide() like a Jev call. None = no clear signal, do nothing."""
    ret = market.get("return_30s_bps", 0)
    if abs(ret) < SETTINGS["min_move_bps"]:
        return None
    side = "buy" if ret > 0 else "sell"
    flow = market.get("aggressor_buy_share_30s", 0.5)
    if (flow if side == "buy" else 1 - flow) < SETTINGS["fallback_min_flow"]:
        return None
    return {"side": side, "conf": 1.0}


# ---------------------------------------------------------------------------
# Example: trade with the trend only. Uncomment to use it (and delete the
# decide() above).
#
# def decide(call, market, position, seconds_since_trade):
#     trend_up = market.get("return_30s_bps", 0) > 0 and market.get("aggressor_buy_share_30s", 0.5) > 0.55
#     trend_down = market.get("return_30s_bps", 0) < 0 and market.get("aggressor_buy_share_30s", 0.5) < 0.45
#     if call["conf"] < 0.8:
#         return "hold · low conviction"
#     if call["side"] == "buy" and trend_up and position != 1:
#         return "buy"
#     if call["side"] == "sell" and trend_down and position != -1:
#         return "sell"
#     return "hold · against the trend"
