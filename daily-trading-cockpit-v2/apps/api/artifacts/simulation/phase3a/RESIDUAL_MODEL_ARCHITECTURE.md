# Residual model architecture

The generator samples synchronized BTC/ETH residual vectors from calibration data, conditionally by regime, volatility, dependence, and return direction. It evolves a continuous price path; no historical candle block is inserted or joined. Fallback hierarchy is exact regime+vol+dependence -> regime+vol -> vol+return direction -> broad regime state -> INSUFFICIENT_CONDITIONAL_SUPPORT. Gaussian is evaluated only as a negative control.
