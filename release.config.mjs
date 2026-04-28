import process from "node:process"

export default {
  branches: [process.env.DEFAULT_BRANCH || "master", { name: "beta", prerelease: true }],
  tagFormat: "${version}",
}
