// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import "./AutomationSupport.sol";
import {IPoolManager, ISwapRouter02} from "./StakedBuybackExecutor.sol";

interface ActiveBuybackGuard {
    function buybackTerms(uint256 amount, uint256 minimum) external view returns (uint256, uint160);
}

/// @notice Replacement executor compatible with the existing vault's two-argument buyback ABI.
/// @dev Requires an active guard call. Fixed routing, first-leg floor, bounded v4 price, no partial fills.
contract StakedBoundedBuybackExecutor is SafeAuthority {
    using AutomationTransfer for address;
    struct Config {
        address vault;
        address guard;
        address usdc;
        address weth;
        address bnkr;
        address staked;
        address router;
        address poolManager;
        uint24 feeUsdcWeth;
        uint24 feeWethBnkr;
        uint24 v4Fee;
        int24 tickSpacing;
        address hooks;
    }
    address public immutable vault;
    address public immutable guard;
    address public immutable usdc;
    address public immutable weth;
    address public immutable bnkr;
    address public immutable staked;
    address public immutable router;
    address public immutable poolManager;
    uint24 public immutable feeUsdcWeth;
    uint24 public immutable feeWethBnkr;
    bool public immutable bnkrIsCurrency0;
    IPoolManager.PoolKey public poolKey;
    bool private callbackPending;
    bytes32 private callbackHash;
    event Buyback(uint256 usdcIn, uint256 bnkrIn, uint256 stakedOut);

    constructor(address safe_, Config memory c) SafeAuthority(safe_) {
        require(c.vault.code.length > 0 && c.guard.code.length > 0, "missing vault/guard");
        require(c.router.code.length > 0 && c.poolManager.code.length > 0, "missing DEX");
        require(c.usdc.code.length > 0 && c.weth.code.length > 0 && c.bnkr.code.length > 0 && c.staked.code.length > 0, "bad tokens");
        require(c.usdc != c.bnkr && c.usdc != c.staked && c.bnkr != c.staked, "duplicate tokens");
        require(c.feeUsdcWeth > 0 && c.feeWethBnkr > 0 && c.tickSpacing > 0, "bad pool config");
        vault = c.vault;
        guard = c.guard;
        usdc = c.usdc;
        weth = c.weth;
        bnkr = c.bnkr;
        staked = c.staked;
        router = c.router;
        poolManager = c.poolManager;
        feeUsdcWeth = c.feeUsdcWeth;
        feeWethBnkr = c.feeWethBnkr;
        bool first = c.bnkr < c.staked;
        bnkrIsCurrency0 = first;
        poolKey = IPoolManager.PoolKey(first ? c.bnkr : c.staked, first ? c.staked : c.bnkr, c.v4Fee, c.tickSpacing, c.hooks);
    }

    function buyback(uint256 amount, uint256 minStaked) external nonReentrant returns (uint256 stakedOut) {
        require(msg.sender == vault && amount > 0 && minStaked > 0, "not vault / zero amount");
        (uint256 minBnkr, uint160 priceLimit) = ActiveBuybackGuard(guard).buybackTerms(amount, minStaked);
        uint256 usdcBefore = AutomationToken(usdc).balanceOf(address(this));
        uint256 bnkrBefore = AutomationToken(bnkr).balanceOf(address(this));
        uint256 stakedBefore = AutomationToken(staked).balanceOf(vault);
        usdc.pull(vault, amount);
        require(AutomationToken(usdc).balanceOf(address(this)) == usdcBefore + amount, "short USDC transfer");
        usdc.approve(router, amount);
        ISwapRouter02(router).exactInput(ISwapRouter02.ExactInputParams({
            path: abi.encodePacked(usdc, feeUsdcWeth, weth, feeWethBnkr, bnkr),
            recipient: address(this), amountIn: amount, amountOutMinimum: minBnkr
        }));
        usdc.approve(router, 0);
        require(AutomationToken(usdc).balanceOf(address(this)) == usdcBefore, "USDC not consumed");
        uint256 bnkrOut = AutomationToken(bnkr).balanceOf(address(this)) - bnkrBefore;
        require(bnkrOut >= minBnkr && bnkrOut <= uint256(uint128(type(int128).max)), "v3 output out of bounds");

        bytes memory data = abi.encode(bnkrOut, priceLimit);
        callbackHash = keccak256(data);
        callbackPending = true;
        IPoolManager(poolManager).unlock(data);
        require(!callbackPending, "missing callback");
        delete callbackHash;
        require(AutomationToken(bnkr).balanceOf(address(this)) == bnkrBefore, "BNKR not consumed");
        stakedOut = AutomationToken(staked).balanceOf(vault) - stakedBefore;
        require(stakedOut >= minStaked, "final slippage");
        emit Buyback(amount, bnkrOut, stakedOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == poolManager && callbackPending && keccak256(data) == callbackHash, "unexpected callback");
        callbackPending = false; // A second callback, including nested reentry, is forbidden.
        (uint256 bnkrIn, uint160 priceLimit) = abi.decode(data, (uint256, uint160));
        int256 delta = IPoolManager(poolManager).swap(poolKey,
            IPoolManager.SwapParams(bnkrIsCurrency0, -int256(bnkrIn), priceLimit), "");
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(delta);
        (int128 owed, int128 received) = bnkrIsCurrency0 ? (amount0, amount1) : (amount1, amount0);
        require(owed < 0 && received > 0, "bad delta");
        // A price limit can cause a partial fill. Revert the WHOLE buyback rather than strand BNKR.
        require(uint256(-int256(owed)) == bnkrIn, "partial v4 fill");
        IPoolManager(poolManager).sync(bnkr);
        bnkr.transfer(poolManager, bnkrIn);
        require(IPoolManager(poolManager).settle() == bnkrIn, "bad settlement");
        IPoolManager(poolManager).take(staked, vault, uint256(uint128(received)));
        return abi.encode(uint256(uint128(received)));
    }

    function sweepToSafe(address token) external onlySafe nonReentrant {
        uint256 amount = AutomationToken(token).balanceOf(address(this));
        if (amount != 0) token.transfer(safe, amount);
    }
}
