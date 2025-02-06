// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC721ReceiverUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/IERC721ReceiverUpgradeable.sol";
import {IERC721A} from "erc721a/contracts/IERC721A.sol";

import {Uint13Array19} from "./Uint13Array19.sol";
import {Uint13List} from "./Uint13List.sol";

using Uint13List for Uint13List.Storage;

contract BeramoniumGemhuntersListeners is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    IERC721ReceiverUpgradeable
{
    // NOTE: This is an upgradeable contract, so don't reorganize the storage
    // nor change the types of the variables. Only append new variables at the end.
    IERC721A public _beramonium;

    Uint13List.Storage _flexStakedList;

    struct Listener {
        /** The address of the listener contract */
        address addr;
        /** Has to accept (address staker, uint16 tokenId) */
        bytes4 onStakedSelector;
        /** Has to accept (address staker, uint16 tokenId) */
        bytes4 onUnstakedSelector;
        /** Whether the call should fail if it reverts */
        bool allowFail;
    }

    Listener[] private listeners;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(IERC721A beramonium) public initializer {
        _beramonium = beramonium;
        __AccessControl_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    /**
     * @notice Returns the number of staked beras for the given owner.
     */
    function stakedBeraCount(address owner) public view returns (uint16) {
        return _flexStakedList.getAt(owner, 0);
    }

    /**
     * @notice Returns the list of staked Bera IDs for the given owner.
     */
    function stakedBeras(address owner) public view returns (uint16[] memory ret) {
        ret = new uint16[](stakedBeraCount(owner));
        for (uint16 i = 0; i < ret.length; i++) {
            // We prefix the array with length (taking 1 slot), so we need to add 1
            ret[i] = _flexStakedList.getAt(owner, i + 1);
        }
    }

    /**
     * @notice Stakes the given Bera IDs for the sender.
     */
    function stake(uint16[] calldata tokenIds) public {
        if (tokenIds.length == 0) return;
        if (tokenIds.length > 6000) revert IndexOutOfBounds();

        // Make sure that the caller owns the beras before trying to transfer them
        unchecked {
            for (uint i = 0; i < tokenIds.length; i++) {
                if (_beramonium.ownerOf(tokenIds[i]) != msg.sender) revert NotOwner();
            }
        }

        unchecked {
            uint16 stakeCount = stakedBeraCount(msg.sender);
            // Increment the stake count
            // SAFETY: At most 6000 + 6000, so < type(uint16).max
            _flexStakedList.setAt(msg.sender, 0, stakeCount + uint16(tokenIds.length));

            uint16 tokenId;
            for (uint16 i = 0; i < tokenIds.length; i++) {
                tokenId = tokenIds[i];
                // We prefix the array with length (taking 1 slot), so we need to add 1;
                _flexStakedList.setAt(msg.sender, i + stakeCount + 1, tokenId);

                _beramonium.safeTransferFrom(msg.sender, address(this), tokenId);
                emit Staked(msg.sender, tokenId);
                notifyStaked(msg.sender, tokenId);
            }
        }
    }

    /**
     * @notice Unstake the given beras for the sender.
     * @param indices List indices of the beras to unstake. The indices must be in descending order.
     */
    function unstakeByIndices(uint16[] calldata indices) public {
        if (indices.length == 0) return;

        uint16 stakeCount = stakedBeraCount(msg.sender);
        if (indices.length > stakeCount) revert IndexOutOfBounds();

        unchecked {
            uint i;
            // Verify that the indices are in a strictly descending order and
            // not out of bounds. The order is important, since we're swap-removing
            // while iterating over the collection.
            if (indices[0] >= stakeCount) revert IndexOutOfBounds();
            for (i = 1; i < indices.length; i++) {
                if (indices[i] >= stakeCount) revert IndexOutOfBounds();
                if (indices[i - 1] <= indices[i]) revert IndicesUnordered();
            }

            // Perform swap-remove for each index and delete the storage slots if needed
            for (i = 0; i < indices.length; i++) {
                // We prefix the array with length (taking 1 slot), so we need to add 1.
                uint16 removedId = _flexStakedList.getAt(msg.sender, indices[i] + 1);
                uint16 last = _flexStakedList.getAt(msg.sender, stakeCount);
                // Swap-remove with the last element
                _flexStakedList.setAt(msg.sender, indices[i] + 1, last);

                // Delete the unused pages
                if (stakeCount % Uint13Array19.elements == 0) {
                    uint16 pageIndex = stakeCount / Uint13Array19.elements;
                    _flexStakedList.list[msg.sender][pageIndex] = Uint13Array19
                        .u13a19
                        .wrap(0);
                }

                stakeCount--;

                _beramonium.safeTransferFrom(address(this), msg.sender, removedId);
                emit Unstaked(msg.sender, removedId);
                notifyUnstaked(msg.sender, removedId);
            }

            // Commit the final stake count
            _flexStakedList.setAt(msg.sender, 0, stakeCount);
        }
    }

    /** Adds a listener contract to the list of (un)staking listeners */
    function pushListener(
        Listener calldata listener
    ) public onlyRole(DEFAULT_ADMIN_ROLE) {
        listeners.push(listener);
    }

    /** Removes a listener contract from the list of (un)staking listeners */
    function popListener(Listener calldata listener) public onlyRole(DEFAULT_ADMIN_ROLE) {
        unchecked {
            for (uint i = 0; i < listeners.length; i++) {
                if (listeners[i].addr == listener.addr) {
                    listeners[i] = listeners[listeners.length - 1];
                    listeners.pop();
                    break;
                }
            }
        }
    }

    /** Notifies other contracts about staked/unstaked tokens */
    function notifyStaked(address staker, uint16 tokenId) internal {
        for (uint i = 0; i < listeners.length; i++) {
            Listener memory listener = listeners[i];
            (bool success, ) = listener.addr.call(
                abi.encodeWithSelector(listener.onStakedSelector, staker, tokenId)
            );

            if (!success && !listener.allowFail) {
                revert("Staking listener call failed");
            }
        }
    }

    /** Notifies other contracts about staked/unstaked tokens */
    function notifyUnstaked(address staker, uint16 tokenId) internal {
        for (uint i = 0; i < listeners.length; i++) {
            Listener memory listener = listeners[i];
            (bool success, ) = listener.addr.call(
                abi.encodeWithSelector(listener.onUnstakedSelector, staker, tokenId)
            );

            if (!success && !listener.allowFail) {
                revert("Unstaking listener call failed");
            }
        }
    }

    event Staked(address owner, uint16 tokenId);
    event Unstaked(address owner, uint16 tokenId);

    error IndicesUnordered();
    error IndexOutOfBounds();
    error NotOwner();

    // IERC721ReceiverUpgradeable
    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure override returns (bytes4) {
        return IERC721ReceiverUpgradeable.onERC721Received.selector;
    }
}
