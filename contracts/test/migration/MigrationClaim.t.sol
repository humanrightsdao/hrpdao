// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/utils/cryptography/Hashes.sol";
import "../../src/HumanityGate.sol";
import "../../src/MockHumanityProvider.sol";
import "../../src/InfluenceRegistry.sol";
import "../../src/ShieldSBT.sol";
import "../../src/CouncilSBT.sol";
import "../../src/migration/MigrationSnapshotLib.sol";
import "../../src/migration/MigrationClaim.sol";

/**
 * @title MigrationClaimTest
 * @notice Наскрізні тести для доданих MIGRATION_ROLE-хуків
 *         (ShieldSBT.migrationMint / CouncilSBT.migrationMint /
 *         InfluenceRegistry.migrationSetInfluence) і самого
 *         MigrationClaim.claim(). Симулює ЦІЛЬОВИЙ чейн: розгортає
 *         звичайний стек (без Treasury/TipJar/DaoGovernor — вони не
 *         торкаються міграційного флоу), будує тестовий Merkle-снепшот
 *         з 4 акаунтів (тим самим алгоритмом, що MigrationSnapshotLib.
 *         buildRoot(), включно з edge-case непарної кількості листків),
 *         і прогонає claim() для кожного профілю.
 *
 * Запуск: forge test --match-contract MigrationClaimTest -vvvv
 */
