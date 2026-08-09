// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title AdversaryDrainer — TEST HARNESS ONLY. Not part of the product.
 *
 * @notice The other side of the battle test: what a competent attacker delegates a compromised
 * EOA to. It exists so we can measure our defences against the attack that is actually common,
 * rather than against the one we find convenient.
 *
 * Why it needs to exist. Within four weeks of Pectra, ~97% of EIP-7702 delegations on Ethereum
 * mainnet pointed at sweeper contracts — Wintermute's "CrimeEnjoyor", all the same copy-pasted
 * bytecode. We had been treating "the attacker re-delegates the EOA to their own contract" as
 * the sophisticated case to test last. It is the ordinary case, and every battle test so far has
 * been run against an attacker weaker than the median real one.
 *
 * What it does that the two-transaction attacker cannot: claim and move in ONE transaction, so
 * there is no block in which the withdrawn MON sits on the EOA for our sweep to take. Against
 * this, our advantage is not the gap — it is the authorization window, which re-asserts our
 * delegation inside our own rescue transaction and undoes theirs.
 *
 * Deliberate constraints, so this cannot become a weapon:
 *
 *  - `SINK` is immutable and set at construction, exactly like `SAFE_ADDRESS` in MonRescue. No
 *    function takes a recipient. A deployed instance can only ever move funds to the address it
 *    was built for, which in our tests is our own throwaway testnet address.
 *  - It is only reachable by delegating an account to it, which requires that account's key.
 *    Deploying it grants nobody anything.
 *
 * It is a mirror of the rescue path with a different destination, which is precisely what makes
 * it a fair opponent.
 */
contract AdversaryDrainer {
    address internal constant STAKING_PRECOMPILE = 0x0000000000000000000000000000000000001000;

    /// @notice Where a successful drain sends the funds. Immutable, as in MonRescue.
    address public immutable SINK;

    uint256 internal constant WITHDRAW_GAS_CAP = 100_000;

    error NothingToTake();
    error TransferFailed();

    event Drained(address indexed sink, uint256 amount);

    constructor(address sink) {
        SINK = sink;
    }

    /**
     * @notice Claim matured withdrawals and move the proceeds out, atomically.
     *
     * @dev The reserve floor binds here exactly as it binds us: a delegated EOA may end a
     * transaction no lower than `min(balance at start, 10 MON)`. At epoch 1035 the adversary
     * script ignored that, tried to send its whole balance, and reverted — and we recorded the
     * funds staying put as a win we had not earned. Computing the floor is what makes this
     * opponent worth measuring against.
     */
    function drain(uint64[] calldata validatorIds, uint8[] calldata withdrawIds) external {
        uint256 startingBalance = address(this).balance;

        for (uint256 i = 0; i < validatorIds.length; i++) {
            // Return value ignored on purpose, and a real sweeper does the same: if the slot is
            // already empty the funds may still be sitting on the account, and the transfer
            // below is what actually matters.
            (bool ok,) = STAKING_PRECOMPILE.call{gas: WITHDRAW_GAS_CAP}(
                abi.encodeWithSignature(
                    "withdraw(uint64,uint8)", validatorIds[i], withdrawIds[i]
                )
            );
            ok;
        }

        uint256 floor = startingBalance < 10 ether ? startingBalance : 10 ether;
        uint256 balance = address(this).balance;
        uint256 amount = balance > floor ? balance - floor : 0;
        if (amount == 0) revert NothingToTake();

        (bool ok,) = SINK.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Drained(SINK, amount);
    }

    receive() external payable {}
}
