// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;
import "./AutomationSupport.sol";
import "./StakedFullMath.sol";
import "./StakedTickMath.sol";
import {TwapV3Factory, TwapV3Pool, TwapDistributor} from "./StakedTwapKeeper.sol";

interface TwapPredecessor {
    function safe() external view returns (address);
    function bnkr() external view returns (address);
    function paused() external view returns (bool);
    function operator() external view returns (address);
    function spentLast24Hours() external view returns (uint256);
    function lastExecution() external view returns (uint48);
}

interface TwapBatchDistributor is TwapDistributor {
    function batchSwapVersion() external view returns (uint256);
    function swapBatchAndNotify(uint256 amountIn, uint256 minUsdcOut) external returns (uint256);
}

/// @notice Proposed, undeployed V3 distribution-only keeper with exact bounded batch inputs. No custody, token approvals, buyback or arbitrary call path.
/// @dev A DEX TWAP is not manipulation-proof. Limits restrict, but cannot eliminate, oracle/MEV risk.
contract StakedTwapKeeperV3 is SafeAuthority {
    uint32 public constant LONG_WINDOW = 1 hours;
    uint32 public constant SHORT_WINDOW = 5 minutes;
    uint32 public constant MAX_OBSERVATION_AGE = 30 minutes;
    uint32 public constant MAX_DEADLINE = 120;
    uint24 public constant FEE_BNKR_WETH = 10000;
    uint24 public constant FEE_WETH_USDC = 500;
    uint256 private constant Q96 = 1 << 96;
    uint256 private constant DAY = 1 days;
    uint256 private constant MAX_TRADES = 96;

    struct Config { address distributor; address relay; address bnkr; address weth; address usdc; address router; address factory; address predecessor; }
    struct Limits {
        uint128 maxBnkrPerSwap;
        uint128 maxBnkrPer24Hours;
        uint128 minLiquidityBnkrWeth;
        uint128 minLiquidityWethUsdc;
        uint32 minInterval;
        uint16 slippageBps;
        uint16 maxTickDeviation;
        uint16 maxInputReserveBps;
    }
    struct Reading { int24 longTick; int24 shortTick; uint160 sqrtPriceX96; uint128 effectiveLiquidity; }
    struct Trade { uint48 timestamp; uint128 amount; }

    address public immutable predecessor;
    address public immutable distributor;
    address public immutable relay;
    address public immutable bnkr;
    address public immutable weth;
    address public immutable usdc;
    address public immutable router;
    address public immutable factory;
    address public immutable poolBnkrWeth;
    address public immutable poolWethUsdc;
    address public operator;
    bool public paused = true;
    Limits public limits;
    uint256 public nonce;
    uint48 public lastExecution;
    Trade[96] public history;
    uint8 public nextTrade;

    event OperatorUpdated(address indexed operator);
    event LimitsUpdated(Limits limits);
    event Paused(bool paused);
    event Executed(uint256 indexed nonce, uint128 bnkrIn, uint256 minimumUsdc, uint256 usdcOut);

    constructor(address safe_, Config memory c) SafeAuthority(safe_) {
        require(c.distributor.code.length > 0 && c.relay.code.length > 0, "missing protocol");
        require(TwapBatchDistributor(c.distributor).batchSwapVersion() == 1, "batch interface required");
        require(c.router.code.length > 0 && c.factory.code.length > 0, "missing DEX");
        require(c.bnkr.code.length > 0 && c.weth.code.length > 0 && c.usdc.code.length > 0, "missing tokens");
        require(c.bnkr != c.weth && c.bnkr != c.usdc && c.weth != c.usdc, "duplicate tokens");
        distributor = c.distributor; relay = c.relay; bnkr = c.bnkr; weth = c.weth; usdc = c.usdc;
        router = c.router; factory = c.factory;
        require(c.predecessor.code.length > 0, "missing predecessor");
        require(TwapPredecessor(c.predecessor).safe() == safe_ && TwapPredecessor(c.predecessor).bnkr() == c.bnkr, "wrong predecessor");
        predecessor = c.predecessor;
        poolBnkrWeth = _pool(c.factory, c.bnkr, c.weth, FEE_BNKR_WETH);
        poolWethUsdc = _pool(c.factory, c.weth, c.usdc, FEE_WETH_USDC);
    }

    function _pool(address f, address a, address b, uint24 fee_) private view returns (address p) {
        p = TwapV3Factory(f).getPool(a, b, fee_);
        require(p.code.length > 0, "missing pool");
        require(TwapV3Pool(p).token0() == (a < b ? a : b) && TwapV3Pool(p).token1() == (a < b ? b : a), "wrong pool tokens");
        require(TwapV3Pool(p).fee() == fee_, "wrong pool fee");
    }

    function setOperator(address value) external onlySafe { operator = value; nonce++; emit OperatorUpdated(value); }

    function setLimits(Limits calldata p) external onlySafe {
        require(paused, "pause first");
        require(p.maxBnkrPerSwap > 0 && p.maxBnkrPer24Hours >= p.maxBnkrPerSwap, "bad caps");
        require(p.minLiquidityBnkrWeth > 0 && p.minLiquidityWethUsdc > 0, "zero liquidity floor");
        require(p.minInterval >= 15 minutes && p.minInterval <= 1 days, "bad interval");
        require(p.slippageBps <= 100 && p.maxTickDeviation > 0 && p.maxTickDeviation <= 100, "loose price limits");
        require(p.maxInputReserveBps > 0 && p.maxInputReserveBps <= 20, "loose size limit");
        limits = p; nonce++; // History and lastExecution deliberately survive every configuration change.
        emit LimitsUpdated(p);
    }

    function setPaused(bool value) external {
        require(msg.sender == safe || (msg.sender == operator && value), "not Safe");
        if (!value) {
            require(operator != address(0) && limits.maxBnkrPerSwap > 0, "not configured");
            _routeOkay();
        }
        paused = value; nonce++; emit Paused(value);
    }

    /// @notice Aggregate rolling spend, including the immutable legacy keeper.
    function spentLast24Hours() public view returns (uint256 spent) {
        spent = TwapPredecessor(predecessor).spentLast24Hours();
        for (uint256 i; i < MAX_TRADES; ++i) {
            Trade memory t = history[i];
            if (uint256(t.timestamp) + DAY > block.timestamp) spent += t.amount;
        }
    }

    function effectiveLastExecution() public view returns (uint48) {
        uint48 previous = TwapPredecessor(predecessor).lastExecution();
        return previous > lastExecution ? previous : lastExecution;
    }

    function _routeOkay() private view {
        require(TwapPredecessor(predecessor).paused() && TwapPredecessor(predecessor).operator() == address(0), "predecessor active");
        TwapDistributor d = TwapDistributor(distributor);
        require(d.owner() == safe && d.keeper() == address(this), "authority changed");
        require(d.vault() == relay && d.swapRouter() == router, "route changed");
        require(d.bnkr() == bnkr && d.weth() == weth && d.usdc() == usdc, "tokens changed");
        require(d.bnkrWethFee() == FEE_BNKR_WETH && d.wethUsdcFee() == FEE_WETH_USDC, "fees changed");
        require(d.liquidityWallet() == safe && d.bnkrStakingWallet() == safe, "payout changed");
    }

    // Uniswap v3 OracleLibrary consult semantics, including wraparound and negative-tick rounding.
    function _mean(int56 before_, int56 after_, uint32 seconds_) private pure returns (int24 tick) {
        int56 delta;
        unchecked { delta = after_ - before_; }
        int56 divisor = int56(uint56(seconds_));
        int56 value = delta / divisor;
        if (delta < 0 && delta % divisor != 0) --value;
        require(value >= -887272 && value <= 887272, "invalid mean tick");
        tick = int24(value);
    }

    function _near(int24 a, int24 b) private view {
        int256 delta = int256(a) - int256(b);
        require(delta <= int256(uint256(limits.maxTickDeviation)) && delta >= -int256(uint256(limits.maxTickDeviation)), "price deviation");
    }

    function _read(address pool, uint128 minimumLiquidity) private view returns (Reading memory r) {
        TwapV3Pool p = TwapV3Pool(pool);
        (uint160 sqrt, int24 spot, uint16 index, , , , bool unlocked) = p.slot0();
        require(unlocked && sqrt > 0, "pool locked/uninitialized");
        (uint32 last, , , bool initialized) = p.observations(index);
        uint32 age;
        unchecked { age = uint32(block.timestamp) - last; }
        require(initialized && age <= MAX_OBSERVATION_AGE, "stale pool");
        uint32[] memory secondsAgos = new uint32[](3);
        secondsAgos[0] = LONG_WINDOW; secondsAgos[1] = SHORT_WINDOW;
        (int56[] memory ticks, uint160[] memory spl) = p.observe(secondsAgos); // Missing history reverts, never falls back to spot.
        require(ticks.length == 3 && spl.length == 3, "invalid observation");
        r.longTick = _mean(ticks[0], ticks[2], LONG_WINDOW);
        r.shortTick = _mean(ticks[1], ticks[2], SHORT_WINDOW);
        _near(spot, r.longTick); _near(spot, r.shortTick); _near(r.longTick, r.shortTick);
        uint160 delta;
        unchecked { delta = spl[2] - spl[0]; }
        require(delta > 0, "invalid liquidity history");
        uint256 harmonic = (uint192(LONG_WINDOW) * type(uint160).max) / (uint192(delta) << 32);
        require(harmonic > 0 && harmonic <= type(uint128).max, "invalid harmonic liquidity");
        uint128 current = p.liquidity();
        r.effectiveLiquidity = current < harmonic ? current : uint128(harmonic);
        require(r.effectiveLiquidity >= minimumLiquidity, "thin liquidity");
        r.sqrtPriceX96 = sqrt;
    }

    function _quote(int24 tick, uint128 amount, address base, address quote) private pure returns (uint256) {
        uint160 sqrt = StakedTickMath.getSqrtRatioAtTick(tick);
        if (sqrt <= type(uint128).max) {
            uint256 ratio = uint256(sqrt) * sqrt;
            return base < quote ? StakedFullMath.mulDiv(ratio, amount, 1 << 192) : StakedFullMath.mulDiv(1 << 192, amount, ratio);
        }
        uint256 ratio128 = StakedFullMath.mulDiv(sqrt, sqrt, 1 << 64);
        return base < quote ? StakedFullMath.mulDiv(ratio128, amount, 1 << 128) : StakedFullMath.mulDiv(1 << 128, amount, ratio128);
    }

    function _net(uint256 amount, uint24 fee_) private pure returns (uint128) {
        require(amount > 0 && amount <= type(uint128).max, "quote overflow/zero");
        return uint128(StakedFullMath.mulDiv(amount, 1_000_000 - fee_, 1_000_000));
    }

    function _reserve(uint128 liquidity_, uint160 sqrt, bool token0) private pure returns (uint256) {
        return token0 ? StakedFullMath.mulDiv(liquidity_, Q96, sqrt) : StakedFullMath.mulDiv(liquidity_, sqrt, Q96);
    }

    function _size(Reading memory r, bool token0, uint256 amount) private view {
        uint256 a = _reserve(r.effectiveLiquidity, r.sqrtPriceX96, token0);
        uint256 b = _reserve(r.effectiveLiquidity, StakedTickMath.getSqrtRatioAtTick(r.longTick), token0);
        uint256 c = _reserve(r.effectiveLiquidity, StakedTickMath.getSqrtRatioAtTick(r.shortTick), token0);
        uint256 smallest = a < b ? a : b;
        if (c < smallest) smallest = c;
        require(amount <= StakedFullMath.mulDiv(smallest, limits.maxInputReserveBps, 10000), "input too large for liquidity");
    }

    function minimumUsdc(uint128 amount) public view returns (uint256 minimum) {
        require(amount > 0 && limits.maxBnkrPerSwap > 0, "zero/unconfigured");
        Reading memory a = _read(poolBnkrWeth, limits.minLiquidityBnkrWeth);
        Reading memory b = _read(poolWethUsdc, limits.minLiquidityWethUsdc);
        _size(a, bnkr < weth, amount);
        uint128 netBnkr = _net(amount, FEE_BNKR_WETH);
        uint256 longWeth = _quote(a.longTick, netBnkr, bnkr, weth);
        uint256 shortWeth = _quote(a.shortTick, netBnkr, bnkr, weth);
        uint256 largerWeth = longWeth > shortWeth ? longWeth : shortWeth;
        _size(b, weth < usdc, largerWeth);
        uint256 longOut = _quote(b.longTick, _net(longWeth, FEE_WETH_USDC), weth, usdc);
        uint256 shortOut = _quote(b.shortTick, _net(shortWeth, FEE_WETH_USDC), weth, usdc);
        uint256 referenceOut = longOut > shortOut ? longOut : shortOut;
        require(referenceOut > 0, "empty quote");
        minimum = StakedFullMath.mulDivRoundingUp(referenceOut, 10000 - limits.slippageBps, 10000);
    }

    /// @notice Swap this exact input; excess queued donations wait for a later bounded batch.
    function swapAndNotify(uint128 expectedAmount, uint256 keeperMinimum, uint48 deadline, uint256 expectedNonce)
        external nonReentrant returns (uint256 out)
    {
        require(msg.sender == operator || msg.sender == safe, "not operator");
        require(!paused && expectedNonce == nonce, "paused/stale nonce");
        // The price floor is recomputed on-chain at execution; no caller-supplied quote-block attestation.
        require(deadline >= block.timestamp && deadline <= block.timestamp + MAX_DEADLINE, "bad deadline");
        _routeOkay();
        require(expectedAmount > 0 && expectedAmount <= TwapDistributor(distributor).pendingSwapBnkr(), "insufficient queue");
        require(expectedAmount >= TwapDistributor(distributor).minBnkrBatch(), "below batch threshold");
        require(expectedAmount <= limits.maxBnkrPerSwap && spentLast24Hours() + expectedAmount <= limits.maxBnkrPer24Hours, "spending cap");
        require(block.timestamp >= uint256(effectiveLastExecution()) + limits.minInterval, "cooldown");
        uint256 floor = minimumUsdc(expectedAmount);
        require(keeperMinimum >= floor, "below TWAP floor");
        require(history[nextTrade].amount == 0 || uint256(history[nextTrade].timestamp) + DAY <= block.timestamp, "history full");
        history[nextTrade] = Trade(uint48(block.timestamp), expectedAmount);
        nextTrade = uint8((uint256(nextTrade) + 1) % MAX_TRADES);
        lastExecution = uint48(block.timestamp);
        nonce++;
        out = TwapBatchDistributor(distributor).swapBatchAndNotify(expectedAmount, keeperMinimum);
        require(out >= keeperMinimum, "under-delivery");
        emit Executed(expectedNonce, expectedAmount, keeperMinimum, out);
    }
}
