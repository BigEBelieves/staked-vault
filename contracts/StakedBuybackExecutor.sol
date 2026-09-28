// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title StakedBuybackExecutor
 * @notice Pluggable buyback executor for StakedVault. Converts forfeited USDC into $STAKED and hands it back to the
 *         caller (the vault burns it). Route: USDC -> WETH -> BNKR on Uniswap v3 (SwapRouter02 exactInput), then
 *         BNKR -> STAKED on the Uniswap v4 STAKED/BNKR pool by calling the PoolManager directly (unlock/swap/settle/take).
 *         Every hop is a real buy on the v4 pool, so each early exit becomes buy pressure on $STAKED before the burn.
 * @dev    Stateless between calls. buyback() pulls USDC from msg.sender, so it can only ever spend what the caller approved.
 *         The vault enforces minStakedOut on delivery; this contract enforces it as well so a bad route reverts here first.
 */

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface ISwapRouter02 {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }
    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

interface IPoolManager {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }
    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
    }
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 delta);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

interface IBuybackExecutor {
    function buyback(uint256 usdcAmount, uint256 minStakedOut) external returns (uint256 stakedOut);
}

contract StakedBuybackExecutor is IBuybackExecutor {
    // ---------------------------------------------------------------------
    // Immutables
    // ---------------------------------------------------------------------
    IERC20 public immutable usdc;
    IERC20 public immutable weth;
    IERC20 public immutable bnkr;
    IERC20 public immutable staked;
    ISwapRouter02 public immutable router;
    IPoolManager public immutable poolManager;

    /// @dev v4 pool key for STAKED/BNKR. currency0 = BNKR, currency1 = STAKED (sorted by address).
    IPoolManager.PoolKey public poolKey;
    bool public immutable bnkrIsCurrency0;

    // v3 fee tiers for the USDC -> WETH -> BNKR leg. Owner-tunable if liquidity migrates.
    uint24 public feeUsdcWeth;
    uint24 public feeWethBnkr;

    address public owner;
    address public pendingOwner;

    // v4 price limits (TickMath.MIN_SQRT_PRICE + 1 / MAX_SQRT_PRICE - 1)
    uint160 internal constant MIN_SQRT_PRICE_LIMIT = 4295128740;
    uint160 internal constant MAX_SQRT_PRICE_LIMIT = 1461446703485210103287273052203988822378723970341;

    uint256 public totalUsdcIn;
    uint256 public totalStakedOut;

    event Buyback(address indexed caller, uint256 usdcIn, uint256 bnkrMid, uint256 stakedOut);
    event FeesUpdated(uint24 feeUsdcWeth, uint24 feeWethBnkr);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotPoolManager();
    error ZeroAmount();
    error Slippage(uint256 got, uint256 want);
    error TransferFailed();
    error Reentrancy();

    uint256 private _locked;
    modifier nonReentrant() {
        if (_locked == 2) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 0;
    }
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address _usdc,
        address _weth,
        address _bnkr,
        address _staked,
        address _router,
        address _poolManager,
        uint24 _v4Fee,
        int24 _v4TickSpacing,
        address _v4Hooks,
        uint24 _feeUsdcWeth,
        uint24 _feeWethBnkr,
        address _owner
    ) {
        require(_usdc != address(0) && _weth != address(0) && _bnkr != address(0) && _staked != address(0), "zero token");
        require(_router != address(0) && _poolManager != address(0) && _owner != address(0), "zero addr");
        usdc = IERC20(_usdc);
        weth = IERC20(_weth);
        bnkr = IERC20(_bnkr);
        staked = IERC20(_staked);
        router = ISwapRouter02(_router);
        poolManager = IPoolManager(_poolManager);

        bool bnkrFirst = _bnkr < _staked;
        bnkrIsCurrency0 = bnkrFirst;
        poolKey = IPoolManager.PoolKey({
            currency0: bnkrFirst ? _bnkr : _staked,
            currency1: bnkrFirst ? _staked : _bnkr,
            fee: _v4Fee,
            tickSpacing: _v4TickSpacing,
            hooks: _v4Hooks
        });
        feeUsdcWeth = _feeUsdcWeth;
        feeWethBnkr = _feeWethBnkr;
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
    }

    // ---------------------------------------------------------------------
    // Buyback
    // ---------------------------------------------------------------------

    /// @inheritdoc IBuybackExecutor
    function buyback(uint256 usdcAmount, uint256 minStakedOut) external nonReentrant returns (uint256 stakedOut) {
        if (usdcAmount == 0) revert ZeroAmount();

        // 1. pull USDC from caller (vault approves exactly usdcAmount before calling)
        _safeTransferFrom(usdc, msg.sender, address(this), usdcAmount);

        // 2. USDC -> WETH -> BNKR on v3
        _safeApprove(usdc, address(router), usdcAmount);
        uint256 bnkrBefore = bnkr.balanceOf(address(this));
        router.exactInput(
            ISwapRouter02.ExactInputParams({
                path: abi.encodePacked(address(usdc), feeUsdcWeth, address(weth), feeWethBnkr, address(bnkr)),
                recipient: address(this),
                amountIn: usdcAmount,
                amountOutMinimum: 0 // final slippage check is on STAKED delivered
            })
        );
        _safeApprove(usdc, address(router), 0);
        uint256 bnkrOut = bnkr.balanceOf(address(this)) - bnkrBefore;
        if (bnkrOut == 0) revert ZeroAmount();

        // 3. BNKR -> STAKED on the v4 pool, delivered straight to the caller
        bytes memory result = poolManager.unlock(abi.encode(bnkrOut, msg.sender));
        stakedOut = abi.decode(result, (uint256));
        if (stakedOut < minStakedOut) revert Slippage(stakedOut, minStakedOut);

        totalUsdcIn += usdcAmount;
        totalStakedOut += stakedOut;
        emit Buyback(msg.sender, usdcAmount, bnkrOut, stakedOut);
    }

    /// @dev Called by the PoolManager inside unlock(). Performs the swap and settles both sides.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint256 bnkrIn, address recipient) = abi.decode(data, (uint256, address));

        bool zeroForOne = bnkrIsCurrency0; // selling BNKR for STAKED
        int256 delta = poolManager.swap(
            poolKey,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(bnkrIn), // exact input (negative in v4)
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE_LIMIT : MAX_SQRT_PRICE_LIMIT
            }),
            ""
        );

        // BalanceDelta packs amount0 in the upper 128 bits and amount1 in the lower 128 bits.
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(delta);
        (int128 owed, int128 received) = zeroForOne ? (amount0, amount1) : (amount1, amount0);
        require(owed < 0 && received > 0, "bad delta");

        // pay BNKR in: sync -> transfer -> settle
        address bnkrCurrency = address(bnkr);
        poolManager.sync(bnkrCurrency);
        _safeTransfer(bnkr, address(poolManager), uint256(uint128(-owed)));
        poolManager.settle();

        // take STAKED out directly to the recipient (the vault)
        uint256 out = uint256(uint128(received));
        poolManager.take(address(staked), recipient, out);

        return abi.encode(out);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------
    function setV3Fees(uint24 _feeUsdcWeth, uint24 _feeWethBnkr) external onlyOwner {
        feeUsdcWeth = _feeUsdcWeth;
        feeWethBnkr = _feeWethBnkr;
        emit FeesUpdated(_feeUsdcWeth, _feeWethBnkr);
    }

    /// @notice Nothing should ever sit here between calls; lets the owner sweep dust or mistaken sends.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        _safeTransfer(IERC20(token), to, amount);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending");
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ---------------------------------------------------------------------
    // Internal safe-ERC20 helpers (USDC on Base returns bool; STAKED/BNKR are standard)
    // ---------------------------------------------------------------------
    function _safeTransfer(IERC20 token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = address(token).call(abi.encodeWithSelector(token.transfer.selector, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(IERC20 token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) =
            address(token).call(abi.encodeWithSelector(token.transferFrom.selector, from, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function _safeApprove(IERC20 token, address spender, uint256 amount) internal {
        (bool ok, bytes memory ret) = address(token).call(abi.encodeWithSelector(token.approve.selector, spender, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
