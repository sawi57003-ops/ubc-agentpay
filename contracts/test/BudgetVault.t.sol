// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {BudgetVault} from "../src/BudgetVault.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("Mock USDC", "mUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract BudgetVaultTest is Test {
    MockUSDC usdc;
    BudgetVault vault;

    address owner = address(0xA11CE);
    address agent = address(0xA6E17);
    address payee = address(0x9A7EE);
    address stranger = address(0x57A16);

    uint256 constant DAILY_CAP = 10_000_000; // 10 USDC
    uint256 constant PER_CALL_MAX = 1_000_000; // 1 USDC
    uint256 constant APPROVAL_THRESHOLD = 500_000; // 0.5 USDC

    function setUp() public {
        usdc = new MockUSDC();
        vm.prank(owner);
        vault = new BudgetVault(address(usdc), agent, DAILY_CAP, PER_CALL_MAX, APPROVAL_THRESHOLD);
        usdc.mint(owner, 100_000_000); // 100 USDC
        vm.startPrank(owner);
        usdc.approve(address(vault), type(uint256).max);
        vault.fund(50_000_000); // 50 USDC in vault
        vault.setPayee(payee, true);
        vm.stopPrank();
    }

    function test_payWithinLimits() public {
        vm.prank(agent);
        vault.pay(payee, 400_000);
        assertEq(usdc.balanceOf(payee), 400_000);
        assertEq(vault.dailySpent(vault.today()), 400_000);
    }

    function test_payRevertsNonAgent() public {
        vm.prank(stranger);
        vm.expectRevert("BudgetVault: not agent");
        vault.pay(payee, 100_000);
    }

    function test_payRevertsNonAllowlistedPayee() public {
        vm.prank(agent);
        vm.expectRevert("BudgetVault: payee not allowed");
        vault.pay(stranger, 100_000);
    }

    function test_payRevertsAbovePerCallMax() public {
        vm.prank(agent);
        vm.expectRevert("BudgetVault: exceeds per-call max");
        vault.pay(payee, 1_000_001);
    }

    function test_payRevertsAboveApprovalThreshold() public {
        vm.prank(agent);
        vm.expectRevert("BudgetVault: needs approval");
        vault.pay(payee, 600_000);
    }

    function test_dailyCapEnforced() public {
        // 10 USDC cap; 0.5 USDC per call maxes the direct path, so pay 0.5 x 20 = 10
        vm.startPrank(agent);
        for (uint256 i = 0; i < 20; i++) {
            vault.pay(payee, 500_000);
        }
        vm.expectRevert("BudgetVault: exceeds daily cap");
        vault.pay(payee, 1);
        vm.stopPrank();
    }

    function test_dailyCapResetsNextDay() public {
        vm.startPrank(agent);
        for (uint256 i = 0; i < 20; i++) {
            vault.pay(payee, 500_000);
        }
        vm.stopPrank();
        vm.warp(block.timestamp + 86400);
        vm.prank(agent);
        vault.pay(payee, 500_000);
        assertEq(vault.dailySpent(vault.today()), 500_000);
    }

    function test_approvalFlow() public {
        vm.prank(agent);
        uint256 id = vault.requestPayment(payee, 800_000);
        assertEq(id, 0);
        // cannot execute before approval
        vm.prank(agent);
        vm.expectRevert("BudgetVault: not approved");
        vault.executePayment(0);
        // only owner approves
        vm.prank(stranger);
        vm.expectRevert("BudgetVault: not owner");
        vault.approvePayment(0);
        vm.prank(owner);
        vault.approvePayment(0);
        vm.prank(agent);
        vault.executePayment(0);
        assertEq(usdc.balanceOf(payee), 800_000);
        // double execute reverts
        vm.prank(agent);
        vm.expectRevert("BudgetVault: already executed");
        vault.executePayment(0);
    }

    function test_approvalFlowDailyCapRechecked() public {
        // approve 0.8, then spend the whole daily cap, then execution must fail
        vm.prank(agent);
        vault.requestPayment(payee, 800_000);
        vm.prank(owner);
        vault.approvePayment(0);
        vm.startPrank(agent);
        for (uint256 i = 0; i < 20; i++) {
            vault.pay(payee, 500_000);
        }
        vm.expectRevert("BudgetVault: exceeds daily cap");
        vault.executePayment(0);
        vm.stopPrank();
    }

    function test_ownerCanWithdraw() public {
        vm.prank(owner);
        vault.withdraw(owner, 5_000_000);
        assertEq(usdc.balanceOf(owner), 55_000_000);
    }

    function test_remainingDaily() public {
        assertEq(vault.remainingDaily(), DAILY_CAP);
        vm.prank(agent);
        vault.pay(payee, 400_000);
        assertEq(vault.remainingDaily(), DAILY_CAP - 400_000);
    }
}
