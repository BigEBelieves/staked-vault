// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title StakedDistributor (v2)
 * @notice Automated fee router for $STAKED trading fees (paid in $STAKED and $BNKR).
 *
 *  $STAKED fees  : 50% burned to 0xdead, 50% to `liquidityWallet` (liquidity deepening)
 *  $BNKR fees    : 50% to `bnkrStakingWallet` (staked in Bankr; yield is fed back to the vault as BNKR rewards)
 *                  50% parked in `pendingSwapBnkr` until it reaches `minBnkrBatch`, then swapped to USDC
 *                  BNKR -> WETH -> USDC on Uniswap V3 (SwapRouter02) and streamed to StakedVault.
 *
 *  `distribute()` (the 50/50 splits) is permissionless. `swapAndNotify(minUsdcOut)` is keeper-gated and requires
 *  a caller-supplied minimum output so a permissionless poke can never be sandwiched.
 *  `pendingSwapBnkr` is accounted separately, so a failed / delayed swap never lets the staking wallet's share
 *  be split a second time.
 */

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @dev Uniswap V3 SwapRouter02 (Base: 0x2626664c2603336E57B271c5C0b26F421741e481) — exactInput has no deadline field.
interface ISwapRouter02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

interface IStakedVault {
    function notifyRewardAmount(address token, uint256 amount) external;
}

library SafeERC20Lite {
    function safeTransfer(IERC20 token, address to, uint256 amount) internal {
        _call(address(token), abi.encodeWithSelector(token.transfer.selector, to, amount));
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 amount) internal {
        _call(address(token), abi.encodeWithSelector(token.transferFrom.selector, from, to, amount));
    }

    function safeApprove(IERC20 token, address spender, uint256 amount) internal {
        _call(address(token), abi.encodeWithSelector(token.approve.selector, spender, amount));
    }

    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "SafeERC20: operation failed");
    }
}

abstract contract Ownable2Step {
    address public owner;
    address public pendingOwner;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(address initialOwner) {
        require(initialOwner != address(0), "owner=0");
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending owner");
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }
}

abstract contract ReentrancyGuard {
    uint256 private _status = 1;

    modifier nonReentrant() {
        require(_status == 1, "reentrant");
        _status = 2;
        _;
        _status = 1;
    }
}

contract StakedDistributor is Ownable2Step, ReentrancyGuard {
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
        uint256 _minBnkrBatch
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
        keeper = _owner;
        minBnkrBatch = _minBnkrBatch;
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

    /// @notice Swap the queued BNKR batch to USDC and stream it into the vault.
    /// @param minUsdcOut Minimum USDC out — keeper derives this off-chain from a fresh quote (slippage guard).
    function swapAndNotify(uint256 minUsdcOut) external nonReentrant onlyKeeperOrOwner returns (uint256 usdcOut) {
        uint256 amountIn = pendingSwapBnkr;
        require(amountIn > 0 && amountIn >= minBnkrBatch, "below batch threshold");
        require(minUsdcOut > 0, "minOut=0");
        pendingSwapBnkr = 0;

        bnkr.safeApprove(address(swapRouter), amountIn);
        usdcOut = swapRouter.exactInput(
            ISwapRouter02.ExactInputParams({
                path: swapPath(),
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minUsdcOut
            })
        );
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
    function setMinBnkrBatch(uint256 _threshold) external onlyOwner {
        minBnkrBatch = _threshold;
        emit MinBnkrBatchUpdated(_threshold);
    }

    function setPoolFees(uint24 _bnkrWethFee, uint24 _wethUsdcFee) external onlyOwner {
        bnkrWethFee = _bnkrWethFee;
        wethUsdcFee = _wethUsdcFee;
        emit PoolFeesUpdated(_bnkrWethFee, _wethUsdcFee);
    }

    function setVault(address _vault) external onlyOwner {
        require(_vault != address(0), "vault=0");
        vault = IStakedVault(_vault);
        emit VaultUpdated(_vault);
    }

    function setSwapRouter(address _router) external onlyOwner {
        require(_router != address(0), "router=0");
        swapRouter = ISwapRouter02(_router);
        emit RouterUpdated(_router);
    }

    function setLiquidityWallet(address _wallet) external onlyOwner {
        require(_wallet != address(0), "wallet=0");
        liquidityWallet = _wallet;
        emit LiquidityWalletUpdated(_wallet);
    }

    function setBnkrStakingWallet(address _wallet) external onlyOwner {
        require(_wallet != address(0), "wallet=0");
        bnkrStakingWallet = _wallet;
        emit BnkrStakingWalletUpdated(_wallet);
    }

    function setKeeper(address _keeper) external onlyOwner {
        keeper = _keeper;
        emit KeeperUpdated(_keeper);
    }

    /// @notice Rescue stray tokens. $STAKED can never be rescued (it is always burn/liquidity-bound), and BNKR
    ///         queued for the stakers' USDC leg (`pendingSwapBnkr`) is protected.
    function rescueToken(address token, uint256 amount, address to) external onlyOwner {
        require(token != address(stakedToken), "STAKED protected");
        if (token == address(bnkr)) require(amount <= undistributedBnkr(), "pending swap protected");
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, amount, to);
    }
}
