// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// Minimal ERC-20-style storage used to exercise solc-js layout derivation (VERIFY-2).
/// Storage order fixes the slots: _balances @ 0, _allowances @ 1, _totalSupply @ 2, ...
contract TestToken {
    mapping(address => uint256) private _balances; // slot 0
    mapping(address => mapping(address => uint256)) private _allowances; // slot 1
    uint256 private _totalSupply; // slot 2
    string private _name; // slot 3
    string private _symbol; // slot 4

    // A packed struct: a,b,c,d,e all share slot 5 at offsets 0,8,16,24,28 (8+8+8+4+1 = 29 bytes).
    struct Packed {
        uint64 a;
        uint64 b;
        uint64 c;
        uint32 d;
        bool e;
    }
    Packed public packed; // slot 5

    function balanceOf(address a) external view returns (uint256) {
        return _balances[a];
    }
}
