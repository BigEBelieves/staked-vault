// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title StakedVault (v2)
 * @notice Dual-reward (USDC + BNKR) staking vault for $STAKED on Base.
 *
 *  - Staking token: $STAKED (0x731d4066a8375fc590fcd9dfe8d9e58670cb8ba3)
 *  - Reward tokens: USDC (6 dec) and BNKR (18 dec), streamed Synthetix-style over rolling 7-day windows
 *  - Lock: 7 days from the LAST deposit. Any top-up resets the timer for the wallet's entire balance.
 *  - Rewards accrue from day one but are only claimable once the lock has matured.
 *  - Early exit (withdraw before lockEnd):
 *      * 20% of the withdrawn principal is burned to 0xdead, 80% returned
 *      * 100% of accrued-but-unclaimed rewards are forfeited
 *      * forfeited USDC is moved into `buybackReserve`; the keeper executes a buy-and-burn of $STAKED through a
 *        pluggable IBuybackExecutor with a caller-supplied minimum output (slippage protection)
 *      * forfeited BNKR is re-streamed to the remaining stakers
 *  - Rewards that stream while nobody is staked are tracked in `undistributed` and can be re-streamed by anyone
 *
 *  Precision: reward rates are scaled by 1e18 and rewardPerToken by another 1e18 (1e36 total) so a 6-decimal
 *  reward token streamed against a 100B-supply 18-decimal staking token never rounds to zero.
 */

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IBuybackExecutor {
    /// @dev Must pull `usdcAmount` USDC from msg.sender (the vault approves first), swap it for $STAKED and
    ///      send the $STAKED back to msg.sender. The vault verifies the delivered amount against `minStakedOut`.
    function buyback(uint256 usdcAmount, uint256 minStakedOut) external returns (uint256 stakedOut);
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

contract StakedVault is Ownable2Step, ReentrancyGuard {
    using SafeERC20Lite for IERC20;

    // ---------------------------------------------------------------------
    // Immutables & constants
    // ---------------------------------------------------------------------
    IERC20 public immutable stakedToken;
    IERC20 public immutable usdc;
    IERC20 public immutable bnkr;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 public constant RATE_PRECISION = 1e18; // rewardRate is scaled by this
    uint256 public constant LOCK_DURATION = 7 days;
    uint256 public constant EARLY_EXIT_PENALTY_BPS = 2000; // 20%
    uint256 public constant BPS = 10_000;

    // ---------------------------------------------------------------------
    // Reward accounting
    // ---------------------------------------------------------------------
    struct Reward {
        uint256 periodFinish;
        uint256 rewardRate; // scaled by RATE_PRECISION (token-wei * 1e18 per second)
        uint256 lastUpdateTime;
        uint256 rewardPerTokenStored; // scaled by 1e36
        uint256 undistributed; // streamed while totalSupply == 0, or forfeited BNKR; re-streamable
    }

    uint256 public rewardsDuration = 7 days;
    mapping(address => Reward) public rewardData;
    mapping(address => mapping(address => uint256)) public userRewardPerTokenPaid;
    mapping(address => mapping(address => uint256)) public rewards;

    // ---------------------------------------------------------------------
    // Staking state
    // ---------------------------------------------------------------------
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public lockEnd;

    // ---------------------------------------------------------------------
    // Roles & buyback
    // ---------------------------------------------------------------------
    address public distributor;
    address public keeper;
    IBuybackExecutor public buybackExecutor;
    uint256 public buybackReserve; // USDC earmarked for buy-and-burn

    // Lifetime stats (for the frontend)
    uint256 public totalPenaltyBurned;
    uint256 public totalBuybackBurned;
    uint256 public totalUsdcForfeited;
    uint256 public totalBnkrForfeited;
    uint256 public totalUsdcSpentOnBuyback;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------
    event Staked(address indexed user, uint256 amount, uint256 newLockEnd);
    event Withdrawn(address indexed user, uint256 amount);
    event EarlyExit(address indexed user, uint256 amountRequested, uint256 amountReturned, uint256 penaltyBurned, uint256 usdcForfeited, uint256 bnkrForfeited);
    event RewardPaid(address indexed user, address indexed token, uint256 amount);
    event RewardAdded(address indexed token, uint256 amount, uint256 periodFinish);
    event UndistributedRestreamed(address indexed token, uint256 amount);
    event BuybackExecuted(address indexed keeper, uint256 usdcIn, uint256 stakedBurned);
    event DistributorUpdated(address distributor);
    event KeeperUpdated(address keeper);
    event BuybackExecutorUpdated(address executor);
    event RewardsDurationUpdated(uint256 duration);
    event Recovered(address token, uint256 amount);

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------
    constructor(address _stakedToken, address _usdc, address _bnkr, address _owner) Ownable2Step(_owner) {
        require(_stakedToken != address(0) && _usdc != address(0) && _bnkr != address(0), "token=0");
        require(_stakedToken != _usdc && _stakedToken != _bnkr && _usdc != _bnkr, "dup token");
        stakedToken = IERC20(_stakedToken);
        usdc = IERC20(_usdc);
        bnkr = IERC20(_bnkr);
    }

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------
    modifier updateReward(address account) {
        _updateReward(address(usdc), account);
        _updateReward(address(bnkr), account);
        _;
    }

    modifier onlyKeeperOrOwner() {
        require(msg.sender == keeper || msg.sender == owner, "not keeper");
        _;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------
    function isRewardToken(address token) public view returns (bool) {
        return token == address(usdc) || token == address(bnkr);
    }

    function lastTimeRewardApplicable(address token) public view returns (uint256) {
        uint256 finish = rewardData[token].periodFinish;
        return block.timestamp < finish ? block.timestamp : finish;
    }

    function rewardPerToken(address token) public view returns (uint256) {
        Reward storage r = rewardData[token];
        if (totalSupply == 0) return r.rewardPerTokenStored;
        uint256 dt = lastTimeRewardApplicable(token) - r.lastUpdateTime;
        return r.rewardPerTokenStored + (dt * r.rewardRate * 1e18) / totalSupply;
    }

    function earned(address token, address account) public view returns (uint256) {
        return (balanceOf[account] * (rewardPerToken(token) - userRewardPerTokenPaid[token][account])) / 1e36
            + rewards[token][account];
    }

    /// @notice Tokens streamed per full rewardsDuration at the current rate (unscaled token units).
    function getRewardForDuration(address token) external view returns (uint256) {
        return (rewardData[token].rewardRate * rewardsDuration) / RATE_PRECISION;
    }

    /// @notice Tokens streamed per second at the current rate, scaled by 1e18 (for APR math on the frontend).
    function rewardRatePerSecond(address token) external view returns (uint256) {
        return block.timestamp < rewardData[token].periodFinish ? rewardData[token].rewardRate : 0;
    }

    function isLocked(address account) public view returns (bool) {
        return block.timestamp < lockEnd[account];
    }

    function timeUntilUnlock(address account) external view returns (uint256) {
        return block.timestamp < lockEnd[account] ? lockEnd[account] - block.timestamp : 0;
    }

    /// @notice What a wallet would receive / lose if it withdrew `amount` right now.
    function previewWithdraw(address account, uint256 amount)
        external
        view
        returns (uint256 returned, uint256 penalty, uint256 usdcForfeited, uint256 bnkrForfeited)
    {
        if (block.timestamp >= lockEnd[account]) return (amount, 0, 0, 0);
        penalty = (amount * EARLY_EXIT_PENALTY_BPS) / BPS;
        returned = amount - penalty;
        usdcForfeited = earned(address(usdc), account);
        bnkrForfeited = earned(address(bnkr), account);
    }

    // ---------------------------------------------------------------------
    // User actions
    // ---------------------------------------------------------------------
    function stake(uint256 amount) external nonReentrant updateReward(msg.sender) {
        require(amount > 0, "amount=0");
        uint256 before = stakedToken.balanceOf(address(this));
        stakedToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = stakedToken.balanceOf(address(this)) - before;
        require(received > 0, "nothing received");

        totalSupply += received;
        balanceOf[msg.sender] += received;
        uint256 newLockEnd = block.timestamp + LOCK_DURATION;
        lockEnd[msg.sender] = newLockEnd;
        emit Staked(msg.sender, received, newLockEnd);
    }

    /// @notice Withdraw principal. Before lockEnd this is an early exit: 20% burned + all accrued rewards forfeited.
    function withdraw(uint256 amount) external nonReentrant updateReward(msg.sender) {
        _withdraw(amount);
    }

    /// @notice Claim accrued USDC + BNKR. Only possible once the 7-day lock has matured.
    function getReward() external nonReentrant updateReward(msg.sender) {
        _getReward();
    }

    /// @notice Withdraw everything and (if unlocked) claim rewards in one tx.
    function exit() external nonReentrant updateReward(msg.sender) {
        _withdraw(balanceOf[msg.sender]);
        if (block.timestamp >= lockEnd[msg.sender]) _getReward();
    }

    function _withdraw(uint256 amount) internal {
        require(amount > 0, "amount=0");
        require(amount <= balanceOf[msg.sender], "exceeds balance");

        totalSupply -= amount;
        balanceOf[msg.sender] -= amount;

        if (block.timestamp >= lockEnd[msg.sender]) {
            stakedToken.safeTransfer(msg.sender, amount);
            emit Withdrawn(msg.sender, amount);
            return;
        }

        // ---- early exit ----
        uint256 penalty = (amount * EARLY_EXIT_PENALTY_BPS) / BPS;
        uint256 returned = amount - penalty;

        uint256 usdcForfeited = rewards[address(usdc)][msg.sender];
        uint256 bnkrForfeited = rewards[address(bnkr)][msg.sender];
        rewards[address(usdc)][msg.sender] = 0;
        rewards[address(bnkr)][msg.sender] = 0;

        buybackReserve += usdcForfeited; // USDC stays in the vault, earmarked for buy-and-burn
        rewardData[address(bnkr)].undistributed += bnkrForfeited; // re-streamed to loyal stakers
        totalPenaltyBurned += penalty;
        totalUsdcForfeited += usdcForfeited;
        totalBnkrForfeited += bnkrForfeited;

        if (penalty > 0) stakedToken.safeTransfer(DEAD, penalty);
        stakedToken.safeTransfer(msg.sender, returned);
        emit EarlyExit(msg.sender, amount, returned, penalty, usdcForfeited, bnkrForfeited);
    }

    function _getReward() internal {
        require(block.timestamp >= lockEnd[msg.sender], "locked");
        uint256 u = rewards[address(usdc)][msg.sender];
        if (u > 0) {
            rewards[address(usdc)][msg.sender] = 0;
            usdc.safeTransfer(msg.sender, u);
            emit RewardPaid(msg.sender, address(usdc), u);
        }
        uint256 b = rewards[address(bnkr)][msg.sender];
        if (b > 0) {
            rewards[address(bnkr)][msg.sender] = 0;
            bnkr.safeTransfer(msg.sender, b);
            emit RewardPaid(msg.sender, address(bnkr), b);
        }
    }

    // ---------------------------------------------------------------------
    // Reward funding
    // ---------------------------------------------------------------------
    /// @notice Pull `amount` of `token` from the caller and stream it over rewardsDuration.
    ///         Callable by the distributor (USDC leg) or the owner (BNKR staking yield leg).
    function notifyRewardAmount(address token, uint256 amount) external nonReentrant updateReward(address(0)) {
        require(msg.sender == distributor || msg.sender == owner, "not authorized");
        require(isRewardToken(token), "not reward token");
        require(amount > 0, "amount=0");
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        _notifyReward(token, received);
    }

    /// @notice Re-stream rewards that accrued while nobody was staked (or forfeited BNKR). Permissionless.
    function restreamUndistributed(address token) external nonReentrant updateReward(address(0)) {
        require(isRewardToken(token), "not reward token");
        uint256 amount = rewardData[token].undistributed;
        require(amount > 0, "nothing to restream");
        rewardData[token].undistributed = 0;
        _notifyReward(token, amount);
        emit UndistributedRestreamed(token, amount);
    }

    function _notifyReward(address token, uint256 reward) internal {
        Reward storage r = rewardData[token];
        uint256 scaled = reward * RATE_PRECISION;
        if (block.timestamp >= r.periodFinish) {
            r.rewardRate = scaled / rewardsDuration;
        } else {
            uint256 leftover = (r.periodFinish - block.timestamp) * r.rewardRate;
            r.rewardRate = (scaled + leftover) / rewardsDuration;
        }

        // Solvency sanity check: the stream for the whole duration must be backed by un-earmarked balance.
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 earmarked = r.undistributed + (token == address(usdc) ? buybackReserve : 0);
        uint256 available = balance > earmarked ? balance - earmarked : 0;
        require((r.rewardRate * rewardsDuration) / RATE_PRECISION <= available, "reward > balance");

        r.lastUpdateTime = block.timestamp;
        r.periodFinish = block.timestamp + rewardsDuration;
        emit RewardAdded(token, reward, r.periodFinish);
    }

    function _updateReward(address token, address account) internal {
        Reward storage r = rewardData[token];
        uint256 applicable = lastTimeRewardApplicable(token);
        if (totalSupply == 0) {
            if (applicable > r.lastUpdateTime) {
                r.undistributed += ((applicable - r.lastUpdateTime) * r.rewardRate) / RATE_PRECISION;
            }
        } else {
            r.rewardPerTokenStored = rewardPerToken(token);
        }
        r.lastUpdateTime = applicable;
        if (account != address(0)) {
            rewards[token][account] = earned(token, account);
            userRewardPerTokenPaid[token][account] = r.rewardPerTokenStored;
        }
    }

    // ---------------------------------------------------------------------
    // Buy-and-burn (keeper)
    // ---------------------------------------------------------------------
    /// @notice Spend `usdcAmount` of the buyback reserve on $STAKED via the executor and burn it.
    /// @param minStakedOut Minimum $STAKED the executor must deliver (keeper computes off-chain from a quote).
    function executeBuyback(uint256 usdcAmount, uint256 minStakedOut) external nonReentrant onlyKeeperOrOwner {
        require(address(buybackExecutor) != address(0), "executor unset");
        require(usdcAmount > 0 && usdcAmount <= buybackReserve, "bad amount");
        require(minStakedOut > 0, "minOut=0");

        buybackReserve -= usdcAmount;
        uint256 usdcBefore = usdc.balanceOf(address(this));
        uint256 stakedBefore = stakedToken.balanceOf(address(this));

        usdc.safeApprove(address(buybackExecutor), usdcAmount);
        buybackExecutor.buyback(usdcAmount, minStakedOut);
        usdc.safeApprove(address(buybackExecutor), 0);

        require(usdcBefore - usdc.balanceOf(address(this)) == usdcAmount, "usdc not consumed");
        uint256 delivered = stakedToken.balanceOf(address(this)) - stakedBefore;
        require(delivered >= minStakedOut, "slippage");

        totalBuybackBurned += delivered;
        totalUsdcSpentOnBuyback += usdcAmount;
        stakedToken.safeTransfer(DEAD, delivered);
        emit BuybackExecuted(msg.sender, usdcAmount, delivered);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------
    function setDistributor(address _distributor) external onlyOwner {
        distributor = _distributor;
        emit DistributorUpdated(_distributor);
    }

    function setKeeper(address _keeper) external onlyOwner {
        keeper = _keeper;
        emit KeeperUpdated(_keeper);
    }

    function setBuybackExecutor(address _executor) external onlyOwner {
        buybackExecutor = IBuybackExecutor(_executor);
        emit BuybackExecutorUpdated(_executor);
    }

    /// @dev Only when both streams are finished, so an in-flight stream cannot be shortened or stretched.
    function setRewardsDuration(uint256 _duration) external onlyOwner {
        require(_duration >= 1 days && _duration <= 90 days, "bad duration");
        require(
            block.timestamp >= rewardData[address(usdc)].periodFinish
                && block.timestamp >= rewardData[address(bnkr)].periodFinish,
            "period active"
        );
        rewardsDuration = _duration;
        emit RewardsDurationUpdated(_duration);
    }

    /// @notice Recover tokens sent here by mistake. Staking and reward tokens can never be pulled.
    function recoverERC20(address token, uint256 amount, address to) external onlyOwner {
        require(token != address(stakedToken) && !isRewardToken(token), "protected");
        IERC20(token).safeTransfer(to, amount);
        emit Recovered(token, amount);
    }
}
