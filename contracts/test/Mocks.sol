// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

interface IMock {
    function mint(address, uint256) external;
    function transferFrom(address, address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

/// @dev Mimics SwapRouter02.exactInput: pulls tokenIn (first 20 bytes of path), mints tokenOut (last 20 bytes) at rate.
contract MockRouter {
    uint256 public rateNum = 1;
    uint256 public rateDen = 1;
    bytes public lastPath;

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function setRate(uint256 n, uint256 d) external {
        rateNum = n;
        rateDen = d;
    }

    function exactInput(ExactInputParams calldata p) external payable returns (uint256 amountOut) {
        bytes calldata path = p.path;
        address tokenIn = address(bytes20(path[0:20]));
        address tokenOut = address(bytes20(path[path.length - 20:]));
        lastPath = path;
        IMock(tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        amountOut = (p.amountIn * rateNum) / rateDen;
        require(amountOut >= p.amountOutMinimum, "Too little received");
        IMock(tokenOut).mint(p.recipient, amountOut);
    }
}

/// @dev Buyback executor mock: pulls USDC, mints STAKED to caller at rate. Can be told to under-deliver.
contract MockBuybackExecutor {
    address public usdc;
    address public staked;
    uint256 public rate = 1e15; // STAKED-wei per USDC-wei
    bool public underDeliver;

    constructor(address _usdc, address _staked) {
        usdc = _usdc;
        staked = _staked;
    }

    function setUnderDeliver(bool v) external {
        underDeliver = v;
    }

    function buyback(uint256 usdcAmount, uint256 minStakedOut) external returns (uint256 out) {
        IMock(usdc).transferFrom(msg.sender, address(this), usdcAmount);
        out = usdcAmount * rate;
        if (underDeliver) out = minStakedOut / 2;
        IMock(staked).mint(msg.sender, out);
    }
}
