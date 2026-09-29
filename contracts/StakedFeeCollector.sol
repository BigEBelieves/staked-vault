// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import "./AutomationSupport.sol";

interface DopplerFees {
    function collectFees(bytes32 poolId) external returns (uint128, uint128);
    function updateBeneficiary(bytes32 poolId, address beneficiary) external;
}

/// @notice Permissionless collection, fixed destination. Must own the pool's beneficiary share.
contract StakedFeeCollector is SafeAuthority {
    using AutomationTransfer for address;
    address public immutable initializer;
    bytes32 public immutable poolId;
    address public immutable staked;
    address public immutable bnkr;
    address public immutable distributor;
    event FeesForwarded(uint256 stakedAmount, uint256 bnkrAmount);
    event BeneficiaryReturnedToSafe();

    constructor(address safe_, address initializer_, bytes32 poolId_, address staked_, address bnkr_, address distributor_)
        SafeAuthority(safe_)
    {
        require(initializer_.code.length > 0 && distributor_.code.length > 0, "missing contract");
        require(staked_.code.length > 0 && bnkr_.code.length > 0 && staked_ != bnkr_, "bad tokens");
        initializer = initializer_;
        poolId = poolId_;
        staked = staked_;
        bnkr = bnkr_;
        distributor = distributor_;
    }

    function collectAndDistribute() external nonReentrant {
        // Return values are total newly collected pool fees, NOT this beneficiary's payout.
        DopplerFees(initializer).collectFees(poolId);
        uint256 s = AutomationToken(staked).balanceOf(address(this));
        uint256 b = AutomationToken(bnkr).balanceOf(address(this));
        if (s == 0 && b == 0) return;
        staked.approve(distributor, s);
        bnkr.approve(distributor, b);
        AutomationDistributor(distributor).depositAndDistribute(s, b);
        staked.approve(distributor, 0);
        bnkr.approve(distributor, 0);
        emit FeesForwarded(s, b);
    }

    /// @notice Emergency rollback of fee rights. Never accepts a caller-selected recipient.
    function returnBeneficiaryToSafe() external onlySafe nonReentrant {
        DopplerFees(initializer).updateBeneficiary(poolId, safe);
        _sweep(staked);
        _sweep(bnkr);
        emit BeneficiaryReturnedToSafe();
    }

    function sweepToSafe(address token) external onlySafe nonReentrant { _sweep(token); }
    function _sweep(address token) private {
        uint256 amount = AutomationToken(token).balanceOf(address(this));
        if (amount != 0) token.transfer(safe, amount);
    }
}
