// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Fixed notice period for explicitly listed configuration setters.
/// @dev No arbitrary-call executor, bypass, or mutable delay. This is not a delay
///      on every owner action. The owner calls the original setter after waiting.
abstract contract ConfigurationDelay {
    uint256 public constant CONFIGURATION_DELAY = 48 hours;
    uint256 public constant CONFIGURATION_WINDOW = 7 days;
    mapping(bytes32 => uint256) public configurationReadyAt;

    event ConfigurationScheduled(bytes32 indexed id, bytes callData, uint256 readyAt, uint256 expiresAt);
    event ConfigurationCancelled(bytes32 indexed id);
    event ConfigurationExecuted(bytes32 indexed id);

    function _configurationOwner() internal view virtual returns (address);
    function _isDelayedConfiguration(bytes4 selector) internal pure virtual returns (bool);

    /// @notice Binds a proposal to this deployment, chain, current owner and exact calldata.
    function configurationId(bytes calldata callData) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), _configurationOwner(), callData));
    }

    function scheduleConfiguration(bytes calldata callData) external returns (bytes32 id) {
        require(msg.sender == _configurationOwner(), "not owner");
        require(callData.length >= 4 && _isDelayedConfiguration(bytes4(callData[:4])), "unsupported configuration");
        id = configurationId(callData);
        uint256 previous = configurationReadyAt[id];
        require(previous == 0 || block.timestamp > previous + CONFIGURATION_WINDOW, "already scheduled");
        uint256 readyAt = block.timestamp + CONFIGURATION_DELAY;
        configurationReadyAt[id] = readyAt;
        emit ConfigurationScheduled(id, callData, readyAt, readyAt + CONFIGURATION_WINDOW);
    }

    function cancelConfiguration(bytes32 id) external {
        require(msg.sender == _configurationOwner(), "not owner");
        require(configurationReadyAt[id] != 0, "not scheduled");
        delete configurationReadyAt[id];
        emit ConfigurationCancelled(id);
    }

    modifier delayedConfiguration() {
        bytes32 id = configurationId(msg.data);
        uint256 readyAt = configurationReadyAt[id];
        require(readyAt != 0, "configuration not scheduled");
        require(block.timestamp >= readyAt, "configuration delay");
        require(block.timestamp <= readyAt + CONFIGURATION_WINDOW, "configuration expired");
        delete configurationReadyAt[id];
        _;
        emit ConfigurationExecuted(id);
    }
}
