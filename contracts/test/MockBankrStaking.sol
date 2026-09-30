// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import "../StakedBankrStakingAdapter.sol";
interface MintableBnkr is AutomationToken { function mint(address,uint256) external; }
contract MockBankrStaking {
    address public immutable stakingToken;
    address public immutable rewardsToken;
    mapping(address=>uint256) public stakeOf;
    mapping(address=>uint256) public earned;
    mapping(address=>uint256) public cooling;
    mapping(address=>uint256) public ready;
    bool public dishonestStake;
    bool public paused;
    bool public callback;
    constructor(address token) { stakingToken=token; rewardsToken=token; }
    function setMode(bool dishonest,bool pause_,bool callback_) external { dishonestStake=dishonest;paused=pause_;callback=callback_; }
    function stake(uint256 amount) external {
        require(!paused,"bankr paused");
        AutomationToken(stakingToken).transferFrom(msg.sender,address(this),amount);
        if(!dishonestStake) stakeOf[msg.sender]+=amount;
        if(callback) { (bool ok,)=msg.sender.call(abi.encodeWithSignature("harvest()"));require(!ok,"callback escaped"); }
    }
    function addReward(address account,uint256 amount) external { MintableBnkr(stakingToken).mint(address(this),amount);earned[account]+=amount; }
    function getReward() external returns(uint256) { uint256 a=earned[msg.sender];earned[msg.sender]=0;AutomationToken(stakingToken).transfer(msg.sender,a);return type(uint256).max; }
    function requestUnstake(uint256 amount) external returns(uint64) { stakeOf[msg.sender]-=amount;cooling[msg.sender]+=amount;ready[msg.sender]=block.timestamp+2 days;return 1; }
    function withdraw() external returns(uint256) { require(block.timestamp>=ready[msg.sender],"cooldown");uint256 a=cooling[msg.sender];require(a>0,"nothing");cooling[msg.sender]=0;AutomationToken(stakingToken).transfer(msg.sender,a);return 999; }
    function advance(uint32) external {}
}
