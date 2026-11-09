const hre = require("hardhat");
(async () => { const c = await hre.ethers.deployContract("ExamIntegrity"); await c.waitForDeployment(); console.log("ExamIntegrity deployed at", await c.getAddress()); })();
