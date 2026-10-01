// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import "./AutomationSupport.sol";
import "./ConfigurationDelay.sol";

/// @dev Interface checked against BnkrStakingV3 on Base, 0x88470240FF0663Faefa68B1D7621b472DdD9584A.
interface BankrStakingV3 {
    function stakingToken() external view returns (address);
    function rewardsToken() external view returns (address);
    function stakeOf(address account) external view returns (uint256);
    function stake(uint256 amount) external;
    function getReward() external returns (uint256);
    function requestUnstake(uint256 amount) external returns (uint64);
    function withdraw() external returns (uint256);
    function advance(uint32 maxDays) external;
}
interface BankrYieldRelay {
    function bnkr() external view returns (address);
    function safe() external view returns (address);
    function relayBnkr(uint256 amount) external;
}

/// @notice Holds protocol fee principal separately from claimed yield. No access to any wallet's tokens.
/// @dev Deploys paused with zero operator/limits. Safe schedules policy with a fixed 48h notice.
contract StakedBankrStakingAdapter is SafeAuthority, ConfigurationDelay {
    using AutomationTransfer for address;
    address public immutable bnkr;
    BankrStakingV3 public immutable staking;
    BankrYieldRelay public immutable relay;
    bytes32 public immutable stakingCodeHash;
    address public operator;
    bool public paused = true;
    uint256 public constant INTERVAL = 1 days;
    uint256 public maxStakePerDay;
    uint256 public maxPrincipal;
    uint256 public coolingPrincipal;
    uint256 public pendingYield;
    uint256 public lastStake;
    uint256 public lastHarvest;
    uint256 public lastRelay;
    uint256 public totalStaked;
    uint256 public totalYieldClaimed;
    uint256 public totalYieldRelayed;
    event PolicySet(address operator, uint256 maxStakePerDay, uint256 maxPrincipal);
    event PauseSet(bool paused);
    event PrincipalStaked(uint256 amount);
    event YieldClaimed(uint256 amount);
    event YieldRelayed(uint256 amount);
    event UnstakeRequested(uint64 id, uint256 amount);
    event PrincipalReturned(uint256 amount);

    constructor(address safe_, address bnkr_, address staking_, address relay_) SafeAuthority(safe_) {
        require(bnkr_.code.length > 0 && staking_.code.length > 0 && relay_.code.length > 0, "missing contract");
        require(staking_ != relay_, "same target");
        require(BankrStakingV3(staking_).stakingToken() == bnkr_ && BankrStakingV3(staking_).rewardsToken() == bnkr_, "wrong staking token");
        require(BankrYieldRelay(relay_).bnkr() == bnkr_ && BankrYieldRelay(relay_).safe() == safe_, "wrong relay");
        bnkr = bnkr_; staking = BankrStakingV3(staking_); relay = BankrYieldRelay(relay_);
        stakingCodeHash = staking_.codehash;
    }
    modifier onlyOperatorOrSafe() { require(msg.sender == operator || msg.sender == safe, "not operator"); _; }
    modifier running() { require(!paused, "paused"); _; }
    modifier checkedStaking() { require(address(staking).codehash == stakingCodeHash, "staking code changed"); _; }

    function setPolicy(address operator_, uint256 daily_, uint256 principal_) external onlySafe delayedConfiguration {
        require(operator_ != address(0) && operator_ != address(this), "bad operator");
        require(daily_ > 0 && principal_ >= daily_, "bad limits");
        operator = operator_; maxStakePerDay = daily_; maxPrincipal = principal_;
        emit PolicySet(operator_, daily_, principal_);
    }
    /// @notice Operator may stop deposits; only Safe can restart. Harvest/recovery remain available while paused.
    function setPaused(bool value) external onlyOperatorOrSafe {
        if (!value) require(msg.sender == safe && operator != address(0) && maxStakePerDay > 0, "Safe policy required");
        paused = value; emit PauseSet(value);
    }
    function idlePrincipal() public view returns (uint256) {
        return AutomationToken(bnkr).balanceOf(address(this)) - pendingYield;
    }
    function stakeFees(uint256 amount) external onlyOperatorOrSafe running nonReentrant checkedStaking {
        require(amount > 0 && amount <= maxStakePerDay, "stake limit");
        require(lastStake == 0 || block.timestamp >= lastStake + INTERVAL, "stake interval");
        require(amount <= idlePrincipal(), "principal only");
        uint256 stakedBefore = staking.stakeOf(address(this));
        require(stakedBefore + coolingPrincipal + amount <= maxPrincipal, "exposure limit");
        uint256 beforeBalance = AutomationToken(bnkr).balanceOf(address(this));
        lastStake = block.timestamp;
        bnkr.approve(address(staking), amount);
        staking.stake(amount);
        bnkr.approve(address(staking), 0);
        require(AutomationToken(bnkr).balanceOf(address(this)) + amount == beforeBalance, "stake balance mismatch");
        require(staking.stakeOf(address(this)) == stakedBefore + amount, "stake position mismatch");
        totalStaked += amount; emit PrincipalStaked(amount);
    }
    /// @notice Claims into a reserved bucket. A failed relay cannot trap claims behind a paused vault.
    function harvest() external onlyOperatorOrSafe nonReentrant checkedStaking returns (uint256 amount) {
        require(lastHarvest == 0 || block.timestamp >= lastHarvest + INTERVAL, "harvest interval");
        uint256 beforeBalance = AutomationToken(bnkr).balanceOf(address(this));
        uint256 beforeStake = staking.stakeOf(address(this));
        staking.getReward(); // Return value deliberately not trusted.
        amount = AutomationToken(bnkr).balanceOf(address(this)) - beforeBalance;
        require(staking.stakeOf(address(this)) == beforeStake, "claim changed principal");
        if (amount > 0) { pendingYield += amount; totalYieldClaimed += amount; lastHarvest = block.timestamp; emit YieldClaimed(amount); }
    }
    /// @notice Only measured staking yield is sent; direct BNKR transfers are never labeled as yield.
    function relayYield() external onlyOperatorOrSafe nonReentrant returns (uint256 amount) {
        require(lastRelay == 0 || block.timestamp >= lastRelay + INTERVAL, "relay interval");
        amount = pendingYield; require(amount > 0, "no yield");
        uint256 beforeBalance = AutomationToken(bnkr).balanceOf(address(this));
        pendingYield = 0; lastRelay = block.timestamp;
        bnkr.approve(address(relay), amount); relay.relayBnkr(amount); bnkr.approve(address(relay), 0);
        require(AutomationToken(bnkr).balanceOf(address(this)) + amount == beforeBalance, "relay balance mismatch");
        totalYieldRelayed += amount; emit YieldRelayed(amount);
    }
    function advanceStaking(uint32 days_) external onlyOperatorOrSafe nonReentrant checkedStaking {
        require(days_ > 0 && days_ <= 180, "advance bound"); staking.advance(days_);
    }
    function requestUnstake(uint256 amount) external onlySafe nonReentrant checkedStaking returns (uint64 id) {
        require(paused && amount > 0, "pause first");
        uint256 beforeStake = staking.stakeOf(address(this));
        uint256 beforeBalance = AutomationToken(bnkr).balanceOf(address(this));
        id = staking.requestUnstake(amount);
        require(staking.stakeOf(address(this)) + amount == beforeStake, "unstake position mismatch");
        require(AutomationToken(bnkr).balanceOf(address(this)) == beforeBalance, "unexpected transfer");
        coolingPrincipal += amount; emit UnstakeRequested(id, amount);
    }
    /// @notice Mature principal always returns to the immutable Safe, never to the automation or vault rewards.
    function withdrawPrincipal() external onlySafe nonReentrant checkedStaking returns (uint256 amount) {
        require(paused, "pause first");
        uint256 beforeBalance = AutomationToken(bnkr).balanceOf(address(this));
        staking.withdraw();
        amount = AutomationToken(bnkr).balanceOf(address(this)) - beforeBalance;
        require(amount > 0 && amount <= coolingPrincipal, "withdraw balance mismatch");
        coolingPrincipal -= amount; bnkr.transfer(safe, amount); emit PrincipalReturned(amount);
    }
    function returnIdlePrincipal(uint256 amount) external onlySafe nonReentrant {
        require(paused && amount > 0 && amount <= idlePrincipal(), "principal only");
        bnkr.transfer(safe, amount); emit PrincipalReturned(amount);
    }
    function rescueOtherToken(address token, uint256 amount) external onlySafe nonReentrant {
        require(token != bnkr, "BNKR protected"); token.transfer(safe, amount);
    }
    function _configurationOwner() internal view override returns (address) { return safe; }
    function _isDelayedConfiguration(bytes4 selector) internal pure override returns (bool) { return selector == this.setPolicy.selector; }
}
