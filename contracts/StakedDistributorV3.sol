// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20, ISwapRouter02, IStakedVault, SafeERC20Lite, Ownable2Step, ReentrancyGuard} from "./StakedDistributor.sol";
import {ConfigurationDelay} from "./ConfigurationDelay.sol";

/// @notice Proposed replacement core. NOT the contract currently deployed on Base.
/// @dev Retains the v2 accounting and interfaces, with the reviewed v3 safety changes.
///      Listed configuration changes require 48 hours notice and expire 7 days later.
contract StakedDistributorV3 is Ownable2Step, ReentrancyGuard, ConfigurationDelay {
    using SafeERC20Lite for IERC20;

    IERC20 public immutable stakedToken;
    IERC20 public immutable bnkr;
    IERC20 public immutable usdc;
    address public immutable weth;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant BPS = 10_000;
    uint256 public constant STAKED_BURN_BPS = 5000; // 50% of STAKED fees burned
    uint256 public constant BNKR_STAKING_BPS = 5000; // 50% of BNKR fees to Bankr staking

    ISwapRouter02 public swapRouter;
    IStakedVault public vault;
    address public liquidityWallet;
    address public bnkrStakingWallet;
    address public keeper;

    uint256 public minBnkrBatch; // BNKR-wei threshold (~$100 worth; owner-adjustable as price moves)
    uint256 public pendingSwapBnkr; // BNKR accumulated for the USDC leg, not yet swapped
    uint24 public bnkrWethFee = 10_000; // BNKR/WETH v3 pool fee tier (1%)
    uint24 public wethUsdcFee = 500; // WETH/USDC v3 pool fee tier (0.05%)

    // Lifetime stats
    uint256 public totalStakedBurned;
    uint256 public totalStakedToLiquidity;
    uint256 public totalBnkrToStaking;
    uint256 public totalBnkrSwapped;
    uint256 public totalUsdcToVault;

    event StakedDistributed(uint256 burned, uint256 toLiquidity);
    event BnkrDistributed(uint256 toStaking, uint256 queuedForSwap, uint256 pendingSwapTotal);
    event SwappedAndNotified(uint256 bnkrIn, uint256 usdcOut);
    event MinBnkrBatchUpdated(uint256 threshold);
    event PoolFeesUpdated(uint24 bnkrWethFee, uint24 wethUsdcFee);
    event VaultUpdated(address vault);
    event RouterUpdated(address router);
    event LiquidityWalletUpdated(address wallet);
    event BnkrStakingWalletUpdated(address wallet);
    event KeeperUpdated(address keeper);
    event Rescued(address token, uint256 amount, address to);

    constructor(
        address _stakedToken,
        address _bnkr,
        address _usdc,
        address _weth,
        address _swapRouter,
        address _vault,
        address _owner,
        uint256 _minBnkrBatch,
        address _initialKeeper
    ) Ownable2Step(_owner) {
        require(
            _stakedToken != address(0) && _bnkr != address(0) && _usdc != address(0) && _weth != address(0)
                && _swapRouter != address(0) && _vault != address(0),
            "zero address"
        );
        stakedToken = IERC20(_stakedToken);
        bnkr = IERC20(_bnkr);
        usdc = IERC20(_usdc);
        weth = _weth;
        swapRouter = ISwapRouter02(_swapRouter);
        vault = IStakedVault(_vault);
        liquidityWallet = _owner;
        bnkrStakingWallet = _owner;
        // Initial relay/keeper can be reviewed future CREATE addresses. There is
        // no bootstrap setter or timelock-disable switch after construction.
        keeper = _initialKeeper;
        minBnkrBatch = _minBnkrBatch;
        emit VaultUpdated(_vault);
        emit KeeperUpdated(_initialKeeper);
    }

    modifier onlyKeeperOrOwner() {
        require(msg.sender == keeper || msg.sender == owner, "not keeper");
        _;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------
    function undistributedStaked() public view returns (uint256) {
        return stakedToken.balanceOf(address(this));
    }

    function undistributedBnkr() public view returns (uint256) {
        uint256 bal = bnkr.balanceOf(address(this));
        return bal > pendingSwapBnkr ? bal - pendingSwapBnkr : 0;
    }

    function canSwap() external view returns (bool) {
        return pendingSwapBnkr >= minBnkrBatch && pendingSwapBnkr > 0;
    }

    function swapPath() public view returns (bytes memory) {
        return abi.encodePacked(address(bnkr), bnkrWethFee, weth, wethUsdcFee, address(usdc));
    }

    // ---------------------------------------------------------------------
    // Distribution
    // ---------------------------------------------------------------------
    /// @notice Pull fees from the caller (after approval) and distribute in one tx. Handy for the owner automation.
    function depositAndDistribute(uint256 stakedAmount, uint256 bnkrAmount) external nonReentrant {
        if (stakedAmount > 0) stakedToken.safeTransferFrom(msg.sender, address(this), stakedAmount);
        if (bnkrAmount > 0) bnkr.safeTransferFrom(msg.sender, address(this), bnkrAmount);
        _distributeStaked();
        _distributeBnkr();
    }

    /// @notice Split whatever is sitting in the contract. Permissionless — no swap happens here.
    function distribute() external nonReentrant {
        _distributeStaked();
        _distributeBnkr();
    }

    function _distributeStaked() internal {
        uint256 bal = stakedToken.balanceOf(address(this));
        if (bal == 0) return;
        uint256 burn = (bal * STAKED_BURN_BPS) / BPS;
        uint256 liq = bal - burn;
        totalStakedBurned += burn;
        totalStakedToLiquidity += liq;
        if (burn > 0) stakedToken.safeTransfer(DEAD, burn);
        if (liq > 0) stakedToken.safeTransfer(liquidityWallet, liq);
        emit StakedDistributed(burn, liq);
    }

    function _distributeBnkr() internal {
        uint256 avail = undistributedBnkr();
        if (avail == 0) return;
        uint256 toStaking = (avail * BNKR_STAKING_BPS) / BPS;
        uint256 toSwap = avail - toStaking;
        totalBnkrToStaking += toStaking;
        pendingSwapBnkr += toSwap;
        if (toStaking > 0) bnkr.safeTransfer(bnkrStakingWallet, toStaking);
        emit BnkrDistributed(toStaking, toSwap, pendingSwapBnkr);
    }

    /// @notice Identifies the bounded-batch interface required by the V3 keeper.
    function batchSwapVersion() external pure returns (uint256) { return 1; }

    /// @notice Legacy owner/keeper convenience path for the entire queue.
    /// @param minUsdcOut Minimum USDC out — keeper derives this off-chain from a fresh quote (slippage guard).
    function swapAndNotify(uint256 minUsdcOut) external nonReentrant onlyKeeperOrOwner returns (uint256 usdcOut) {
        return _swapAndNotify(pendingSwapBnkr, minUsdcOut);
    }

    /// @notice Swap exactly amountIn from the queue, retaining the rest for later batches.
    /// @dev Public donations can increase the queue but cannot change this call's chosen input.
    function swapBatchAndNotify(uint256 amountIn, uint256 minUsdcOut)
        external nonReentrant onlyKeeperOrOwner returns (uint256 usdcOut)
    {
        return _swapAndNotify(amountIn, minUsdcOut);
    }

    function _swapAndNotify(uint256 amountIn, uint256 minUsdcOut) private returns (uint256 usdcOut) {
        require(amountIn > 0 && amountIn >= minBnkrBatch, "below batch threshold");
        require(amountIn <= pendingSwapBnkr, "exceeds queue");
        require(minUsdcOut > 0, "minOut=0");
        pendingSwapBnkr -= amountIn;

        bnkr.safeApprove(address(swapRouter), amountIn);
        uint256 usdcBefore = usdc.balanceOf(address(this));
        swapRouter.exactInput(
            ISwapRouter02.ExactInputParams({
                path: swapPath(),
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minUsdcOut
            })
        );
        usdcOut = usdc.balanceOf(address(this)) - usdcBefore;
        bnkr.safeApprove(address(swapRouter), 0);
        require(usdcOut >= minUsdcOut, "slippage");

        totalBnkrSwapped += amountIn;
        totalUsdcToVault += usdcOut;

        usdc.safeApprove(address(vault), usdcOut);
        vault.notifyRewardAmount(address(usdc), usdcOut);
        usdc.safeApprove(address(vault), 0);

        emit SwappedAndNotified(amountIn, usdcOut);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------
    function setMinBnkrBatch(uint256 _threshold) external onlyOwner delayedConfiguration {
        minBnkrBatch = _threshold;
        emit MinBnkrBatchUpdated(_threshold);
    }

    function setPoolFees(uint24 _bnkrWethFee, uint24 _wethUsdcFee) external onlyOwner delayedConfiguration {
        bnkrWethFee = _bnkrWethFee;
        wethUsdcFee = _wethUsdcFee;
        emit PoolFeesUpdated(_bnkrWethFee, _wethUsdcFee);
    }

    function setVault(address _vault) external onlyOwner delayedConfiguration {
        require(_vault != address(0), "vault=0");
        vault = IStakedVault(_vault);
        emit VaultUpdated(_vault);
    }

    function setSwapRouter(address _router) external onlyOwner delayedConfiguration {
        require(_router != address(0), "router=0");
        swapRouter = ISwapRouter02(_router);
        emit RouterUpdated(_router);
    }

    function setLiquidityWallet(address _wallet) external onlyOwner delayedConfiguration {
        require(_wallet != address(0), "wallet=0");
        liquidityWallet = _wallet;
        emit LiquidityWalletUpdated(_wallet);
    }

    function setBnkrStakingWallet(address _wallet) external onlyOwner delayedConfiguration {
        require(_wallet != address(0), "wallet=0");
        bnkrStakingWallet = _wallet;
        emit BnkrStakingWalletUpdated(_wallet);
    }

    function setKeeper(address _keeper) external onlyOwner delayedConfiguration {
        keeper = _keeper;
        emit KeeperUpdated(_keeper);
    }

    /// @notice Rescue stray tokens. $STAKED can never be rescued (it is always burn/liquidity-bound), and BNKR
    ///         queued for the stakers' USDC leg (`pendingSwapBnkr`) is protected.
    function rescueToken(address token, uint256 amount, address to) external onlyOwner delayedConfiguration {
        require(token != address(stakedToken), "STAKED protected");
        if (token == address(bnkr)) require(amount <= undistributedBnkr(), "pending swap protected");
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, amount, to);
    }

    function _configurationOwner() internal view override returns (address) { return owner; }

    function _isDelayedConfiguration(bytes4 selector) internal pure override returns (bool) {
        return selector == this.setMinBnkrBatch.selector
            || selector == this.setPoolFees.selector
            || selector == this.setVault.selector
            || selector == this.setSwapRouter.selector
            || selector == this.setLiquidityWallet.selector
            || selector == this.setBnkrStakingWallet.selector
            || selector == this.setKeeper.selector
            || selector == this.rescueToken.selector;
    }
}
