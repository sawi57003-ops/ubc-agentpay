// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {BudgetVault} from "../src/BudgetVault.sol";

/// @notice Deploy BudgetVault to Base Sepolia.
/// @dev Run: forge script script/Deploy.s.sol --rpc-url https://sepolia.base.org \
///           --private-key $DEPLOYER_KEY --broadcast
///      USDC (Base Sepolia, Circle): 0x036CbD53842c5426634e7929541eC2318f3dCF7e
contract Deploy is Script {
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    // Defaults: 10 USDC daily cap, 1 USDC per-call max, 0.5 USDC approval threshold.
    uint256 constant DAILY_CAP = 10_000_000;
    uint256 constant PER_CALL_MAX = 1_000_000;
    uint256 constant APPROVAL_THRESHOLD = 500_000;

    function run() external {
        // The agent address is passed as an env var (AGENT_ADDRESS); defaults to deployer.
        address agent = vm.envOr("AGENT_ADDRESS", msg.sender);
        vm.startBroadcast();
        BudgetVault vault = new BudgetVault(USDC, agent, DAILY_CAP, PER_CALL_MAX, APPROVAL_THRESHOLD);
        vm.stopBroadcast();
        console.log("BudgetVault:", address(vault));
        console.log("USDC:", USDC);
        console.log("Agent:", agent);
        console.log("DailyCap:", DAILY_CAP);
        console.log("PerCallMax:", PER_CALL_MAX);
        console.log("ApprovalThreshold:", APPROVAL_THRESHOLD);
    }
}
