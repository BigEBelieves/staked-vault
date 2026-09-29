// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface AutomationToken {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

library AutomationTransfer {
    function invoke(address token, bytes memory data) private {
        require(token.code.length != 0, "token has no code");
        (bool ok, bytes memory result) = token.call(data);
        require(ok && (result.length == 0 || abi.decode(result, (bool))), "token transfer failed");
    }
    function transfer(address token, address to, uint256 amount) internal {
        invoke(token, abi.encodeCall(AutomationToken.transfer, (to, amount)));
    }
    function pull(address token, address from, uint256 amount) internal {
        invoke(token, abi.encodeCall(AutomationToken.transferFrom, (from, address(this), amount)));
    }
    function approve(address token, address spender, uint256 amount) internal {
        invoke(token, abi.encodeCall(AutomationToken.approve, (spender, amount)));
    }
}

/// @dev The Safe address is permanent; its signers can be rotated through the Safe itself.
abstract contract SafeAuthority {
    address public immutable safe;
    uint256 private entered;
    constructor(address safe_) {
        require(safe_ != address(0), "safe=0");
        safe = safe_;
    }
    modifier onlySafe() { require(msg.sender == safe, "not Safe"); _; }
    modifier nonReentrant() {
        require(entered == 0, "reentrant");
        entered = 1;
        _;
        entered = 0;
    }
}

interface AutomationVault {
    function notifyRewardAmount(address token, uint256 amount) external;
    function executeBuyback(uint256 amount, uint256 minimum) external;
    function buybackExecutor() external view returns (address);
}

interface AutomationDistributor {
    function depositAndDistribute(uint256 stakedAmount, uint256 bnkrAmount) external;
    function pendingSwapBnkr() external view returns (uint256);
    function swapAndNotify(uint256 minimum) external returns (uint256);
}
