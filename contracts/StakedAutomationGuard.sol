// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import "./AutomationSupport.sol";

interface BoundBuybackExecutor {
    function guard() external view returns (address);
    function vault() external view returns (address);
}

/// @notice Safe-approved expiring references and cumulative budgets for the existing deployments.
/// @dev These are governed limit orders, NOT a TWAP oracle. A Safe must independently validate references.
contract StakedAutomationGuard is SafeAuthority {
    struct Quote { uint128 amountIn; uint128 amountOut; }
    struct Policy {
        Quote distribution;
        Quote buybackV3;
        Quote buybackTotal;
        uint128 maxBnkrPerSwap;
        uint128 maxUsdcPerBuyback;
        uint128 bnkrBudget;
        uint128 usdcBudget;
        uint160 sqrtPriceLimitX96;
        uint48 validUntil;
        uint16 slippageBps;
    }
    address public immutable vault;
    address public immutable distributor;
    address public operator;
    address public executor;
    bool public paused = true;
    Policy public policy;
    uint256 public nonce;
    uint256 public remainingBnkr;
    uint256 public remainingUsdc;
    uint256 public constant MAX_POLICY_AGE = 1 hours;
    uint256 public constant MAX_QUOTE_BLOCKS = 2;
    uint256 public constant MAX_DEADLINE = 60 seconds;
    uint160 private constant MIN_SQRT = 4295128740;
    uint160 private constant MAX_SQRT = 1461446703485210103287273052203988822378723970341;
    bool private buying;
    uint256 private activeAmount;
    uint256 private activeMinimum;
    uint256 private activeBnkrMinimum;

    event OperatorUpdated(address indexed operator);
    event ExecutorUpdated(address indexed executor);
    event PolicyUpdated(uint256 indexed nonce, Policy policy);
    event Paused(bool paused);
    event Executed(uint256 indexed nonce, bool buyback, uint256 amountIn, uint256 minimumOut);

    constructor(address safe_, address vault_, address distributor_) SafeAuthority(safe_) {
        require(vault_.code.length > 0 && distributor_.code.length > 0, "missing contract");
        vault = vault_;
        distributor = distributor_;
    }

    function setOperator(address operator_) external onlySafe {
        operator = operator_;
        nonce++;
        emit OperatorUpdated(operator_);
    }

    function setExecutor(address executor_) external onlySafe {
        require(paused && executor_.code.length > 0, "pause first / bad executor");
        require(BoundBuybackExecutor(executor_).guard() == address(this), "wrong guard");
        require(BoundBuybackExecutor(executor_).vault() == vault, "wrong vault");
        executor = executor_;
        nonce++;
        emit ExecutorUpdated(executor_);
    }

    function setPolicy(Policy calldata p) external onlySafe {
        require(p.validUntil > block.timestamp && p.validUntil <= block.timestamp + MAX_POLICY_AGE, "bad expiry");
        require(p.slippageBps <= 100, "slippage > 1%");
        require(p.distribution.amountIn > 0 && p.distribution.amountOut > 0, "bad distribution quote");
        require(p.buybackV3.amountIn > 0 && p.buybackV3.amountOut > 0, "bad v3 quote");
        require(p.buybackTotal.amountIn > 0 && p.buybackTotal.amountOut > 0, "bad total quote");
        require(p.maxBnkrPerSwap > 0 && p.maxUsdcPerBuyback > 0, "zero cap");
        // Reject the old unrestricted extremes. Safe must choose a meaningful pool-specific limit.
        require(p.sqrtPriceLimitX96 > MIN_SQRT && p.sqrtPriceLimitX96 < MAX_SQRT, "unbounded v4 price");
        policy = p;
        remainingBnkr = p.bnkrBudget;
        remainingUsdc = p.usdcBudget;
        nonce++;
        emit PolicyUpdated(nonce, p);
    }

    function setPaused(bool value) external {
        require(msg.sender == safe || (msg.sender == operator && value), "not Safe");
        if (!value) require(policy.validUntil > block.timestamp && executor != address(0), "not configured");
        paused = value;
        nonce++;
        emit Paused(value);
    }

    function distributionFloor(uint256 amount) public view returns (uint256) { return _floor(amount, policy.distribution); }
    function buybackV3Floor(uint256 amount) public view returns (uint256) { return _floor(amount, policy.buybackV3); }
    function buybackFloor(uint256 amount) public view returns (uint256) { return _floor(amount, policy.buybackTotal); }

    function swapAndNotify(uint128 expectedAmount, uint256 minimum, uint64 quoteBlock, uint48 deadline, uint256 expectedNonce)
        external nonReentrant returns (uint256)
    {
        _check(quoteBlock, deadline, expectedNonce);
        require(expectedAmount > 0 && expectedAmount == AutomationDistributor(distributor).pendingSwapBnkr(), "batch changed");
        require(expectedAmount <= policy.maxBnkrPerSwap && expectedAmount <= remainingBnkr, "BNKR cap");
        require(minimum >= distributionFloor(expectedAmount), "below Safe floor");
        remainingBnkr -= expectedAmount;
        nonce++;
        uint256 out = AutomationDistributor(distributor).swapAndNotify(minimum);
        emit Executed(expectedNonce, false, expectedAmount, minimum);
        return out;
    }

    function executeBuyback(uint128 amount, uint256 minBnkr, uint256 minStaked, uint64 quoteBlock, uint48 deadline, uint256 expectedNonce)
        external nonReentrant
    {
        _check(quoteBlock, deadline, expectedNonce);
        require(amount > 0 && amount <= policy.maxUsdcPerBuyback && amount <= remainingUsdc, "USDC cap");
        require(minBnkr >= buybackV3Floor(amount) && minStaked >= buybackFloor(amount), "below Safe floor");
        require(executor != address(0) && AutomationVault(vault).buybackExecutor() == executor, "executor changed");
        remainingUsdc -= amount;
        nonce++;
        buying = true;
        activeAmount = amount;
        activeMinimum = minStaked;
        activeBnkrMinimum = minBnkr;
        AutomationVault(vault).executeBuyback(amount, minStaked);
        buying = false;
        delete activeAmount;
        delete activeMinimum;
        delete activeBnkrMinimum;
        emit Executed(expectedNonce, true, amount, minStaked);
    }

    /// @notice Only the bound executor, during this guard's active buyback, may retrieve execution terms.
    function buybackTerms(uint256 amount, uint256 minimum) external view returns (uint256, uint160) {
        require(buying && msg.sender == executor, "no active buyback");
        require(amount == activeAmount && minimum == activeMinimum, "terms changed");
        return (activeBnkrMinimum, policy.sqrtPriceLimitX96);
    }

    function _check(uint64 quoteBlock, uint48 deadline, uint256 expectedNonce) private view {
        require(msg.sender == operator || msg.sender == safe, "not operator");
        require(!paused && block.timestamp <= policy.validUntil, "paused or expired");
        require(expectedNonce == nonce, "stale nonce");
        require(quoteBlock <= block.number && block.number - quoteBlock <= MAX_QUOTE_BLOCKS, "stale quote block");
        require(deadline >= block.timestamp && deadline <= block.timestamp + MAX_DEADLINE, "bad deadline");
    }

    function _floor(uint256 amount, Quote memory q) private view returns (uint256) {
        require(amount > 0 && amount <= type(uint128).max && q.amountIn > 0, "bad floor input");
        // Products of two uint128 values fit uint256; round UP so dust cannot round the floor to zero.
        uint256 numerator = amount * uint256(q.amountOut);
        uint256 quoted = numerator / q.amountIn + (numerator % q.amountIn == 0 ? 0 : 1);
        require(quoted <= type(uint128).max, "quote overflow");
        uint256 adjusted = quoted * (10_000 - policy.slippageBps);
        return adjusted / 10_000 + (adjusted % 10_000 == 0 ? 0 : 1);
    }
}
