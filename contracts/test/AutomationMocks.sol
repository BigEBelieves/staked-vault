// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import "../AutomationSupport.sol";
import {IPoolManager} from "../StakedBuybackExecutor.sol";

interface AutomationMint { function mint(address, uint256) external; }
interface AutomationCallback { function unlockCallback(bytes calldata) external returns (bytes memory); }

contract MockDopplerFees {
    address public immutable token0;
    address public immutable token1;
    mapping(address => uint256) public shares;
    uint256 public payout0;
    uint256 public payout1;
    constructor(address a, address b) { token0 = a; token1 = b; }
    function setShares(address beneficiary, uint256 value) external { shares[beneficiary] = value; }
    function setPayout(uint256 a, uint256 b) external { payout0 = a; payout1 = b; }
    function collectFees(bytes32) external returns (uint128, uint128) {
        if (shares[msg.sender] > 0) {
            AutomationMint(token0).mint(msg.sender, payout0);
            AutomationMint(token1).mint(msg.sender, payout1);
            payout0 = 0;
            payout1 = 0;
        }
        // Deliberately unrelated to the beneficiary payout: consumers must use token balances.
        return (1, 2);
    }
    function updateBeneficiary(bytes32, address recipient) external {
        shares[recipient] += shares[msg.sender];
        shares[msg.sender] = 0;
    }
}

contract MockBoundedPoolManager {
    uint256 public mode;
    uint256 public lastLimit;
    bool public lastDirection;
    address private synced;
    uint256 private previousBalance;
    function setMode(uint256 m) external { mode = m; }
    function unlock(bytes calldata data) external returns (bytes memory) {
        if (mode == 2) return "";
        bytes memory result = AutomationCallback(msg.sender).unlockCallback(data);
        if (mode == 3) AutomationCallback(msg.sender).unlockCallback(data);
        return result;
    }
    function swap(IPoolManager.PoolKey memory, IPoolManager.SwapParams memory p, bytes calldata) external returns (int256) {
        lastLimit = p.sqrtPriceLimitX96;
        lastDirection = p.zeroForOne;
        uint256 amount = uint256(-p.amountSpecified);
        if (mode == 1) amount /= 2;
        int128 owed = -int128(int256(amount));
        int128 received = int128(int256(amount * 2));
        if (mode == 4) received = 1;
        (int128 a, int128 b) = p.zeroForOne ? (owed, received) : (received, owed);
        return (int256(a) << 128) | int256(uint256(uint128(b)));
    }
    function sync(address token) external {
        synced = token;
        previousBalance = AutomationToken(token).balanceOf(address(this));
    }
    function settle() external payable returns (uint256) {
        return AutomationToken(synced).balanceOf(address(this)) - previousBalance;
    }
    function take(address token, address recipient, uint256 amount) external {
        AutomationMint(token).mint(recipient, mode == 5 ? amount / 2 : amount);
    }
}
