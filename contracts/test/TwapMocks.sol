// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;
import "../StakedTickMath.sol";
import "../StakedFullMath.sol";

contract MockTwapFactory {
    mapping(bytes32 => address) private pools;
    function setPool(address a, address b, uint24 fee, address pool) external {
        pools[keccak256(abi.encode(a < b ? a : b, a < b ? b : a, fee))] = pool;
    }
    function getPool(address a, address b, uint24 fee) external view returns (address) {
        return pools[keccak256(abi.encode(a < b ? a : b, a < b ? b : a, fee))];
    }
}

contract MockTwapPool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    uint128 public liquidity = 1e28;
    uint128 public harmonicLiquidity = 1e28;
    int24 public spotTick;
    int24 public longTick;
    int24 public shortTick;
    uint32 public age;
    bool public noHistory;
    bool public locked;
    bool public wrap;
    int56 public remainder;
    constructor(address a, address b, uint24 f) { token0 = a < b ? a : b; token1 = a < b ? b : a; fee = f; }
    function setTicks(int24 s, int24 l, int24 sh) external { spotTick = s; longTick = l; shortTick = sh; }
    function setLiquidity(uint128 current, uint128 harmonic) external { liquidity = current; harmonicLiquidity = harmonic; }
    function setFailure(uint32 age_, bool missing, bool locked_) external { age = age_; noHistory = missing; locked = locked_; }
    function setWrap(bool value) external { wrap = value; }
    function setRemainder(int56 value) external { remainder = value; }
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (StakedTickMath.getSqrtRatioAtTick(spotTick), spotTick, 0, 100, 100, 0, !locked);
    }
    function observations(uint256) external view returns (uint32 t, int56, uint160, bool) {
        unchecked { t = uint32(block.timestamp) - age; }
        return (t, 0, 0, true);
    }
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory ticks, uint160[] memory spl) {
        require(!noHistory, "OLD");
        require(secondsAgos.length == 3 && secondsAgos[0] == 3600 && secondsAgos[1] == 300 && secondsAgos[2] == 0, "bad windows");
        ticks = new int56[](3); spl = new uint160[](3);
        unchecked {
            ticks[0] = wrap ? type(int56).max - 100 : int56(0);
            ticks[2] = ticks[0] + int56(longTick) * 3600 + remainder;
            ticks[1] = ticks[2] - int56(shortTick) * 300;
            spl[0] = wrap ? type(uint160).max - 100 : uint160(0);
            spl[1] = spl[0] + uint160((uint256(3300) << 128) / harmonicLiquidity);
            spl[2] = spl[0] + uint160((uint256(3600) << 128) / harmonicLiquidity);
        }
    }
}

contract TwapMathHarness {
    function mulDiv(uint256 a, uint256 b, uint256 d) external pure returns (uint256) { return StakedFullMath.mulDiv(a,b,d); }
    function mulDivUp(uint256 a, uint256 b, uint256 d) external pure returns (uint256) { return StakedFullMath.mulDivRoundingUp(a,b,d); }
    function sqrt(int24 tick) external pure returns (uint160) { return StakedTickMath.getSqrtRatioAtTick(tick); }
}
