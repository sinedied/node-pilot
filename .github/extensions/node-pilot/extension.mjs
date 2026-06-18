// Dog-food wrapper.
//
// Opening this repository in the Copilot app discovers extensions under
// .github/extensions/. This thin wrapper simply loads the real Node Pilot
// entry point from the repository root so the extension runs against its own
// codebase without a separate install or a ~/.copilot/extensions symlink.
//
// When Node Pilot is installed into *another* project (via "Install extension
// from repo…" or by copying the files), the whole repo is placed under
// .github/extensions/node-pilot/ and its own root extension.mjs is used
// directly — this wrapper is only relevant inside this repository.
import "../../../extension.mjs";
