// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface ReviewToken {
    function mint(address, uint256) external;
    function transferFrom(address, address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// @dev Separates actual delivery from the router's claimed return value.
contract ReviewDishonestRouter {
    uint256 public delivered;
    uint256 public claimed;
    struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }
    function configure(uint256 delivered_, uint256 claimed_) external { delivered = delivered_; claimed = claimed_; }
    function exactInput(ExactInputParams calldata p) external payable returns (uint256) {
        address input = address(bytes20(p.path[:20]));
        address output = address(bytes20(p.path[p.path.length - 20:]));
        require(ReviewToken(input).transferFrom(msg.sender, address(this), p.amountIn));
        ReviewToken(output).mint(p.recipient, delivered);
        return claimed;
    }
}

contract ReviewRewardSink {
    uint256 public received;
    function notifyRewardAmount(address token, uint256 amount) external {
        uint256 before_ = ReviewToken(token).balanceOf(address(this));
        require(ReviewToken(token).transferFrom(msg.sender, address(this), amount));
        received += ReviewToken(token).balanceOf(address(this)) - before_;
    }
}
