const ParticipantRegistry = artifacts.require("ParticipantRegistry");
const ContactRecordManager = artifacts.require("ContactRecordManager");

module.exports = async function (deployer) {
  await deployer.deploy(ParticipantRegistry);
  const registry = await ParticipantRegistry.deployed();
  await deployer.deploy(ContactRecordManager, registry.address);
};
