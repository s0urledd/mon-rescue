// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title MonRescue
 * @notice Destination-locked rescue account for a Monad delegator.
 *
 * @dev Deployed one instance per protected user and delegated onto that user's EOA via an
 * EIP-7702 authorization. Once delegated, this code executes *in the EOA's own context*, so
 * `address(this)` is the user's address and calls this contract makes into the staking
 * precompile carry `msg.sender == the user's EOA` — which is what makes an atomic
 * claim-then-sweep possible at all, because the precompile always pays `msg.sender`.
 *
 * Core safety property: `SAFE_ADDRESS` is immutable and set at construction. There is no
 * function in this contract that transfers native MON to a caller-supplied address. Even if
 * an attacker who holds the user's seed calls `rescue()`, the funds move to the user's
 * pre-committed safe address and nowhere else.
 *
 * Threat model, stated honestly: this contract does not defend against a seed holder. A seed
 * holder can submit a new EIP-7702 authorization that re-delegates the EOA away from this
 * contract, or clear the delegation entirely, or transfer liquid MON directly. What this
 * contract provides is a pre-authorized, destination-locked path that a guardian can fire
 * faster than an unattended drainer can react. See research/FINDINGS.md.
 */
contract MonRescue {
    /// @notice Monad staking precompile. Only CALL reaches it; STATICCALL/DELEGATECALL revert.
    address internal constant STAKING_PRECOMPILE = 0x0000000000000000000000000000000000001000;

    /// @notice Reserve-balance precompile (MIP-4).
    address internal constant RESERVE_PRECOMPILE = 0x0000000000000000000000000000000000001001;

    /// @notice The one and only destination for rescued funds. Immutable by design.
    address public immutable SAFE_ADDRESS;

    /// @notice Address permitted to trigger a rescue, in addition to the account itself.
    address public immutable GUARDIAN;

    error ZeroSafeAddress();
    error SafeAddressIsPrecompile();
    /**
     * @notice Per-call gas cap for precompile calls.
     * @dev The staking precompile "consumes all gas" when given invalid arguments, so an
     * uncapped forward would let a single bad position destroy a multi-position rescue.
     */
    uint256 internal constant WITHDRAW_GAS_CAP = 400_000;

    error NotAuthorized();
    error LengthMismatch();
    error AllWithdrawalsFailed();
    error SweepFailed();
    error NothingToSweep();

    event Rescued(address indexed safeAddress, uint256 amount, uint256 validatorCount);
    event WithdrawFailed(uint64 indexed validatorId, bytes reason);
    event ClaimFailed(uint64 indexed validatorId, bytes reason);

    /**
     * @param safeAddress Destination for every rescue. Cannot be changed afterwards.
     * @param guardian Address allowed to trigger the rescue on the user's behalf.
     */
    constructor(address safeAddress, address guardian) {
        if (safeAddress == address(0)) revert ZeroSafeAddress();
        // Sweeping to a precompile would burn the funds.
        if (safeAddress == STAKING_PRECOMPILE || safeAddress == RESERVE_PRECOMPILE) {
            revert SafeAddressIsPrecompile();
        }
        SAFE_ADDRESS = safeAddress;
        GUARDIAN = guardian;
    }

    /**
     * @dev When delegated via 7702, `address(this)` is the user's EOA, so this permits the
     * user themselves as well as the guardian. Both are safe: neither can choose a
     * destination.
     */
    modifier onlyAuthorized() {
        if (msg.sender != GUARDIAN && msg.sender != address(this)) revert NotAuthorized();
        _;
    }

    /**
     * @notice Claim matured withdrawals and sweep the proceeds to the safe address, atomically.
     * @param validatorIds Validators to withdraw from.
     * @param withdrawIds Matching withdrawal slot for each validator.
     * @param claimRewardsToo Whether to also call claimRewards() for each validator.
     *
     * @dev The whole point of this function is that the claim and the transfer occur in one
     * transaction, leaving no block in which the claimed MON sits in a compromised EOA where
     * a drainer could take it.
     *
     * Reserve-balance interaction: the ending balance of this account must stay at or above
     * min(startingBalance, 10 MON) or the transaction reverts. Sweeping `address(this).balance`
     * would violate that whenever the account started with a non-zero balance, so the retained
     * floor is computed and withheld here rather than discovered as an on-chain revert.
     */
    function rescue(
        uint64[] calldata validatorIds,
        uint8[] calldata withdrawIds,
        bool claimRewardsToo
    ) external onlyAuthorized {
        if (validatorIds.length != withdrawIds.length) revert LengthMismatch();

        // Captured before any withdrawal credits the account, because the reserve floor is
        // min(balance at transaction start, 10 MON). A wallet already drained to ~0 has a
        // floor of ~0 and can therefore be swept in full.
        uint256 startingBalance = address(this).balance;

        uint256 succeeded;
        for (uint256 i = 0; i < validatorIds.length; i++) {
            uint64 valId = validatorIds[i];

            // withdraw() pays msg.sender, which under 7702 delegation is this EOA.
            //
            // Gas is capped per call for two reasons. The staking precompile "consumes all
            // gas" on invalid arguments, so an unbounded forward would let one bad position
            // burn the entire transaction. And when rescuing several positions at once, one
            // failing validator must not strand the others — we record the failure and carry
            // on, then require at least one success before sweeping.
            (bool ok, bytes memory reason) = STAKING_PRECOMPILE.call{gas: WITHDRAW_GAS_CAP}(
                abi.encodeWithSignature("withdraw(uint64,uint8)", valId, withdrawIds[i])
            );
            if (ok) {
                succeeded++;
            } else {
                emit WithdrawFailed(valId, reason);
                continue;
            }

            if (claimRewardsToo) {
                // Rewards are a bonus, not the principal. A validator with nothing to claim
                // must not abort the rescue of every other position.
                (bool rOk, bytes memory rReason) = STAKING_PRECOMPILE.call{gas: WITHDRAW_GAS_CAP}(
                    abi.encodeWithSignature("claimRewards(uint64)", valId)
                );
                if (!rOk) emit ClaimFailed(valId, rReason);
            }
        }

        if (succeeded == 0) revert AllWithdrawalsFailed();

        _sweep(startingBalance, succeeded);
    }

    /**
     * @notice Sweep whatever native MON is already in the account to the safe address.
     * @dev Used when an attacker has already called withdraw() themselves. That move converts
     * staked MON into liquid MON sitting in an EOA still delegated to this contract, so it
     * becomes rescuable without waiting for an epoch boundary.
     */
    function sweep() external onlyAuthorized {
        _sweep(address(this).balance, 0);
    }

    /**
     * @notice Largest amount this account may transfer out without tripping the reserve rule.
     * @dev floor = min(startingBalance, 10 MON); movable = currentBalance - floor.
     */
    function sweepableAmount(uint256 startingBalance) public view returns (uint256) {
        uint256 floor = _reserveFloor(startingBalance);
        uint256 balance = address(this).balance;
        return balance > floor ? balance - floor : 0;
    }

    function _reserveFloor(uint256 startingBalance) internal pure returns (uint256) {
        // A delegated EOA may end a transaction no lower than min(start, 10 MON). The floor is
        // NOT a flat 10 MON: an account that started near zero can be swept nearly empty.
        return startingBalance < 10 ether ? startingBalance : 10 ether;
    }

    function _sweep(uint256 startingBalance, uint256 validatorCount) internal {
        uint256 amount = sweepableAmount(startingBalance);
        if (amount == 0) revert NothingToSweep();

        (bool ok,) = SAFE_ADDRESS.call{value: amount}("");
        if (!ok) revert SweepFailed();

        emit Rescued(SAFE_ADDRESS, amount, validatorCount);
    }

    /// @dev Required so the account can receive the precompile's withdrawal payout.
    receive() external payable {}
}
