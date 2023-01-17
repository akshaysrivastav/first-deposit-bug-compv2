// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.0;

import "./ERC20.sol";

contract Token is ERC20 {
    constructor(uint8 _decimals) ERC20("Valuable Token", "VTT", _decimals) {}

    function mint(address to, uint amount) public {
        _mint(to, amount);
    }
}
