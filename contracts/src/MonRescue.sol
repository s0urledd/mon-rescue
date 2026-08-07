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

    /**
     * @notice The intended primary trigger. Published as metadata, NOT as a permission —
     * `rescue()` and `sweep()` are callable by anyone. See the note above `rescue()`.
     */
    address public immutable GUARDIAN;

    /**
     * @notice Per-call gas caps for precompile calls.
     *
     * @dev The staking precompile "consumes all gas" when given invalid arguments, so an
     * uncapped forward would let a single bad position destroy a multi-position rescue.
     *
     * These were 400,000 — and a cap only caps if it is SMALLER than the gas the transaction
     * actually has. At a 350,000 transaction limit, EIP-150 forwards 63/64 of what remains
     * (~344,000), the precompile eats all of it, and `_sweep` never runs. The protection read
     * as present and was doing nothing. Measured on testnet at the epoch 1035 battle test: 63
     * spray attempts and the backstop all reverted with `out of gas`, while the same call at a
     * 1,000,000 limit simulated clean.
     *
     * Sized just above the measured successful cost of each call — withdraw 68,675,
     * claimRewards 155,375 — so a failure burns a bounded amount and the sweep always has room.
     *
     * `estimateRescueGas()` in packages/shared sizes the transaction limit against these
     * numbers assuming EVERY call fails. Change one, change both.
     */
    uint256 internal constant WITHDRAW_GAS_CAP = 100_000;
    uint256 internal constant CLAIM_GAS_CAP = 200_000;

    error ZeroSafeAddress();
    error SafeAddressIsPrecompile();
    error LengthMismatch();
    error SweepFailed();
    error NothingToSweep();

    event Rescued(address indexed safeAddress, uint256 amount, uint256 validatorCount);
    event WithdrawFailed(uint64 indexed validatorId, bytes reason);
    event ClaimFailed(uint64 indexed validatorId, bytes reason);
    event UnbondStarted(uint64 indexed validatorId, uint256 amount, uint8 withdrawId);
    event UnbondFailed(uint64 indexed validatorId, bytes reason);

    /**
     * @param safeAddress Destination for every rescue. Cannot be changed afterwards.
     * @param guardian Intended primary trigger, recorded for off-chain identification only.
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
     * @dev Deliberately NOT access-controlled.
     *
     * Access control on a destination-locked function buys nothing and costs liveness. Funds
     * can only ever reach SAFE_ADDRESS, so the worst an arbitrary caller can do is pay gas to
     * move the user's money to the user's own safe address. Even the attacker calling this is
     * a win for us.
     *
     * What restricting it WOULD cost is the thing that actually kills a rescue: if only the
     * guardian can fire, then the guardian being offline, rate-limited, or out of gas at the
     * unlock moment loses the funds. Leaving it open means the user's own machine, a friend,
     * a keeper, and our daemon can all race to fire it, and only the first one to land pays.
     * Redundancy beats exclusivity when the failure mode is "nobody fired in time".
     *
     * GUARDIAN is retained as published metadata so watchers can identify the intended
     * primary trigger, not as a permission.
     *
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
    ) external {
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
                (bool rOk, bytes memory rReason) = STAKING_PRECOMPILE.call{gas: CLAIM_GAS_CAP}(
                    abi.encodeWithSignature("claimRewards(uint64)", valId)
                );
                if (!rOk) emit ClaimFailed(valId, rReason);
            }
        }

        // Deliberately NOT reverting when every withdrawal failed.
        //
        // The most likely reason for a failed withdrawal is that someone already called
        // withdraw() on this slot — and the most likely someone is the attacker. Because the
        // precompile always pays msg.sender, their withdrawal deposits the funds into THIS
        // account, which is still delegated to this destination-locked contract. So a failed
        // withdrawal frequently means the money is sitting here right now, waiting to be
        // swept. Reverting would throw away the rescue at the exact moment it can succeed.
        //
        // _sweep reverts with NothingToSweep if there is genuinely nothing to move.
        _sweep(startingBalance, succeeded);
    }

    /**
     * @notice Sweep whatever native MON is already in the account to the safe address.
     * @dev Used when an attacker has already called withdraw() themselves. That move converts
     * staked MON into liquid MON sitting in an EOA still delegated to this contract, so it
     * becomes rescuable without waiting for an epoch boundary.
     */
    function sweep() external {
        _sweep(address(this).balance, 0);
    }

    /**
     * @notice Start unbonding the account's entire active stake, one withdrawal slot per
     * validator.
     *
     * @dev For the case where the user reaches us while their stake is still ACTIVE — their
     * wallet is compromised (assets already taken on other chains, say) but nobody has touched
     * the Monad position yet.
     *
     * Waiting for the attacker to unstake looks acceptable because their Undelegate event
     * starts our clock either way. It is not, and the reason is that waiting hands them three
     * choices that are ours to take:
     *
     *  1. **The moment.** They pick when the clock starts, so they pick when the contested block
     *     falls. We would rather it fell when we are armed and funded.
     *  2. **The slot count.** `withdrawId` is theirs to choose, and each slot needs its own
     *     `withdraw()` call. Fifty slots multiplies our per-attempt cost 13x; at the 256 maximum
     *     one attempt costs ~35 MON and collides with the inflight gas budget, collapsing the
     *     spray to a single shot. Undelegating first takes exactly one slot per validator.
     *  3. **The boundary.** An undelegate landing before the boundary block activates at n+1;
     *     one landing at or after it activates at n+2. That is a full epoch — about 4.2 hours —
     *     and it is the largest single lever on the clock. We can aim for it; they can aim for
     *     the other side of it.
     *
     * Unbonding does not move funds, so the destination lock is untouched: the stake matures
     * into a withdrawal request payable to `msg.sender`, which under delegation is this account,
     * and the only exit from this account remains `_sweep` to `SAFE_ADDRESS`. Even if the
     * attacker calls `withdraw()` themselves at maturity, the precompile pays this account and
     * they need a second transaction to move it — which is the race `rescue()` wins in one.
     *
     * Permissionless for the same reason as `rescue()`. It grants an attacker nothing they do
     * not already have: holding the seed, they can call the precompile directly and split slots
     * however they like. What it costs to restrict is a rescue that cannot start because our
     * key is the one that is offline.
     *
     * @param validatorIds Validators whose active stake should be unbonded.
     * @param withdrawId Slot to use for every validator. One slot each is not about the bill —
     * it is about how many shots we get. Monad caps an account's inflight gas at
     * min(10 MON, balance) over 3 blocks, so every extra slot enlarges each attempt and fewer
     * attempts fit inside that cap. Slot count buys attempts, not savings. Pick a free slot.
     * @return started Number of validators for which unbonding was successfully requested.
     */
    function startUnbonding(uint64[] calldata validatorIds, uint8 withdrawId)
        external
        returns (uint256 started)
    {
        for (uint256 i = 0; i < validatorIds.length; i++) {
            uint64 valId = validatorIds[i];

            // Only ACTIVATED stake can be undelegated, and `stake` is exactly that field. A
            // delegation made this epoch reads as 0 here and undelegating it would revert,
            // consuming the whole gas limit — so read first rather than discover on-chain.
            (bool gotIt, bytes memory data) = STAKING_PRECOMPILE.call{gas: CLAIM_GAS_CAP}(
                abi.encodeWithSignature("getDelegator(uint64,address)", valId, address(this))
            );
            if (!gotIt || data.length < 32) {
                emit UnbondFailed(valId, data);
                continue;
            }
            uint256 activeStake = abi.decode(data, (uint256));
            if (activeStake == 0) {
                emit UnbondFailed(valId, bytes("no active stake"));
                continue;
            }

            // undelegate measured at 147,750 — the withdraw cap would not fit it.
            (bool ok, bytes memory reason) = STAKING_PRECOMPILE.call{gas: CLAIM_GAS_CAP}(
                abi.encodeWithSignature(
                    "undelegate(uint64,uint256,uint8)", valId, activeStake, withdrawId
                )
            );
            if (ok) {
                started++;
                emit UnbondStarted(valId, activeStake, withdrawId);
            } else {
                emit UnbondFailed(valId, reason);
            }
        }
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
