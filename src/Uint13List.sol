// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import {Uint13Array19} from "./Uint13Array19.sol";

/**
 * @notice A dynamic list of `uint13`s for each address.
 */
library Uint13List {
    using Uint13Array19 for uint256;

    struct Storage {
        mapping(address => mapping(uint16 => Uint13Array19.u13a19)) list;
    }

    /** @dev Effectively a `divmod` for {Uint13Array19.elements}. */
    function toPagedIndex(
        uint16 listIndex
    ) internal pure returns (uint16 pageIndex, uint16 indexInPage) {
        unchecked {
            pageIndex = listIndex / Uint13Array19.elements;
            indexInPage = listIndex % Uint13Array19.elements;
        }
    }

    /** @notice Sets the value at the given list index for the given address. */
    function setAt(
        Storage storage self,
        address owner,
        uint16 listIndex,
        uint16 value
    ) internal {
        (uint16 pageIndex, uint16 indexInPage) = toPagedIndex(listIndex);

        self.list[owner][pageIndex] = Uint13Array19.set(
            self.list[owner][pageIndex],
            indexInPage,
            value
        );
    }

    /** @notice Gets the value at the given list index for the given address. */
    function getAt(
        Storage storage self,
        address owner,
        uint16 listIndex
    ) internal view returns (uint16) {
        uint16 pageIndex = listIndex / Uint13Array19.elements;
        uint16 indexInPage = listIndex % Uint13Array19.elements;

        return uint16(Uint13Array19.get(self.list[owner][pageIndex], indexInPage));
    }
}
