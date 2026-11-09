const { expect } = require("chai");
const { ethers } = require("hardhat");
describe("ExamIntegrity", () => {
  it("anchors and reads back a hash; only the owner can anchor", async () => {
    const [owner, other] = await ethers.getSigners();
    const c = await ethers.deployContract("ExamIntegrity");
    const h = "0x" + "ab".repeat(32);
    await expect(c.anchor(h)).to.emit(c, "HashAnchored");
    expect((await c.get(0))[0]).to.equal(h);
    expect(await c.count()).to.equal(1n);
    await expect(c.connect(other).anchor(h)).to.be.revertedWith("not owner");
    await expect(c.get(5)).to.be.revertedWith("out of range");
  });
});
