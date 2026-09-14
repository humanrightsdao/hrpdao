// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/Hashes.sol";

/**
 * @title SeatMerkleLib
 * @notice Спільна формула листка й побудова Merkle-дерева для seat-
 *         присвоєнь Council. Винесена в ОКРЕМУ бібліотеку, щоб
 *         CouncilRankingEpoch і OptimisticEpochSubmission ГАРАНТОВАНО
 *         використовували ІДЕНТИЧНУ формулу — інакше корінь, побудований
 *         в одному контракті, не пройшов би перевірку в іншому через
 *         банальну розбіжність копій коду.
 */
library SeatMerkleLib {
    /// @notice Листок дерева: index робить кожен запис унікальним навіть
    ///         при випадково однакових інших полях і дозволяє довести
    ///         дублікат акаунта (однаковий account у двох різних листках
    ///         з різним index).
    function leafHash(uint256 index, address account, bool hasSeat, int8 level, uint64 branchId)
        internal pure returns (bytes32)
    {
        return keccak256(abi.encode(index, account, hasSeat, level, branchId));
    }

    /// @notice Проста побудова бінарного Merkle-дерева знизу вгору,
    ///         "commutativeKeccak256" (сортована пара) — та сама угода,
    ///         що й у OpenZeppelin MerkleProof.verify. Непарний "хвіст"
    ///         рівня переноситься на наступний рівень без пари.
    function buildRoot(bytes32[] memory leaves) internal pure returns (bytes32) {
        uint256 n = leaves.length;
        require(n > 0, "SeatMerkleLib: empty leaf set");
        if (n == 1) return leaves[0];

        bytes32[] memory level = leaves;
        while (level.length > 1) {
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
        }
        return level[0];
    }
}
