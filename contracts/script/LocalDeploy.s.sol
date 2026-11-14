// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {BudgetVault} from "../src/BudgetVault.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// @notice Local Anvil deploy: MockUSDC + BudgetVault, funded, payee allowlisted.
/// @dev Run: anvil (in one terminal), then:
///      forge script script/LocalDeploy.s.sol --rpc-url http://127.0.0.1:8545 \
///        --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f3ff80 --broadcast
///      (anvil account #0). Writes the addresses to ../local-addrs.json.
contract LocalDeploy is Script {
    function run() external {
        vm.startBroadcast();
        MockUSDC usdc = new MockUSDC();
        address agent = vm.envOr("AGENT_ADDRESS", msg.sender);
        address payee = vm.envOr("PAYEE_ADDRESS", msg.sender);
        BudgetVault vault = new BudgetVault(
            address(usdc), agent, 10_000_000, 1_000_000, 500_000
        );
        usdc.mint(msg.sender, 100_000_000);
        usdc.approve(address(vault), type(uint256).max);
        vault.fund(50_000_000);
        vault.setPayee(payee, true);
        vm.stopBroadcast();
        console.log("MockUSDC:", address(usdc));
        console.log("BudgetVault:", address(vault));
        console.log("Agent:", agent);
        console.log("Payee:", payee);
    }
}
