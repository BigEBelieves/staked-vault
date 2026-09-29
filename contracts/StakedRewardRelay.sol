// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import "./AutomationSupport.sol";

/// @notice Adapter for the EXISTING distributor and vault, with separately authorized BNKR donors.
/// @dev Set distributor.vault = this AND vault.distributor = this in one Safe batch.
contract StakedRewardRelay is SafeAuthority {
    using AutomationTransfer for address;
    address public immutable vault;
    address public immutable distributor;
    address public immutable usdc;
    address public immutable bnkr;
    mapping(address => bool) public yieldSource;
    event YieldSourceUpdated(address indexed source, bool allowed);
    event RewardRelayed(address indexed source, address indexed token, uint256 amount);

    constructor(address safe_, address vault_, address distributor_, address usdc_, address bnkr_)
        SafeAuthority(safe_)
    {
        require(vault_.code.length > 0 && distributor_.code.length > 0, "missing contract");
        require(usdc_.code.length > 0 && bnkr_.code.length > 0 && usdc_ != bnkr_, "bad tokens");
        vault = vault_;
        distributor = distributor_;
        usdc = usdc_;
        bnkr = bnkr_;
    }

    function setYieldSource(address source, bool allowed) external onlySafe {
        require(source != address(0), "source=0");
        yieldSource[source] = allowed;
        emit YieldSourceUpdated(source, allowed);
    }

    function notifyRewardAmount(address token, uint256 amount) external nonReentrant {
        require(msg.sender == distributor && token == usdc, "not distributor USDC");
        _relay(token, amount);
    }

    /// @dev Pulls only from the caller. A keeper cannot spend the Safe's allowance or choose a recipient.
    function relayBnkr(uint256 amount) external nonReentrant {
        require(msg.sender == safe || yieldSource[msg.sender], "not yield source");
        _relay(bnkr, amount);
    }

    function _relay(address token, uint256 amount) private {
        require(amount > 0, "amount=0");
        uint256 beforeBalance = AutomationToken(token).balanceOf(address(this));
        token.pull(msg.sender, amount);
        require(AutomationToken(token).balanceOf(address(this)) == beforeBalance + amount, "short transfer");
        token.approve(vault, amount);
        AutomationVault(vault).notifyRewardAmount(token, amount);
        token.approve(vault, 0);
        require(AutomationToken(token).balanceOf(address(this)) == beforeBalance, "reward not consumed");
        emit RewardRelayed(msg.sender, token, amount);
    }
}
