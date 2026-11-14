// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AgentPay BudgetVault
/// @notice Holds USDC for an AI agent and enforces on-chain spending guardrails:
///         a daily cap, a per-call maximum, a payee allowlist, and human approval
///         for any payment above the approval threshold.
/// @dev USDC has 6 decimals. A cap of 0 means "no limit" for perCallMax and
///      dailyCap; an approvalThreshold of 0 means EVERY payment needs approval.
contract BudgetVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    address public immutable owner;
    address public agent;

    uint256 public dailyCap;
    uint256 public perCallMax;
    uint256 public approvalThreshold;

    mapping(address => bool) public payeeAllowed;
    mapping(uint256 => uint256) public dailySpent; // UTC day (timestamp / 86400) => spent

    struct PendingPayment {
        address to;
        uint256 amount;
        bool approved;
        bool executed;
    }

    PendingPayment[] public pendingPayments;

    event Funded(address indexed from, uint256 amount);
    event Paid(address indexed to, uint256 amount, uint256 day, uint256 spentToday);
    event PaymentRequested(uint256 indexed id, address indexed to, uint256 amount);
    event PaymentApproved(uint256 indexed id);
    event PaymentExecuted(uint256 indexed id, address indexed to, uint256 amount);
    event LimitsUpdated(uint256 dailyCap, uint256 perCallMax, uint256 approvalThreshold);
    event PayeeUpdated(address indexed payee, bool allowed);
    event AgentUpdated(address indexed agent);
    event Withdrawn(address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "BudgetVault: not owner");
        _;
    }

    modifier onlyAgent() {
        require(msg.sender == agent, "BudgetVault: not agent");
        _;
    }

    constructor(
        address _usdc,
        address _agent,
        uint256 _dailyCap,
        uint256 _perCallMax,
        uint256 _approvalThreshold
    ) {
        require(_usdc != address(0), "BudgetVault: zero USDC");
        require(_agent != address(0), "BudgetVault: zero agent");
        usdc = IERC20(_usdc);
        owner = msg.sender;
        agent = _agent;
        dailyCap = _dailyCap;
        perCallMax = _perCallMax;
        approvalThreshold = _approvalThreshold;
    }

    /// @notice Fund the vault. Caller must have approved this contract first.
    function fund(uint256 amount) external nonReentrant {
        require(amount > 0, "BudgetVault: zero amount");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    function setAgent(address _agent) external onlyOwner {
        require(_agent != address(0), "BudgetVault: zero agent");
        agent = _agent;
        emit AgentUpdated(_agent);
    }

    function setLimits(uint256 _dailyCap, uint256 _perCallMax, uint256 _approvalThreshold)
        external
        onlyOwner
    {
        dailyCap = _dailyCap;
        perCallMax = _perCallMax;
        approvalThreshold = _approvalThreshold;
        emit LimitsUpdated(_dailyCap, _perCallMax, _approvalThreshold);
    }

    function setPayee(address payee, bool allowed) external onlyOwner {
        require(payee != address(0), "BudgetVault: zero payee");
        payeeAllowed[payee] = allowed;
        emit PayeeUpdated(payee, allowed);
    }

    /// @notice Agent pays a whitelisted payee directly, within all limits.
    function pay(address to, uint256 amount) external onlyAgent nonReentrant {
        _checkPayment(to, amount);
        _spend(to, amount);
    }

    /// @notice Agent requests a payment above the approval threshold.
    /// @return id The pending payment id the owner must approve.
    function requestPayment(address to, uint256 amount) external onlyAgent returns (uint256 id) {
        require(payeeAllowed[to], "BudgetVault: payee not allowed");
        require(amount > 0, "BudgetVault: zero amount");
        if (perCallMax > 0) require(amount <= perCallMax, "BudgetVault: exceeds per-call max");
        id = pendingPayments.length;
        pendingPayments.push(PendingPayment({to: to, amount: amount, approved: false, executed: false}));
        emit PaymentRequested(id, to, amount);
    }

    /// @notice Owner approves a pending payment.
    function approvePayment(uint256 id) external onlyOwner {
        require(id < pendingPayments.length, "BudgetVault: bad id");
        require(!pendingPayments[id].executed, "BudgetVault: already executed");
        pendingPayments[id].approved = true;
        emit PaymentApproved(id);
    }

    /// @notice Agent executes an approved payment. Daily cap is re-checked here,
    ///         because spending may have moved since approval.
    function executePayment(uint256 id) external onlyAgent nonReentrant {
        require(id < pendingPayments.length, "BudgetVault: bad id");
        PendingPayment storage p = pendingPayments[id];
        require(p.approved, "BudgetVault: not approved");
        require(!p.executed, "BudgetVault: already executed");
        _checkDailyCap(p.amount);
        p.executed = true;
        _spend(p.to, p.amount);
        emit PaymentExecuted(id, p.to, p.amount);
    }

    /// @notice Owner recovers funds (emergency / wind-down).
    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "BudgetVault: zero to");
        require(amount > 0, "BudgetVault: zero amount");
        usdc.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    function today() public view returns (uint256) {
        return block.timestamp / 86400;
    }

    function remainingDaily() external view returns (uint256) {
        uint256 spent = dailySpent[today()];
        if (dailyCap == 0 || spent >= dailyCap) return dailyCap == 0 ? type(uint256).max : 0;
        return dailyCap - spent;
    }

    function pendingCount() external view returns (uint256) {
        return pendingPayments.length;
    }

    function _checkPayment(address to, uint256 amount) internal view {
        require(payeeAllowed[to], "BudgetVault: payee not allowed");
        require(amount > 0, "BudgetVault: zero amount");
        if (perCallMax > 0) require(amount <= perCallMax, "BudgetVault: exceeds per-call max");
        require(amount <= approvalThreshold, "BudgetVault: needs approval");
        _checkDailyCap(amount);
    }

    function _checkDailyCap(uint256 amount) internal view {
        if (dailyCap == 0) return;
        require(dailySpent[today()] + amount <= dailyCap, "BudgetVault: exceeds daily cap");
    }

    function _spend(address to, uint256 amount) internal {
        dailySpent[today()] += amount;
        usdc.safeTransfer(to, amount);
        emit Paid(to, amount, today(), dailySpent[today()]);
    }
}