contract MigrationClaimTest is Test {
    HumanityGate         humanityGate;
    MockHumanityProvider mockProvider;
    InfluenceRegistry    influenceRegistry;
    ShieldSBT             shieldSBT;
    CouncilSBT           councilSBT;
    MigrationClaim        migrationClaim;

    address dao      = makeAddr("dao");
    address deployer = address(this);

    address alice = makeAddr("alice"); // Shield + Council, influence>0, активність>0
    address bob   = makeAddr("bob");   // лише Shield, influence>0
    address carol = makeAddr("carol"); // без SBT, лише imported influence
    address dave  = makeAddr("dave");  // Shield, БЕЗ influence-історії (edge case)

    // Знімкові дані (як були б експортовані ExportMigrationSnapshot.s.sol)
    uint256 constant ALICE_INFLUENCE      = 500e18;
    uint256 constant ALICE_LAST_ACTIVITY  = 1_700_000_000;
    uint256 constant ALICE_SHIELD_MINTED  = 1_650_000_000;
    uint256 constant ALICE_COUNCIL_MINTED = 1_680_000_000;

    uint256 constant BOB_INFLUENCE      = 250e18;
    uint256 constant BOB_LAST_ACTIVITY  = 1_695_000_000;
    uint256 constant BOB_SHIELD_MINTED  = 1_660_000_000;

    uint256 constant CAROL_INFLUENCE     = 300e18;
    uint256 constant CAROL_LAST_ACTIVITY = 1_690_000_000;

    // dave: influence=0, lastActivityTimestamp=0 — hasShield=true, нічого імпортувати в Influence
    uint256 constant DAVE_SHIELD_MINTED = 1_670_000_000;

    uint256 constant HUMANITY_SCORE_STUB = 10_000; // аудит-трейл, контрактом не використовується
    bytes32 constant POLICY_CONSENT_STUB = keccak256("source-chain-policy-v1");

    bytes32[] leaves; // leaves[0]=alice, [1]=bob, [2]=carol, [3]=dave

    uint256 constant CLAIM_DEADLINE_OFFSET = 30 days;

    function setUp() public {
        // Тестове середовище стартує з block.timestamp=1, а знімкові
        // константи нижче — реальні unix-timestamp'и (~1.65-1.7 млрд).
        // ShieldSBT.migrationMint/CouncilSBT.migrationMint/
        // InfluenceRegistry.migrationSetInfluence усі вимагають
        // originalMintedAt/originalLastActivityTimestamp <= block.timestamp
        // (не можна імпортувати "стаж із майбутнього"), тож симулюємо
        // реалістичний "поточний момент" ЦІЛЬОВОГО чейну — де-факто дату
        // самої міграції, вже після всіх дат снепшоту.
        vm.warp(1_800_000_000);

        humanityGate = new HumanityGate(dao);
        mockProvider = new MockHumanityProvider(10_000, dao); // 100.00%
        vm.prank(dao);
        humanityGate.addProvider(address(mockProvider));

        influenceRegistry = new InfluenceRegistry(dao, address(0));

        shieldSBT = new ShieldSBT(
            address(influenceRegistry),
            dao,
            address(humanityGate),
            2000,
            true, // testMode
            keccak256("target-chain-policy-v1"),
            "ipfs://target-policy"
        );
        vm.prank(dao);
        humanityGate.setAuthorizedCaller(address(shieldSBT), true);

        councilSBT = new CouncilSBT(
            address(influenceRegistry),
            address(shieldSBT),
            dao,
            address(humanityGate),
            5000
        );
        vm.prank(dao);
        humanityGate.setAuthorizedCaller(address(councilSBT), true);
        vm.prank(dao);
        influenceRegistry.setCouncilSBT(address(councilSBT));

        // ── Побудова тестового снепшоту (4 листки, непарна кількість
        //    навмисно — щоб проходило гілку "немає пари" в buildRoot()) ──
        leaves = new bytes32[](4);
        leaves[0] = MigrationSnapshotLib.leafHash(
            0, alice, ALICE_INFLUENCE, ALICE_LAST_ACTIVITY,
            true, ALICE_SHIELD_MINTED, true, ALICE_COUNCIL_MINTED,
            HUMANITY_SCORE_STUB, POLICY_CONSENT_STUB
        );
        leaves[1] = MigrationSnapshotLib.leafHash(
            1, bob, BOB_INFLUENCE, BOB_LAST_ACTIVITY,
            true, BOB_SHIELD_MINTED, false, 0,
            HUMANITY_SCORE_STUB, POLICY_CONSENT_STUB
        );
        leaves[2] = MigrationSnapshotLib.leafHash(
            2, carol, CAROL_INFLUENCE, CAROL_LAST_ACTIVITY,
            false, 0, false, 0,
            HUMANITY_SCORE_STUB, POLICY_CONSENT_STUB
        );
        leaves[3] = MigrationSnapshotLib.leafHash(
            3, dave, 0, 0,
            true, DAVE_SHIELD_MINTED, false, 0,
            HUMANITY_SCORE_STUB, POLICY_CONSENT_STUB
        );

        bytes32 root = MigrationSnapshotLib.buildRoot(leaves);

        migrationClaim = new MigrationClaim(
            root,
            makeAddr("sourceRegistryRef"), // лише аудит-референс
            999999,                        // фейковий sourceChainId
            block.timestamp + CLAIM_DEADLINE_OFFSET,
            address(shieldSBT),
            address(councilSBT),
            address(influenceRegistry),
            dao
        );

        // DAO вмикає MIGRATION_ROLE для MigrationClaim на всіх трьох контрактах
        vm.startPrank(dao);
        shieldSBT.setMigrationClaim(address(migrationClaim), true);
        councilSBT.setMigrationClaim(address(migrationClaim), true);
        influenceRegistry.setMigrationClaim(address(migrationClaim), true);
        vm.stopPrank();
    }

    // ── Helper: відтворює buildRoot() крок за кроком, повертаючи proof
    //    для конкретного leafIndex (той самий алгоритм commutativeKeccak256
    //    знизу вгору, включно з "немає пари — переносимо як є" для
    //    непарного хвоста рівня). ──
    function _buildProof(bytes32[] memory allLeaves, uint256 leafIndex) internal pure returns (bytes32[] memory) {
        bytes32[] memory proofBuf = new bytes32[](32); // з запасом, обріжемо в кінці
        uint256 proofLen = 0;

        bytes32[] memory level = allLeaves;
        uint256 idx = leafIndex;

        while (level.length > 1) {
            uint256 pairIdx = (idx % 2 == 0) ? idx + 1 : idx - 1;
            if (pairIdx < level.length) {
                proofBuf[proofLen] = level[pairIdx];
                proofLen++;
            }
            // інакше — idx непарний "хвіст" без пари, на цьому рівні
            // proof-елемент не додається (батько = level[idx] напряму)

            uint256 nextLen = (level.length + 1) / 2;
            bytes32[] memory next = new bytes32[](nextLen);
            for (uint256 i = 0; i < nextLen; i++) {
                uint256 left = i * 2;
                uint256 right = left + 1;
                if (right < level.length) {
                    next[i] = Hashes.commutativeKeccak256(level[left], level[right]);
                } else {
                    next[i] = level[left];
                }
            }
            level = next;
            idx = idx / 2;
        }

        bytes32[] memory proof = new bytes32[](proofLen);
        for (uint256 i = 0; i < proofLen; i++) proof[i] = proofBuf[i];
        return proof;
    }

    // ── Sanity: перевіряємо, що наш helper дійсно відтворює дерево
    //    MigrationSnapshotLib.buildRoot() коректно, ДО того, як довіряти
    //    йому в решті тестів. ──
    function test_proofHelper_matchesBuildRoot_forAllLeaves() public view {
        bytes32 root = MigrationSnapshotLib.buildRoot(leaves);
        for (uint256 i = 0; i < leaves.length; i++) {
            bytes32[] memory proof = _buildProof(leaves, i);
            assertTrue(
                MerkleProofLibCheck.verify(proof, root, leaves[i]),
                "proof helper does not match buildRoot for this leaf"
            );
        }
    }

    // ══════════════════════ HAPPY PATH ══════════════════════

    function test_claim_aliceWithShieldAndCouncilAndInfluence() public {
        bytes32[] memory proof = _buildProof(leaves, 0);

        vm.expectEmit(true, false, false, true, address(migrationClaim));
        emit MigrationClaim.Claimed(alice, ALICE_INFLUENCE, true, true, 0);

        vm.prank(alice);
        migrationClaim.claim(
            0, ALICE_INFLUENCE, ALICE_LAST_ACTIVITY,
            true, ALICE_SHIELD_MINTED, true, ALICE_COUNCIL_MINTED,
            HUMANITY_SCORE_STUB, POLICY_CONSENT_STUB, proof
        );

        assertTrue(migrationClaim.claimed(alice), "should be marked claimed");
        assertTrue(shieldSBT.isMember(alice), "shield should be minted");
        assertEq(shieldSBT.memberSince(alice), ALICE_SHIELD_MINTED, "shield stage must preserve original mint time");
        assertEq(councilSBT.accountToTokenId(alice), 1, "council should be minted (first council token)");
        assertEq(councilSBT.memberSince(alice), ALICE_COUNCIL_MINTED, "council stage must preserve original mint time");
        assertEq(influenceRegistry.influence(alice), ALICE_INFLUENCE, "influence must be imported as-is (pre-decay)");
        assertEq(influenceRegistry.lastActivityTimestamp(alice), ALICE_LAST_ACTIVITY, "activity timestamp must be preserved");
    }

    function test_claim_bobWithShieldOnlyNoCouncil() public {
        bytes32[] memory proof = _buildProof(leaves, 1);

        vm.prank(bob);
        migrationClaim.claim(
            1, BOB_INFLUENCE, BOB_LAST_ACTIVITY,
            true, BOB_SHIELD_MINTED, false, 0,
            HUMANITY_SCORE_STUB, POLICY_CONSENT_STUB, proof
        );

        assertTrue(shieldSBT.isMember(bob));
        assertEq(councilSBT.accountToTokenId(bob), 0, "bob must NOT have a council token");
        assertEq(influenceRegistry.influence(bob), BOB_INFLUENCE);
    }

    function test_claim_carolPureInfluenceImport_noSBTs() public {
        bytes32[] memory proof = _buildProof(leaves, 2);

        vm.prank(carol);
        migrationClaim.claim(
            2, CAROL_INFLUENCE, CAROL_LAST_ACTIVITY,
            false, 0, false, 0,
            HUMANITY_SCORE_STUB, POLICY_CONSENT_STUB, proof
        );

        assertFalse(shieldSBT.isMember(carol), "carol must not get a Shield SBT");
        assertEq(influenceRegistry.influence(carol), CAROL_INFLUENCE);
        assertEq(influenceRegistry.lastActivityTimestamp(carol), CAROL_LAST_ACTIVITY);
    }

    /// @notice Edge case: hasShield=true, влив influence=0/lastActivity=0 —
    ///         migrationSetInfluence НЕ викликається взагалі (умова
    ///         `influence>0 || lastActivityTimestamp>0` в claim() хибна),
    ///         тому lastActivityTimestamp(dave) лишається 0 на цільовому
    ///         чейні. Це документована поведінка (не баг): при influence=0
    ///         decay не має значення.
    function test_claim_daveShieldOnly_noInfluenceHistoryAtAll() public {
        bytes32[] memory proof = _buildProof(leaves, 3);

        vm.prank(dave);
        migrationClaim.claim(
            3, 0, 0,
            true, DAVE_SHIELD_MINTED, false, 0,
            HUMANITY_SCORE_STUB, POLICY_CONSENT_STUB, proof
        );

        assertTrue(shieldSBT.isMember(dave));
        assertEq(influenceRegistry.influence(dave), 0);
        assertEq(influenceRegistry.lastActivityTimestamp(dave), 0, "no import call happened, stays untouched");
    }

    // ══════════════════════ ЗАХИСТ ВІД ПОВТОРНОГО CLAIM ══════════════════════

    function test_claim_revertsOnDoubleClaim() public {
        bytes32[] memory proof = _buildProof(leaves, 0);
        vm.startPrank(alice);
        migrationClaim.claim(
            0, ALICE_INFLUENCE, ALICE_LAST_ACTIVITY,
            true, ALICE_SHIELD_MINTED, true, ALICE_COUNCIL_MINTED,
            HUMANITY_SCORE_STUB, POLICY_CONSENT_STUB, proof
        );

        vm.expectRevert("Migration: already claimed");
        migrationClaim.claim(
            0, ALICE_INFLUENCE, ALICE_LAST_ACTIVITY,
            true, ALICE_SHIELD_MINTED, true, ALICE_COUNCIL_MINTED,
            HUMANITY_SCORE_STUB, POLICY_CONSENT_STUB, proof
        );
        vm.stopPrank();
    }

    /// @notice Навіть якщо MigrationClaim.claimed[msg.sender] якимось чином
    ///         обійти неможливо (claimed стоїть до зовнішніх викликів —
    ///         CEI-патерн), самі базові контракти теж мають власний захист:
    ///         прямий повторний виклик migrationMint на вже заявленого
    ///         учасника revert-не незалежно від MigrationClaim.
    function test_shieldMigrationMint_revertsIfAlreadyMember() public {
        bytes32[] memory proof = _buildProof(leaves, 0);
        vm.prank(alice);
        migrationClaim.claim(
            0, ALICE_INFLUENCE, ALICE_LAST_ACTIVITY,
            true, ALICE_SHIELD_MINTED, true, ALICE_COUNCIL_MINTED,
            HUMANITY_SCORE_STUB, POLICY_CONSENT_STUB, proof
        );

        vm.prank(address(migrationClaim));
        vm.expectRevert("Shield: already member");
        shieldSBT.migrationMint(alice, ALICE_SHIELD_MINTED);
    }

    // ══════════════════════ ACCESS CONTROL ══════════════════════

    function test_shieldMigrationMint_revertsForNonMigrationRoleCaller() public {
        vm.prank(alice); // алісa НЕ має MIGRATION_ROLE
        vm.expectRevert();
        shieldSBT.migrationMint(alice, ALICE_SHIELD_MINTED);
    }

    function test_councilMigrationMint_revertsForNonMigrationRoleCaller() public {
        vm.prank(alice);
        vm.expectRevert();
        councilSBT.migrationMint(alice, ALICE_COUNCIL_MINTED);
    }

    function test_influenceMigrationSetInfluence_revertsForNonMigrationRoleCaller() public {
        vm.prank(alice);
        vm.expectRevert();
        influenceRegistry.migrationSetInfluence(alice, ALICE_INFLUENCE, ALICE_LAST_ACTIVITY);
    }

    function test_setMigrationClaim_revertsForNonDaoCaller() public {
        vm.prank(alice); // не DAO_ROLE
        vm.expectRevert();
        shieldSBT.setMigrationClaim(address(migrationClaim), true);
    }

    /// @notice Після revoke MIGRATION_ROLE (закриття вікна) — навіть з
    ///         валідним proof — виклик далі падає всередині ShieldSBT
    ///         (AccessControl), не всередині MigrationClaim. Симулює
    ///         "закриття вікна" одразу після claimDeadline, описане в
    ///         CROSS_CHAIN_MIGRATION_DESIGN.md.
    function test_claim_revertsAfterDaoRevokesMigrationRole() public {
        vm.prank(dao);
        shieldSBT.setMigrationClaim(address(migrationClaim), false);

        bytes32[] memory proof = _buildProof(leaves, 1);
        vm.prank(bob);
        vm.expectRevert(); // AccessControlUnauthorizedAccount з ShieldSBT
        migrationClaim.claim(
            1, BOB_INFLUENCE, BOB_LAST_ACTIVITY,
            true, BOB_SHIELD_MINTED, false, 0,
            HUMANITY_SCORE_STUB, POLICY_CONSENT_STUB, proof
        );
    }

    // ══════════════════════ MERKLE PROOF ══════════════════════

    function test_claim_revertsOnInvalidProof() public {
        bytes32[] memory badProof = _buildProof(leaves, 1); // proof бобового листка...
        vm.prank(alice); // ...для аліси
        vm.expectRevert("Migration: invalid proof");
        migrationClaim.claim(
            0, ALICE_INFLUENCE, ALICE_LAST_ACTIVITY,
            true, ALICE_SHIELD_MINTED, true, ALICE_COUNCIL_MINTED,
            HUMANITY_SCORE_STUB, POLICY_CONSENT_STUB, badProof
        );
    }

    function test_claim_revertsOnTamperedInfluenceValue() public {
        bytes32[] memory proof = _buildProof(leaves, 0);
        vm.prank(alice);
        vm.expectRevert("Migration: invalid proof");
        migrationClaim.claim(
            0, ALICE_INFLUENCE + 1, ALICE_LAST_ACTIVITY, // підмінене значення
            true, ALICE_SHIELD_MINTED, true, ALICE_COUNCIL_MINTED,
            HUMANITY_SCORE_STUB, POLICY_CONSENT_STUB, proof
        );
    }

    /// @notice Хтось інший НЕ може заявити чужий leaf під своєю адресою —
    ///         msg.sender зашитий у leafHash (через account), тож підміна
    ///         адреси ламає сам leaf, а не лише перевірку "хто дзвонить".
    function test_claim_revertsIfCalledByWrongAccount() public {
        bytes32[] memory proof = _buildProof(leaves, 0); // leaf для alice
        vm.prank(bob); // bob намагається заявити leaf аліси
        vm.expectRevert("Migration: invalid proof");
        migrationClaim.claim(
            0, ALICE_INFLUENCE, ALICE_LAST_ACTIVITY,
            true, ALICE_SHIELD_MINTED, true, ALICE_COUNCIL_MINTED,
            HUMANITY_SCORE_STUB, POLICY_CONSENT_STUB, proof
        );
    }

    // ══════════════════════ DEADLINE ══════════════════════

    function test_claim_revertsAfterDeadline() public {
        bytes32[] memory proof = _buildProof(leaves, 0);
        vm.warp(block.timestamp + CLAIM_DEADLINE_OFFSET + 1);

        vm.prank(alice);
        vm.expectRevert("Migration: window closed");
        migrationClaim.claim(
            0, ALICE_INFLUENCE, ALICE_LAST_ACTIVITY,
            true, ALICE_SHIELD_MINTED, true, ALICE_COUNCIL_MINTED,
            HUMANITY_SCORE_STUB, POLICY_CONSENT_STUB, proof
        );
    }

    function test_claim_succeedsExactlyAtDeadline() public {
        bytes32[] memory proof = _buildProof(leaves, 0);
        vm.warp(block.timestamp + CLAIM_DEADLINE_OFFSET); // == claimDeadline, не за ним

        vm.prank(alice);
        migrationClaim.claim(
            0, ALICE_INFLUENCE, ALICE_LAST_ACTIVITY,
            true, ALICE_SHIELD_MINTED, true, ALICE_COUNCIL_MINTED,
            HUMANITY_SCORE_STUB, POLICY_CONSENT_STUB, proof
        );
        assertTrue(migrationClaim.claimed(alice));
    }

    // ══════════════════════ COUNCIL БЕЗ SHIELD (safe failure) ══════════════════════

    /// @notice Якщо офчейн-скрипт помилково згенерував би листок з
    ///         hasCouncil=true, hasShield=false, on-chain виклик сам
    ///         revert-не всередині councilSBT.migrationMint
    ///         (require(shieldSBT.isMember(account))) — це safe failure,
    ///         не пошкодження стану. Тут симулюємо це НАПРЯМУ (без
    ///         MigrationClaim), бо через сам MigrationClaim такий листок
    ///         неможливо навіть побудувати без зламаного дерева.
    function test_councilMigrationMint_revertsIfShieldNotActiveYet() public {
        vm.prank(dao);
        councilSBT.setMigrationClaim(deployer, true); // деплоєру тесту, для прямого виклику

        vm.expectRevert("Council: Shield must be active");
        councilSBT.migrationMint(carol, 1_600_000_000); // carol немає Shield
    }

    // ══════════════════════ КОНСТРУКТОР MigrationClaim ══════════════════════

    function test_constructor_revertsOnZeroRoot() public {
        vm.expectRevert("Migration: zero root");
        new MigrationClaim(
            bytes32(0), address(0), 1, block.timestamp + 1 days,
            address(shieldSBT), address(councilSBT), address(influenceRegistry), dao
        );
    }

    function test_constructor_revertsOnPastDeadline() public {
        vm.warp(block.timestamp + 10); // трохи просунути час, щоб було що "минуле"
        vm.expectRevert("Migration: deadline in past");
        new MigrationClaim(
            keccak256("dummy"), address(0), 1, block.timestamp - 1,
            address(shieldSBT), address(councilSBT), address(influenceRegistry), dao
        );
    }
}

/// @dev Тонка обгортка над OZ MerkleProof.verify — лише щоб дозволити
///      `view`-виклик у тесті без прямого calldata-контексту.
library MerkleProofLibCheck {
    function verify(bytes32[] memory proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 computed = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            computed = Hashes.commutativeKeccak256(computed, proof[i]);
        }
        return computed == root;
    }
}
