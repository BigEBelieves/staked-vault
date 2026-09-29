# Oracle arithmetic attribution

`contracts/StakedFullMath.sol` derives from Uniswap v3-core v1.0.0
[`FullMath.sol`](https://github.com/Uniswap/v3-core/blob/v1.0.0/contracts/libraries/FullMath.sol),
licensed MIT, with its credit to Remco Bloemen retained. Changes: Solidity
0.8.24, library rename, explicit unchecked modular arithmetic and unsigned
two's-complement expression.

`contracts/StakedTickMath.sol` derives from Uniswap v3-core v1.0.0
[`TickMath.sol`](https://github.com/Uniswap/v3-core/blob/v1.0.0/contracts/libraries/TickMath.sol),
licensed GPL-2.0-or-later. Changes: Solidity 0.8.24, library rename, explicit
cast for the maximum tick, and removal of the unused inverse function.

Oracle averaging, harmonic liquidity and quote formulas follow Uniswap
v3-periphery's
[`OracleLibrary.sol`](https://github.com/Uniswap/v3-periphery/blob/main/contracts/libraries/OracleLibrary.sol),
licensed GPL-2.0-or-later. `StakedTwapKeeper.sol` is GPL-2.0-or-later.

These are adaptations, not unchanged upstream audited binaries. Their tests
do not transfer an upstream audit to this deployment.
